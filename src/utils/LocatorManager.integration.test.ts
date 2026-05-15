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
});
