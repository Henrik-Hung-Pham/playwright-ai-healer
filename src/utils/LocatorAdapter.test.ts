import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs module
vi.mock('fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
}));

// Mock proper-lockfile
vi.mock('proper-lockfile', () => ({
    lock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
    default: {
        lock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
    },
}));

// Hoist mockLogger
const { mockLogger } = vi.hoisted(() => ({
    mockLogger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('./Logger.js', () => ({
    logger: mockLogger,
}));

// Must import after mocks
import * as fs from 'fs';
import * as lockfile from 'proper-lockfile';
import { FileAdapter, createLocatorAdapter } from './LocatorAdapter.js';

describe('FileAdapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor and load()', () => {
        it('should load locators from existing file', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ page: { btn: '#submit' } }));

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('page.btn')).toBe('#submit');
        });

        it('should initialize with empty locators when file does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('any.key')).toBeNull();
        });

        it('should handle invalid JSON gracefully', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('any.key')).toBeNull();
            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load locators'));
        });
    });

    describe('getLocator()', () => {
        it('should return selector for valid dot-path key', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    booksToScrape: { searchInput: '#search-box' },
                })
            );

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('booksToScrape.searchInput')).toBe('#search-box');
        });

        it('should return null for non-existent key', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ page: { btn: '#x' } }));

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('nonexistent.key')).toBeNull();
        });

        it('should return null when traversing into a string value', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ page: { btn: '#x' } }));

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('page.btn.deep')).toBeNull();
        });

        it('should return null for object value (not a string)', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ page: { nested: { deep: 'value' } } }));

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('page.nested')).toBeNull();
        });

        it('should return simple top-level key', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ btn: '#submit' }));

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getLocator('btn')).toBe('#submit');
        });
    });

    describe('updateLocator()', () => {
        it('should update existing nested key', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ booksToScrape: { searchInput: '#old' } }));
            const releaseMock = vi.fn().mockResolvedValue(undefined);
            vi.mocked(lockfile.lock).mockResolvedValue(releaseMock);

            const adapter = new FileAdapter('/fake/path/locators.json');
            await adapter.updateLocator('booksToScrape.searchInput', '#new-selector');

            expect(fs.writeFileSync).toHaveBeenCalled();
            expect(releaseMock).toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Updated'));
        });

        it('should create nested path if it does not exist', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
            const releaseMock = vi.fn().mockResolvedValue(undefined);
            vi.mocked(lockfile.lock).mockResolvedValue(releaseMock);

            const adapter = new FileAdapter('/fake/path/locators.json');
            await adapter.updateLocator('new.nested.key', '#selector');

            expect(fs.writeFileSync).toHaveBeenCalled();
        });

        it('should release lock even when write fails', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
            const releaseMock = vi.fn().mockResolvedValue(undefined);
            vi.mocked(lockfile.lock).mockResolvedValue(releaseMock);
            vi.mocked(fs.writeFileSync).mockImplementation(() => {
                throw new Error('Write failed');
            });

            const adapter = new FileAdapter('/fake/path/locators.json');
            await expect(adapter.updateLocator('key', '#sel')).rejects.toThrow('Write failed');
            expect(releaseMock).toHaveBeenCalled();
        });

        it('should overwrite string value at intermediate path', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ page: '#old-string' }));
            vi.mocked(fs.writeFileSync).mockImplementation(() => {});
            const releaseMock = vi.fn().mockResolvedValue(undefined);
            vi.mocked(lockfile.lock).mockResolvedValue(releaseMock);

            const adapter = new FileAdapter('/fake/path/locators.json');
            await adapter.updateLocator('page.btn', '#new-btn');

            expect(fs.writeFileSync).toHaveBeenCalled();
        });
    });

    describe('getAllLocators()', () => {
        it('should return flat map of all locators', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    booksToScrape: { searchInput: '#search', btn: '#btn' },
                    other: '#other',
                })
            );

            const adapter = new FileAdapter('/fake/path/locators.json');
            const all = adapter.getAllLocators();

            expect(all).toEqual({
                'booksToScrape.searchInput': '#search',
                'booksToScrape.btn': '#btn',
                other: '#other',
            });
        });

        it('should return empty object when no locators loaded', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const adapter = new FileAdapter('/fake/path/locators.json');
            expect(adapter.getAllLocators()).toEqual({});
        });
    });
});

describe('createLocatorAdapter()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should create FileAdapter by default', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        delete process.env['LOCATOR_STORE'];

        const adapter = createLocatorAdapter();
        expect(adapter).toBeDefined();
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('FileAdapter'));
    });

    it('should create FileAdapter when store is "file"', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const adapter = createLocatorAdapter('file');
        expect(adapter).toBeDefined();
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('FileAdapter'));
    });

    it('should log SQLiteAdapter selection when store is "sqlite"', () => {
        // SQLiteAdapter requires better-sqlite3 native module. In CI/test
        // environments it may or may not be installed, so we just verify
        // the factory enters the sqlite branch by checking the log.
        try {
            createLocatorAdapter('sqlite');
        } catch {
            // Expected when better-sqlite3 is not installed
        }
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('SQLiteAdapter'));
    });
});
