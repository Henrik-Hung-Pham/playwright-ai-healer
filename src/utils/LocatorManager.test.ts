import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs module before importing LocatorManager
vi.mock('fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

// Mock proper-lockfile
vi.mock('proper-lockfile', () => ({
    lock: vi.fn().mockResolvedValue(() => Promise.resolve()), // success immediately
    check: vi.fn(),
    unlock: vi.fn(),
    default: {
        lock: vi.fn().mockResolvedValue(() => Promise.resolve()),
        check: vi.fn(),
        unlock: vi.fn(),
    },
}));

const getLocatorManager = async () => {
    // Clear module cache and get fresh instance
    vi.resetModules();
    // Ensure config validation passes
    process.env.GEMINI_API_KEY = 'test-key';
    const { LocatorManager } = await import('./LocatorManager.js');
    const mockedFs = await import('fs');
    return { LocatorManager, mockedFs };
};

describe('LocatorManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('Singleton Pattern', () => {
        it('should return the same instance on multiple calls', async () => {
            const mockLocators = { page: { button: '#submit' } };
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue(JSON.stringify(mockLocators));

            const instance1 = LocatorManager.getInstance();
            const instance2 = LocatorManager.getInstance();

            expect(instance1).toBe(instance2);
        });
    });

    describe('getLocator', () => {
        it('should return selector for valid simple key', async () => {
            const mockLocators = { button: '#submit-btn' };
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue(JSON.stringify(mockLocators));

            const manager = LocatorManager.getInstance();

            expect(manager.getLocator('button')).toBe('#submit-btn');
        });

        it('should return selector for valid nested key', async () => {
            const mockLocators = { booksToScrape: { searchInput: '#search-box' } };
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue(JSON.stringify(mockLocators));

            const manager = LocatorManager.getInstance();

            expect(manager.getLocator('booksToScrape.searchInput')).toBe('#search-box');
        });

        it('should return null for non-existent key', async () => {
            const mockLocators = { page: { button: '#submit' } };
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue(JSON.stringify(mockLocators));

            const manager = LocatorManager.getInstance();

            expect(manager.getLocator('nonexistent.key')).toBeNull();
        });

        it('should return null for non-string value', async () => {
            const mockLocators = { page: { nested: { deep: 'value' } } };
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue(JSON.stringify(mockLocators));

            const manager = LocatorManager.getInstance();

            // 'page.nested' returns an object, not a string
            expect(manager.getLocator('page.nested')).toBeNull();
        });
    });

    describe('updateLocator', () => {
        it('should update locator and save to file', async () => {
            const mockLocators = { booksToScrape: { searchInput: '#old-selector' } };
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue(JSON.stringify(mockLocators));
            vi.mocked(mockedFs.writeFileSync).mockImplementation(() => {});

            const manager = LocatorManager.getInstance();

            await manager.updateLocator('booksToScrape.searchInput', '#new-selector');

            expect(mockedFs.writeFileSync).toHaveBeenCalled();
            // Verify the new value is accessible
            expect(manager.getLocator('booksToScrape.searchInput')).toBe('#new-selector');
        });

        it('should create nested path if it does not exist', async () => {
            const mockLocators = {};
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue(JSON.stringify(mockLocators));
            vi.mocked(mockedFs.writeFileSync).mockImplementation(() => {});

            const manager = LocatorManager.getInstance();

            await manager.updateLocator('new.nested.path', '#new-selector');

            expect(mockedFs.writeFileSync).toHaveBeenCalled();
        });
    });

    describe('Selector Stability Metrics', () => {
        it('recordSelectorFailure is a no-op for a selector that was never healed', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(false);

            const manager = LocatorManager.getInstance();
            await manager.recordSelectorFailure('booksToScrape.searchInput');

            // No metrics entry should have been created
            expect(manager.getMetrics('booksToScrape.searchInput')).toEqual({ failureCount: 0 });
            expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
        });

        it('recordSelectorHealed sets healedAt and resets failureCount', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(false);
            vi.mocked(mockedFs.writeFileSync).mockImplementation(() => {});

            const manager = LocatorManager.getInstance();
            await manager.recordSelectorHealed('booksToScrape.searchInput');

            const metrics = manager.getMetrics('booksToScrape.searchInput');
            expect(metrics.failureCount).toBe(0);
            expect(metrics.healedAt).toBeDefined();
            expect(typeof metrics.healedAt).toBe('string');
            expect(mockedFs.writeFileSync).toHaveBeenCalled();
        });

        it('recordSelectorFailure increments failureCount for a previously healed selector', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(false);
            vi.mocked(mockedFs.writeFileSync).mockImplementation(() => {});

            const manager = LocatorManager.getInstance();
            // Heal first so the guard passes
            await manager.recordSelectorHealed('booksToScrape.searchInput');
            await manager.recordSelectorFailure('booksToScrape.searchInput');

            const metrics = manager.getMetrics('booksToScrape.searchInput');
            expect(metrics.failureCount).toBe(1);
            expect(metrics.lastFailedAt).toBeDefined();
        });

        it('recordSelectorHealed resets failureCount from a previous heal cycle', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(false);
            vi.mocked(mockedFs.writeFileSync).mockImplementation(() => {});

            const manager = LocatorManager.getInstance();
            await manager.recordSelectorHealed('booksToScrape.searchInput');
            await manager.recordSelectorFailure('booksToScrape.searchInput');
            await manager.recordSelectorFailure('booksToScrape.searchInput');
            // Heal again — failureCount should reset to 0
            await manager.recordSelectorHealed('booksToScrape.searchInput');

            expect(manager.getMetrics('booksToScrape.searchInput').failureCount).toBe(0);
        });

        it('getMetrics() returns shallow copy of all entries', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(false);
            vi.mocked(mockedFs.writeFileSync).mockImplementation(() => {});

            const manager = LocatorManager.getInstance();
            await manager.recordSelectorHealed('a.b');
            await manager.recordSelectorHealed('c.d');

            const all = manager.getMetrics();
            expect(Object.keys(all)).toContain('a.b');
            expect(Object.keys(all)).toContain('c.d');
            // Mutation of returned object must not affect internal state
            (all as Record<string, unknown>)['injected'] = true;
            expect(manager.getMetrics('injected')).toEqual({ failureCount: 0 });
        });

        it('getMetrics(key) returns default for an unknown key', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(false);

            const manager = LocatorManager.getInstance();
            expect(manager.getMetrics('unknown.key')).toEqual({ failureCount: 0 });
        });

        it('handles corrupt metrics.json gracefully and resets to empty store', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            // First call (locators.json) returns valid JSON; second (metrics.json) returns corrupt data
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync)
                .mockReturnValueOnce('{}') // locators.json
                .mockReturnValueOnce('{ corrupt json !!!'); // metrics.json

            const manager = LocatorManager.getInstance();
            // Should not throw and should return empty metrics
            expect(manager.getMetrics('any.key')).toEqual({ failureCount: 0 });
        });
    });

    describe('File Handling', () => {
        it('should handle missing locators file gracefully', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(false);
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const manager = LocatorManager.getInstance();

            expect(manager.getLocator('any.key')).toBeNull();
            consoleSpy.mockRestore();
        });

        it('should handle invalid JSON gracefully', async () => {
            const { LocatorManager, mockedFs } = await getLocatorManager();
            vi.mocked(mockedFs.existsSync).mockReturnValue(true);
            vi.mocked(mockedFs.readFileSync).mockReturnValue('{ invalid json }');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const manager = LocatorManager.getInstance();

            expect(manager.getLocator('any.key')).toBeNull();
            consoleSpy.mockRestore();
        });
    });
});
