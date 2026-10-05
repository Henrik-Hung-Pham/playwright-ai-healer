import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock Logger to avoid file system side effects from Logger
vi.mock('./Logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

// Import the real FileAdapter — no module mock so this is a true integration test
import { FileAdapter } from './LocatorAdapter.js';

describe('FileAdapter integration', () => {
    let tmpDir: string;
    let locatorsPath: string;

    beforeEach(() => {
        // Create a temporary directory with initial locator data
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locator-test-'));
        locatorsPath = path.join(tmpDir, 'locators.json');

        const initialLocators = {
            app: {
                loginButton: '#login-btn',
                searchInput: '#search-input',
            },
            settings: {
                saveButton: '.save-btn',
            },
        };
        fs.writeFileSync(locatorsPath, JSON.stringify(initialLocators, null, 2), 'utf-8');
    });

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('reads a locator by dot-path key', () => {
        const adapter = new FileAdapter(locatorsPath);

        expect(adapter.getLocator('app.loginButton')).toBe('#login-btn');
        expect(adapter.getLocator('settings.saveButton')).toBe('.save-btn');
    });

    it('returns null for a missing key', () => {
        const adapter = new FileAdapter(locatorsPath);

        expect(adapter.getLocator('app.nonexistent')).toBeNull();
        expect(adapter.getLocator('missing.key')).toBeNull();
    });

    it('persists an updated locator to disk', async () => {
        const adapter = new FileAdapter(locatorsPath);
        await adapter.updateLocator('app.loginButton', '#new-login-btn');

        // In-memory state should reflect the update
        expect(adapter.getLocator('app.loginButton')).toBe('#new-login-btn');

        // The change must also be written to disk
        const onDisk = JSON.parse(fs.readFileSync(locatorsPath, 'utf-8')) as Record<string, Record<string, string>>;
        expect(onDisk['app']?.['loginButton']).toBe('#new-login-btn');
        // Unrelated locators should be untouched
        expect(onDisk['app']?.['searchInput']).toBe('#search-input');
        expect(onDisk['settings']?.['saveButton']).toBe('.save-btn');
    });

    it('creates intermediate objects for new dot-path keys', async () => {
        const adapter = new FileAdapter(locatorsPath);
        await adapter.updateLocator('checkout.paymentForm.submit', '#pay-now');

        const onDisk = JSON.parse(fs.readFileSync(locatorsPath, 'utf-8')) as Record<
            string,
            Record<string, Record<string, string>>
        >;
        expect(onDisk['checkout']?.['paymentForm']?.['submit']).toBe('#pay-now');
    });

    it('returns all locators as a flat key→selector map', () => {
        const adapter = new FileAdapter(locatorsPath);
        const all = adapter.getAllLocators();

        expect(all).toMatchObject({
            'app.loginButton': '#login-btn',
            'app.searchInput': '#search-input',
            'settings.saveButton': '.save-btn',
        });
    });

    it('starts with an empty store when the file does not exist', () => {
        const missing = path.join(tmpDir, 'nonexistent.json');
        const adapter = new FileAdapter(missing);

        expect(adapter.getLocator('any.key')).toBeNull();
        expect(adapter.getAllLocators()).toEqual({});
    });

    /**
     * Playwright runs workers as separate OS processes. Two `FileAdapter`
     * instances over the same path model two workers; a write through one must
     * become visible to the other, or a heal performed by worker A is repaid by
     * every other worker as a fresh AI call for a key that is already fixed.
     */
    describe('cross-worker visibility', () => {
        /** Force a distinguishable mtime — some filesystems have coarse resolution. */
        const writeExternally = (contents: object): void => {
            fs.writeFileSync(locatorsPath, JSON.stringify(contents, null, 2), 'utf-8');
            const future = new Date(Date.now() + 1000);
            fs.utimesSync(locatorsPath, future, future);
        };

        it('sees a selector healed by another worker', () => {
            const workerA = new FileAdapter(locatorsPath);
            const workerB = new FileAdapter(locatorsPath);

            // Both start in agreement.
            expect(workerA.getLocator('app.loginButton')).toBe('#login-btn');
            expect(workerB.getLocator('app.loginButton')).toBe('#login-btn');

            // Worker A heals the selector.
            writeExternally({
                app: { loginButton: '#healed-login-btn', searchInput: '#search-input' },
                settings: { saveButton: '.save-btn' },
            });

            // Worker B must pick it up rather than serving its constructor-time copy.
            expect(workerB.getLocator('app.loginButton')).toBe('#healed-login-btn');
        });

        it('reflects external writes in getAllLocators', () => {
            const adapter = new FileAdapter(locatorsPath);
            expect(adapter.getAllLocators()).not.toHaveProperty('checkout.payNow');

            writeExternally({
                app: { loginButton: '#login-btn', searchInput: '#search-input' },
                settings: { saveButton: '.save-btn' },
                checkout: { payNow: '#pay-now' },
            });

            expect(adapter.getAllLocators()).toMatchObject({ 'checkout.payNow': '#pay-now' });
        });

        /**
         * Assert the cache is genuinely doing work, without spying on `fs`
         * (ESM namespaces are not configurable, so `vi.spyOn(fs, …)` throws).
         *
         * Instead, rewrite the file with content of *identical length* and
         * restore the original mtime. That is precisely the mutation the
         * stamp cannot detect — so if the adapter still reports the old value,
         * it served from cache rather than re-reading on every call.
         *
         * Times are pinned to a whole second because `mtimeMs` carries
         * sub-millisecond precision that `utimesSync` (which takes a `Date`)
         * cannot round-trip — restoring an unpinned mtime yields a *different*
         * stamp and defeats the very thing under test.
         */
        const PINNED_TIME = new Date(Math.floor(Date.now() / 1000) * 1000);

        const pinStamp = (): void => fs.utimesSync(locatorsPath, PINNED_TIME, PINNED_TIME);

        const rewritePreservingStamp = (contents: object): void => {
            const before = fs.statSync(locatorsPath);
            fs.writeFileSync(locatorsPath, JSON.stringify(contents, null, 2), 'utf-8');
            const after = fs.statSync(locatorsPath);
            expect(after.size, 'test bug: replacement must be the same length').toBe(before.size);
            pinStamp();
        };

        it('serves from cache while the file stamp is unchanged', () => {
            pinStamp();
            const adapter = new FileAdapter(locatorsPath);
            expect(adapter.getLocator('app.loginButton')).toBe('#login-btn');

            // '#login-btn' and '#login-BTN' are the same length.
            rewritePreservingStamp({
                app: { loginButton: '#login-BTN', searchInput: '#search-input' },
                settings: { saveButton: '.save-btn' },
            });

            expect(adapter.getLocator('app.loginButton')).toBe('#login-btn');
        });

        it('serves from cache after its own write', async () => {
            const adapter = new FileAdapter(locatorsPath);
            await adapter.updateLocator('app.loginButton', '#self-written');
            expect(adapter.getLocator('app.loginButton')).toBe('#self-written');
            pinStamp();
            // Re-prime the cache against the pinned stamp before mutating.
            expect(adapter.getLocator('app.loginButton')).toBe('#self-written');

            rewritePreservingStamp({
                app: { loginButton: '#self-WRITTEN', searchInput: '#search-input' },
                settings: { saveButton: '.save-btn' },
            });

            // Re-stamped after the write, so this is still a cache hit.
            expect(adapter.getLocator('app.loginButton')).toBe('#self-written');
        });

        it('recovers when the store appears after construction', () => {
            const missing = path.join(tmpDir, 'later.json');
            const adapter = new FileAdapter(missing);
            expect(adapter.getLocator('app.loginButton')).toBeNull();

            fs.writeFileSync(missing, JSON.stringify({ app: { loginButton: '#arrived' } }), 'utf-8');

            expect(adapter.getLocator('app.loginButton')).toBe('#arrived');
        });
    });
});
