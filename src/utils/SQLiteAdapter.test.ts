import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('./Logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SQLiteAdapter } from './LocatorAdapter.js';

describe('SQLiteAdapter', () => {
    let tmpDir: string;
    let dbPath: string;
    let adapter: SQLiteAdapter;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-test-'));
        dbPath = path.join(tmpDir, 'locators.db');
        adapter = new SQLiteAdapter(dbPath);
    });

    afterEach(() => {
        // Close the DB connection to release the file lock before cleanup (required on Windows)
        adapter.close();
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns null for a key that does not exist', () => {
        expect(adapter.getLocator('missing.key')).toBeNull();
    });

    it('stores and retrieves a locator by flat dot-path key', async () => {
        await adapter.updateLocator('app.loginButton', '#login-btn');

        expect(adapter.getLocator('app.loginButton')).toBe('#login-btn');
    });

    it('overwrites an existing locator when updated', async () => {
        await adapter.updateLocator('app.loginButton', '#old-btn');
        await adapter.updateLocator('app.loginButton', '#new-btn');

        expect(adapter.getLocator('app.loginButton')).toBe('#new-btn');
    });

    it('stores multiple independent locators', async () => {
        await adapter.updateLocator('home.search', '#search-input');
        await adapter.updateLocator('home.cart', '.cart-icon');
        await adapter.updateLocator('product.addToCart', 'button[data-add]');

        expect(adapter.getLocator('home.search')).toBe('#search-input');
        expect(adapter.getLocator('home.cart')).toBe('.cart-icon');
        expect(adapter.getLocator('product.addToCart')).toBe('button[data-add]');
    });

    it('getAllLocators returns all stored key→selector pairs', async () => {
        await adapter.updateLocator('a.x', '#x');
        await adapter.updateLocator('b.y', '.y');

        const all = adapter.getAllLocators();
        expect(all).toMatchObject({ 'a.x': '#x', 'b.y': '.y' });
        expect(Object.keys(all)).toHaveLength(2);
    });

    it('getAllLocators returns an empty object when store is empty', () => {
        expect(adapter.getAllLocators()).toEqual({});
    });

    it('creates the DB file on disk', () => {
        expect(fs.existsSync(dbPath)).toBe(true);
    });
});
