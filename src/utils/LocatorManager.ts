import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as lockfile from 'proper-lockfile';
import { logger } from './Logger.js';
import { createLocatorAdapter, type LocatorAdapter } from './LocatorAdapter.js';
import { config } from '../config/index.js';
import { MAX_PROVENANCE_ENTRIES, type HealProvenance, type MetricsStore, type SelectorMetrics } from '../types.js';

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
     * Record a post-healing failure for a previously healed selector.
     *
     * Only fires if the selector has a prior `healedAt` timestamp — i.e. it
     * was successfully healed at least once. This prevents inflating counts
     * for original (never-healed) selectors that happen to fail.
     *
     * @param key - Dot-path locator key (e.g. `'booksToScrape.bookTitle'`)
     */
    public async recordSelectorFailure(key: string): Promise<void> {
        // The guard is evaluated under the file lock (after re-reading metrics) so that
        // parallel Playwright workers see the latest healedAt value written by other workers.
        const didUpdate = await this.atomicMetricUpdate(key, existing => {
            if (!existing.healedAt) return null; // not yet healed — skip (signals no write)
            return {
                ...existing,
                failureCount: existing.failureCount + 1,
                lastFailedAt: new Date().toISOString(),
            };
        });
        if (!didUpdate) return;

        const failureCount = this.metrics[key]?.failureCount ?? 0;
        logger.warn(`[LocatorManager] ⚠️ Healed selector '${key}' failed again (total failures: ${failureCount})`);

        // Act on the counter instead of only accumulating it.
        //
        // `failureCount` is incremented only for keys that were previously healed
        // (see the `healedAt` guard above), so it is already a targeted measure of
        // "the replacement we accepted does not work". Repeated failures are the
        // clearest evidence available that a heal was wrong, and until now nothing
        // consumed that evidence — the metric was collected and never read.
        const threshold = config.ai.healing.autoRevertAfter;
        if (threshold > 0 && failureCount >= threshold) {
            logger.warn(
                `[LocatorManager] ↩️ '${key}' has failed ${failureCount} times since it was healed ` +
                    `(HEALING_AUTO_REVERT_AFTER=${threshold}). Reverting to the last known-good selector.`
            );
            await this.revertLocator(key);
        }
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
     *   later be reviewed or reverted — `revertLocator` has nothing to restore.
     */
    public async recordSelectorHealed(key: string, provenance?: HealProvenance): Promise<void> {
        await this.atomicMetricUpdate(key, existing => {
            const history = provenance
                ? [...(existing.history ?? []), provenance].slice(-MAX_PROVENANCE_ENTRIES)
                : existing.history;
            return {
                ...existing,
                failureCount: 0, // reset: count failures per heal cycle, not lifetime
                healedAt: new Date().toISOString(),
                ...(history ? { history } : {}),
            };
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
     * what the selector used to be.
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
        await this.atomicMetricUpdate(key, existing => ({
            ...existing,
            failureCount: 0,
            history: (existing.history ?? []).slice(0, -1),
        }));

        logger.warn(
            `[LocatorManager] ↩️ Reverted '${key}' to '${last.previousSelector}' ` +
                `(undoing the ${last.provider}/${last.model} heal to '${last.healedSelector}' ` +
                `from ${last.healedAt}).`
        );
        return last.previousSelector;
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
