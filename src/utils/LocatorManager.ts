import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as lockfile from 'proper-lockfile';
import { logger } from './Logger.js';
import { createLocatorAdapter, type LocatorAdapter } from './LocatorAdapter.js';
import { config } from '../config/index.js';
import {
    MAX_PROVENANCE_ENTRIES,
    type HealProvenance,
    type MetricsStore,
    type SelectorFailureOutcome,
    type SelectorMetrics,
} from '../types.js';
import type { ElementFingerprint } from '../ai/ElementFingerprint.js';

// Get current directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * LocatorManager - Manages persistent storage of element selectors
 *
 * Acts as a facade over a pluggable `LocatorAdapter`. The active backend is
 * chosen at startup via the `LOCATOR_STORE` environment variable:
 *
 *   LOCATOR_STORE=file    → FileAdapter   (JSON + lockfile, default)
 *   LOCATOR_STORE=sqlite  → SQLiteAdapter (ACID SQLite, no lockfile)
 *
 * @example
 * ```typescript
 * const manager = LocatorManager.getInstance();
 * const selector = manager.getLocator('home.searchButton');
 * await manager.updateLocator('home.searchButton', '#new-search-btn');
 * ```
 */
export class LocatorManager {
    private static instance: LocatorManager | undefined;
    private readonly adapter: LocatorAdapter;
    private readonly metricsPath: string;
    private metrics: MetricsStore = {};
    /**
     * Rollback staged by the metrics mutation, applied to the locator store once the
     * metrics lock is released. Kept off the mutation path so the locator write never
     * happens while the metrics lockfile is held.
     */
    private pendingRevert: { key: string; selector: string } | undefined;

    private constructor() {
        this.adapter = createLocatorAdapter(config.locatorStore);
        this.metricsPath = path.resolve(__dirname, '../config/metrics.json');
        this.loadMetrics();
    }

    /**
     * Get the singleton instance of LocatorManager.
     *
     * The instance is created once and reused; the backing adapter is
     * determined by `config.locatorStore` at construction time.
     */
    public static getInstance(): LocatorManager {
        if (!LocatorManager.instance) {
            LocatorManager.instance = new LocatorManager();
        }
        return LocatorManager.instance;
    }

    /**
     * Reset the singleton instance.
     *
     * **For testing only** — allows unit tests to obtain a fresh instance with
     * a clean locator store between test cases without leaking state.
     *
     * @example
     * ```typescript
     * beforeEach(() => { LocatorManager.resetInstance(); });
     * ```
     */
    public static resetInstance(): void {
        LocatorManager.instance = undefined;
    }

    /**
     * Get a locator by its dot-path key (e.g. `'home.searchButton'`).
     *
     * @param key - Dot-separated path to the locator
     * @returns The CSS selector string, or `null` when not found
     */
    public getLocator(key: string): string | null {
        try {
            return this.adapter.getLocator(key);
        } catch (error) {
            logger.error(`[LocatorManager] ❌ Error retrieving locator for key '${key}': ${String(error)}`);
            return null;
        }
    }

    /**
     * Persist a new or updated selector for the given key.
     *
     * Delegates to the active adapter which handles locking/transactions
     * appropriate for its backend.
     *
     * @param key - Dot-separated path to the locator
     * @param newSelector - New CSS selector value
     */
    public async updateLocator(key: string, newSelector: string): Promise<void> {
        try {
            await this.adapter.updateLocator(key, newSelector);
            logger.info(`[LocatorManager] 💾 Updated locator '${key}' to '${newSelector}'`);
        } catch (error) {
            logger.error(`[LocatorManager] ❌ Failed to update locator '${key}': ${String(error)}`);
            throw error;
        }
    }

    /**
     * Return all stored key→selector pairs as a flat object.
     *
     * Useful for exporting/migrating between adapters.
     */
    public getAllLocators(): Record<string, string> {
        return this.adapter.getAllLocators();
    }

    // ── Selector Stability Metrics ────────────────────────────────────────────

    private loadMetrics(): void {
        try {
            if (fs.existsSync(this.metricsPath)) {
                const raw = fs.readFileSync(this.metricsPath, 'utf-8');
                this.metrics = JSON.parse(raw) as MetricsStore;
            }
        } catch (error) {
            logger.warn(`[LocatorManager] ⚠️ Could not load metrics file: ${String(error)}`);
            this.metrics = {};
        }
    }

    /**
     * Acquire a file lock, re-read metrics from disk (to absorb concurrent
     * worker writes), apply `mutate` to the entry for `key`, and flush.
     *
     * Using the same `proper-lockfile` strategy as `FileAdapter` ensures
     * parallel Playwright workers cannot clobber each other's metric counts.
     */
    /**
     * Returns `null` from `mutate` to signal that the update should be skipped
     * (no file write occurs). This avoids a separate pre-lock guard check that
     * would read stale in-memory state under parallel workers.
     */
    private async atomicMetricUpdate(
        key: string,
        mutate: (existing: SelectorMetrics) => SelectorMetrics | null
    ): Promise<boolean> {
        let release: (() => Promise<void>) | undefined;
        try {
            release = await lockfile.lock(this.metricsPath, {
                retries: { retries: 3, factor: 2, minTimeout: 100, maxTimeout: 500 },
            });
            // Re-read under lock so we don't clobber a concurrent worker's write
            this.loadMetrics();
            const existing = this.metrics[key] ?? { failureCount: 0 };
            const updated = mutate(existing);
            if (updated === null) return false; // caller signalled skip
            this.metrics[key] = updated;
            fs.writeFileSync(this.metricsPath, JSON.stringify(this.metrics, null, 2), 'utf-8');
            return true;
        } catch (error) {
            logger.error(`[LocatorManager] ❌ Failed to update metrics for '${key}': ${String(error)}`);
            return false;
        } finally {
            if (release) await release();
        }
    }

    /**
     * Record a post-healing failure, rolling the selector back once a healed
     * value has failed `config.ai.healing.quarantineThreshold` times in a row.
     *
     * Only fires if the selector has a prior `healedAt` timestamp — i.e. it
     * was successfully healed at least once. This prevents inflating counts
     * for original (never-healed) selectors that happen to fail.
     *
     * **Why the rollback exists.** A healed selector is accepted when it parses,
     * validates, and resolves to exactly one element — none of which establishes
     * that it resolves to the *intended* element. A confidently wrong heal was
     * previously persisted to the locator store permanently and reused by every
     * later run; `failureCount` counted the consequences without ever acting on
     * them. Crossing the threshold now restores the selector the heal replaced and
     * records the rejected value, so a bad repair decays instead of compounding.
     *
     * After a rollback, `healedAt` is cleared: the heal is no longer in effect, so
     * failures of the restored selector must not accrue toward another quarantine.
     * The key stays fully healable — the next failure triggers a fresh heal — which
     * is deliberate. Permanently disabling healing for a key would trade a wrong
     * selector for a dead one.
     *
     * @param key - Dot-path locator key (e.g. `'booksToScrape.bookTitle'`)
     * @returns What was done, so callers can report a rollback rather than let it pass silently.
     */
    public async recordSelectorFailure(key: string): Promise<SelectorFailureOutcome> {
        const threshold = config.ai.healing.quarantineThreshold;
        const outcome: SelectorFailureOutcome = { recorded: false, failureCount: 0, quarantined: false };

        // Everything below runs under the metrics file lock, after re-reading from
        // disk, so parallel Playwright workers agree on the failure count that
        // triggers a rollback rather than each counting in isolation.
        const didUpdate = await this.atomicMetricUpdate(key, existing => {
            if (!existing.healedAt) return null; // not yet healed — skip (signals no write)

            const failureCount = existing.failureCount + 1;
            const now = new Date().toISOString();
            outcome.failureCount = failureCount;

            // A key with no recorded `previousSelector` (healed before this field
            // existed, or healed without one supplied) has no rollback target, so it
            // keeps accumulating failures rather than reverting to nothing.
            const revertTarget = existing.previousSelector;
            if (failureCount < threshold || revertTarget === undefined) {
                return { ...existing, failureCount, lastFailedAt: now };
            }

            // Read the healed value being rejected before overwriting it.
            const rejected = this.adapter.getLocator(key);
            this.pendingRevert = { key, selector: revertTarget };

            outcome.quarantined = true;
            outcome.revertedTo = revertTarget;
            if (rejected !== null) outcome.quarantinedSelector = rejected;

            const next: SelectorMetrics = {
                failureCount: 0, // the rolled-back selector starts a fresh cycle
                lastFailedAt: now,
                quarantinedAt: now,
                quarantineCount: (existing.quarantineCount ?? 0) + 1,
                // healedAt and previousSelector are intentionally dropped: no heal is
                // in effect any more, and the revert target has been consumed.
            };
            if (rejected !== null) next.quarantinedSelector = rejected;
            return next;
        });

        outcome.recorded = didUpdate;
        if (!didUpdate) return outcome;

        // Perform the locator-store write outside the metrics mutation so a failure
        // here cannot leave the lock held. Ordering is deliberate: metrics record the
        // quarantine first, so a crash between the two leaves a key marked
        // quarantined with the healed selector still in place — visible and
        // re-correctable — rather than a silently reverted selector with no record.
        if (this.pendingRevert) {
            const { selector } = this.pendingRevert;
            this.pendingRevert = undefined;
            try {
                await this.adapter.updateLocator(key, selector);
                logger.warn(
                    `[LocatorManager] 🔙 Quarantined healed selector for '${key}' after ${threshold} ` +
                        `consecutive failures. Rolled back to '${selector}' ` +
                        `(rejected: '${outcome.quarantinedSelector ?? 'unknown'}').`
                );
            } catch (error) {
                logger.error(`[LocatorManager] ❌ Failed to roll back '${key}' to '${selector}': ${String(error)}`);
                outcome.quarantined = false;
                delete outcome.revertedTo;
            }
        } else {
            logger.warn(
                `[LocatorManager] ⚠️ Healed selector '${key}' failed again ` +
                    `(${outcome.failureCount}/${threshold} before rollback)`
            );
        }

        return outcome;
    }

    /**
     * Record a successful heal for a locator key.
     *
     * Resets `failureCount` to 0 so the counter tracks failures since the
     * most recent heal, not lifetime failures.
     *
     * @param key - Dot-path locator key (e.g. `'booksToScrape.bookTitle'`)
     * @param provenance - What was replaced and on whose authority. Optional so
     *   existing callers keep working, but omitting it means the heal cannot
     *   later be reviewed, automatically rolled back by {@link recordSelectorFailure},
     *   or manually undone by {@link revertLocator} — nothing records the value
     *   it replaced.
     */
    public async recordSelectorHealed(key: string, provenance?: HealProvenance): Promise<void> {
        await this.atomicMetricUpdate(key, existing => {
            const history = provenance
                ? [...(existing.history ?? []), provenance].slice(-MAX_PROVENANCE_ENTRIES)
                : existing.history;
            const next: SelectorMetrics = {
                ...existing,
                failureCount: 0, // reset: count failures per heal cycle, not lifetime
                healedAt: new Date().toISOString(),
                ...(history ? { history } : {}),
            };
            if (provenance !== undefined) {
                // The single-slot rollback target `recordSelectorFailure` consumes on
                // automatic quarantine; `history` below is the fuller, independent
                // audit trail `revertLocator` walks back through manually.
                next.previousSelector = provenance.previousSelector;
            }
            return next;
        });
    }

    /**
     * Return the recorded heal history for a key, oldest first.
     *
     * @param key - Dot-path locator key.
     * @returns The heals applied to this key, or an empty array when none were recorded.
     */
    public getProvenance(key: string): HealProvenance[] {
        return this.metrics[key]?.history ?? [];
    }

    /**
     * Undo the most recent heal, restoring the selector it replaced.
     *
     * This is the counterpart the store never had. A heal overwrites a
     * human-authored selector in place; without a way back, a wrong heal is
     * permanent and the original intent is lost — the reviewer cannot even see
     * what the selector used to be. Manual and independent of the automatic
     * quarantine rollback in {@link recordSelectorFailure}: that one fires on
     * `SELECTOR_QUARANTINE_THRESHOLD` consecutive failures and only ever
     * restores the single most recent heal; this one can be called on demand
     * and walks back through successive heals one at a time.
     *
     * The reverted entry is popped from the history, so repeated calls walk back
     * through successive heals rather than restoring the same value forever.
     *
     * @param key - Dot-path locator key.
     * @returns The restored selector, or `null` when there is nothing to revert.
     */
    public async revertLocator(key: string): Promise<string | null> {
        const history = this.metrics[key]?.history ?? [];
        const last = history[history.length - 1];
        if (!last) {
            logger.warn(`[LocatorManager] ↩️ Cannot revert '${key}' — no heal history recorded.`);
            return null;
        }

        await this.updateLocator(key, last.previousSelector);
        await this.atomicMetricUpdate(key, existing => {
            const next: SelectorMetrics = {
                failureCount: 0,
                history: (existing.history ?? []).slice(0, -1),
                // healedAt and previousSelector are intentionally omitted, mirroring
                // the automatic quarantine rollback: no heal is in effect any more,
                // so failures of the restored selector must not be attributed to it.
            };
            if (existing.lastFailedAt !== undefined) next.lastFailedAt = existing.lastFailedAt;
            if (existing.quarantinedSelector !== undefined) next.quarantinedSelector = existing.quarantinedSelector;
            if (existing.quarantinedAt !== undefined) next.quarantinedAt = existing.quarantinedAt;
            if (existing.quarantineCount !== undefined) next.quarantineCount = existing.quarantineCount;
            return next;
        });

        logger.warn(
            `[LocatorManager] ↩️ Reverted '${key}' to '${last.previousSelector}' ` +
                `(undoing the ${last.provider}/${last.model} heal to '${last.healedSelector}' ` +
                `from ${last.healedAt}).`
        );
        return last.previousSelector;
    }

    /**
     * Store the last-known-good element snapshot for a key.
     *
     * Overwrites any previous fingerprint: only the most recent successful
     * observation is useful, since an older one may describe a page state that
     * no longer exists.
     *
     * @param key - Dot-path locator key.
     * @param fingerprint - Snapshot captured on a successful interaction.
     */
    public async recordFingerprint(key: string, fingerprint: ElementFingerprint): Promise<void> {
        await this.atomicMetricUpdate(key, existing => ({ ...existing, fingerprint }));
    }

    /**
     * Return the last-known-good element snapshot for a key.
     *
     * @param key - Dot-path locator key.
     * @returns The stored fingerprint, or `null` when the key has never been
     *   observed working.
     */
    public getFingerprint(key: string): ElementFingerprint | null {
        return this.metrics[key]?.fingerprint ?? null;
    }

    /**
     * Return stability metrics for a specific key or all keys.
     *
     * @param key - Dot-path locator key. When provided, returns the single
     *   entry (defaulting to `{ failureCount: 0 }` if unseen). When omitted,
     *   returns a shallow copy of the full metrics store.
     */
    public getMetrics(key: string): SelectorMetrics;
    public getMetrics(): MetricsStore;
    public getMetrics(key?: string): SelectorMetrics | MetricsStore {
        if (key !== undefined) {
            return this.metrics[key] ?? { failureCount: 0 };
        }
        return { ...this.metrics };
    }
}
