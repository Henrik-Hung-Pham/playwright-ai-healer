/**
 * LocatorAdapter — storage-backend abstraction for the locator store.
 *
 * Implement this interface to plug in any storage backend (file, SQLite,
 * PostgreSQL, Redis, Supabase …). The active adapter is selected at startup
 * via the `LOCATOR_STORE` environment variable:
 *
 *   LOCATOR_STORE=file    → FileAdapter   (default — locators.json + lockfile)
 *   LOCATOR_STORE=sqlite  → SQLiteAdapter (locators.db — ACID, no lockfile needed)
 */
export interface LocatorAdapter {
    /**
     * Look up a selector by its flat dot-path key.
     * @returns The CSS selector string, or `null` when the key is not found.
     */
    getLocator(key: string): string | null;

    /**
     * Persist a new or updated selector for the given key.
     */
    updateLocator(key: string, selector: string): Promise<void>;

    /**
     * Return all stored key→selector pairs as a flat object.
     * Used for bulk exports and migration between adapters.
     */
    getAllLocators(): Record<string, string>;
}

// ── FileAdapter ───────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as lockfile from 'proper-lockfile';
import { logger } from './Logger.js';
import type { LocatorStore } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * FileAdapter — the original JSON-based storage backend.
 *
 * Reads/writes `src/config/locators.json` with `proper-lockfile` for
 * safe concurrent access. This is the default when `LOCATOR_STORE` is
 * unset or set to `"file"`.
 */
export class FileAdapter implements LocatorAdapter {
    private readonly locatorsPath: string;
    private locators: LocatorStore = {};

    /**
     * Identity of the file contents currently held in {@link locators}, used to
     * detect writes made by other processes. `null` means "nothing cached yet".
     *
     * @see refreshIfStale
     */
    private cachedStamp: string | null = null;

    constructor(locatorsPath?: string) {
        this.locatorsPath = locatorsPath ?? path.resolve(__dirname, '../config/locators.json');
        this.load();
    }

    /**
     * Cheap content-identity stamp for the store file: modification time plus
     * size. Returns `null` when the file does not exist or cannot be stat'ed.
     *
     * Size is folded in because `mtime` resolution is filesystem-dependent (1s
     * on some older filesystems), so two writes inside the same tick could share
     * an mtime. A selector edit almost always changes the serialized length, so
     * the pair is a far tighter signal than mtime alone. This is a cache-freshness
     * heuristic, not a correctness barrier — `updateLocator` still re-reads
     * unconditionally under the file lock, which is what actually guarantees no
     * write is lost.
     */
    private currentStamp(): string | null {
        try {
            const stat = fs.statSync(this.locatorsPath);
            return `${stat.mtimeMs}:${stat.size}`;
        } catch {
            return null;
        }
    }

    /**
     * Reload the store from disk if another process has written to it.
     *
     * Playwright runs workers as **separate OS processes**, each holding its own
     * `FileAdapter` with its own in-memory copy. That copy was previously
     * populated once in the constructor and refreshed only inside
     * `updateLocator`, so a heal performed by worker A was invisible to workers
     * B…N for the remainder of the run: they kept resolving the stale, known-broken
     * selector and paid for a fresh AI heal of the key that had already been
     * repaired — N times over, once per worker.
     *
     * A `stat` on every read is the cost of fixing that. It is a single syscall
     * (microseconds) against a Playwright action measured in milliseconds, and it
     * only re-parses the JSON when the stamp actually changes.
     */
    private refreshIfStale(): void {
        const stamp = this.currentStamp();
        // Reload only when the stamp is both readable and different.
        //
        // An unreadable stamp (file absent or inaccessible) is deliberately NOT
        // treated as "stale". There is nothing newer on disk to read, so a
        // reload could only discard the in-memory copy — including a selector
        // this process just wrote through `updateLocator`.
        if (stamp === null || stamp === this.cachedStamp) return;
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.locatorsPath)) {
                this.locators = JSON.parse(fs.readFileSync(this.locatorsPath, 'utf-8')) as LocatorStore;
            }
            this.cachedStamp = this.currentStamp();
        } catch (err) {
            logger.error(`[FileAdapter] ❌ Failed to load locators: ${String(err)}`);
            this.locators = {};
            // Leave the stamp unset so a later read retries rather than caching
            // the failure for the rest of the run.
            this.cachedStamp = null;
        }
    }

    getLocator(key: string): string | null {
        try {
            this.refreshIfStale();
            const parts = key.split('.');
            let current: string | LocatorStore | undefined = this.locators;
            for (const part of parts) {
                if (current === undefined || current === null || typeof current === 'string') return null;
                current = current[part] as string | LocatorStore;
            }
            return typeof current === 'string' ? current : null;
        } catch {
            return null;
        }
    }

    async updateLocator(key: string, selector: string): Promise<void> {
        let release: (() => Promise<void>) | undefined;
        try {
            release = await lockfile.lock(this.locatorsPath, {
                retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 1000 },
            });
            this.load();

            const parts = key.split('.');
            let current: LocatorStore = this.locators;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (!part) continue;
                if (!current[part] || typeof current[part] === 'string') current[part] = {};
                const next = current[part];
                if (typeof next === 'string') throw new Error(`Cannot traverse through '${part}'`);
                current = next;
            }
            const lastPart = parts[parts.length - 1];
            if (current && typeof current === 'object' && lastPart !== undefined) {
                current[lastPart] = selector;
            }
            fs.writeFileSync(this.locatorsPath, JSON.stringify(this.locators, null, 2), 'utf-8');
            // Re-stamp after our own write, so the very next read does not see a
            // changed mtime and needlessly re-parse a file we just authored.
            this.cachedStamp = this.currentStamp();
            logger.info(`[FileAdapter] 💾 Updated '${key}' → '${selector}'`);
        } catch (err) {
            logger.error(`[FileAdapter] ❌ updateLocator failed for '${key}': ${String(err)}`);
            throw err;
        } finally {
            if (release) await release();
        }
    }

    getAllLocators(): Record<string, string> {
        this.refreshIfStale();
        const flat: Record<string, string> = {};
        const flatten = (obj: LocatorStore, prefix: string) => {
            for (const [k, v] of Object.entries(obj)) {
                const dotKey = prefix ? `${prefix}.${k}` : k;
                if (typeof v === 'string') flat[dotKey] = v;
                else flatten(v, dotKey);
            }
        };
        flatten(this.locators, '');
        return flat;
    }
}

// ── SQLiteAdapter ─────────────────────────────────────────────────────────────

/**
 * Minimal interface for a better-sqlite3 database instance.
 *
 * Covers only the subset of the API used by `SQLiteAdapter`. This avoids
 * pulling in `@types/better-sqlite3` as a prod dependency while still
 * keeping the adapter fully type-safe.
 */
interface BetterSqlite3Database {
    exec(sql: string): void;
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): unknown;
    };
    close(): void;
}

/**
 * SQLiteAdapter — ACID-compliant storage backend using SQLite.
 *
 * Stores all locators in a single `locators` table inside a `.db` file.
 * SQLite handles concurrent reads natively and requires no external
 * `proper-lockfile` wrapper. This adapter is the drop-in replacement that
 * demonstrates the adapter pattern — swap `LOCATOR_STORE=sqlite` and no
 * application code changes.
 *
 * Schema:
 * ```sql
 * CREATE TABLE locators (
 *   key        TEXT PRIMARY KEY,
 *   selector   TEXT NOT NULL,
 *   updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 * );
 * ```
 *
 * To migrate to a real cloud DB (Postgres, MySQL, Supabase), implement
 * the same `LocatorAdapter` interface with a driver of your choice — the
 * rest of the framework requires no changes.
 */
export class SQLiteAdapter implements LocatorAdapter {
    private readonly db: BetterSqlite3Database;

    constructor(dbPath?: string) {
        const resolvedPath = dbPath ?? path.resolve(__dirname, '../config/locators.db');
        // Loaded on demand so native binding errors only surface when the SQLite
        // adapter is actually chosen, not when the file adapter is used.
        const require = createRequire(import.meta.url);
        const Database = require('better-sqlite3') as new (path: string, opts?: object) => BetterSqlite3Database;
        this.db = new Database(resolvedPath);
        this.migrate();
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS locators (
                key        TEXT PRIMARY KEY,
                selector   TEXT NOT NULL,
                updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
        `);
        logger.info('[SQLiteAdapter] ✅ Schema ready.');
    }

    getLocator(key: string): string | null {
        const row = this.db.prepare('SELECT selector FROM locators WHERE key = ?').get(key) as
            | { selector: string }
            | undefined;
        return row?.selector ?? null;
    }

    async updateLocator(key: string, selector: string): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO locators (key, selector)
                 VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET
                     selector   = excluded.selector,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
            )
            .run(key, selector);
        logger.info(`[SQLiteAdapter] 💾 Updated '${key}' → '${selector}'`);
        return Promise.resolve();
    }

    getAllLocators(): Record<string, string> {
        const rows = this.db.prepare('SELECT key, selector FROM locators').all() as Array<{
            key: string;
            selector: string;
        }>;
        return Object.fromEntries(rows.map(r => [r.key, r.selector]));
    }

    /** Close the underlying database connection and release the file handle. */
    close(): void {
        this.db.close();
    }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the configured `LocatorAdapter`.
 *
 * @param store - Backend identifier (`'file'` or `'sqlite'`). Reads
 *   `LOCATOR_STORE` env var when omitted.
 */
export function createLocatorAdapter(store?: string): LocatorAdapter {
    const backend = store ?? process.env['LOCATOR_STORE'] ?? 'file';
    if (backend === 'sqlite') {
        logger.info('[LocatorAdapter] 🗄️ Using SQLiteAdapter');
        return new SQLiteAdapter();
    }
    logger.info('[LocatorAdapter] 📄 Using FileAdapter');
    return new FileAdapter();
}
