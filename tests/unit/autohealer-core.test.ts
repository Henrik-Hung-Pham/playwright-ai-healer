import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from '@playwright/test';
import { AutoHealer } from '../../src/AutoHealer.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { LocatorManager } from '../../src/utils/LocatorManager.js';

/** Shape of the mock LocatorManager returned by the mocked getInstance(). */
interface MockLocatorManagerInstance {
    getLocator: ReturnType<typeof vi.fn>;
    updateLocator: ReturnType<typeof vi.fn>;
    recordSelectorFailure: ReturnType<typeof vi.fn>;
    recordSelectorHealed: ReturnType<typeof vi.fn>;
}

// Mock dependencies
vi.mock('@playwright/test', () => ({
    test: {
        info: vi.fn().mockReturnValue({ annotations: [] }),
        skip: vi.fn(),
    },
}));

vi.mock('../../src/utils/Logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../src/config/index.js', () => ({
    config: {
        ai: {
            gemini: { modelName: 'mock-gemini-model' },
            openai: { modelName: 'mock-openai-model' },
            healing: {
                domSnapshotCharLimit: 2000,
                confidenceThreshold: 0.7,
                maxRetries: 3,
                retryDelay: 100,
                failureMode: 'skip' as 'fail' | 'skip',
            },
            prompts: {
                healingPrompt: () => 'mock prompt',
            },
        },
        test: {
            timeouts: {
                short: 1000,
            },
        },
    },
}));

vi.mock('../../src/utils/LocatorManager.js', () => ({
    LocatorManager: {
        getInstance: vi.fn(() => ({
            getLocator: vi.fn(),
            updateLocator: vi.fn().mockResolvedValue(undefined),
            recordSelectorFailure: vi.fn(),
            recordSelectorHealed: vi.fn(),
        })),
    },
}));

// Mock GoogleGenerativeAI
vi.mock('@google/generative-ai', () => {
    const generateContentMock = vi.fn();
    const getGenerativeModelMock = vi.fn(() => ({
        generateContent: generateContentMock,
    }));

    return {
        GoogleGenerativeAI: vi.fn(function () {
            return {
                getGenerativeModel: getGenerativeModelMock,
            };
        }),
    };
});

describe('AutoHealer Core Logic', () => {
    let autoHealer: AutoHealer;
    let mockPage: {
        evaluate: ReturnType<typeof vi.fn>;
        click: ReturnType<typeof vi.fn>;
        fill: ReturnType<typeof vi.fn>;
        locator: ReturnType<typeof vi.fn>;
    };
    let mockGenerateContent: ReturnType<typeof vi.fn>;
    let mockUpdateLocator: ReturnType<typeof vi.fn>;
    let mockRecordSelectorFailure: ReturnType<typeof vi.fn>;
    let mockRecordSelectorHealed: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // Mock setTimeout to resolve immediately
        vi.stubGlobal('setTimeout', (fn: () => void) => {
            fn();
            return 1;
        });

        mockPage = {
            evaluate: vi.fn().mockResolvedValue('<html>mock dom</html>'),
            click: vi.fn(),
            fill: vi.fn(),
            locator: vi.fn().mockReturnValue({
                waitFor: vi.fn().mockResolvedValue(undefined),
                count: vi.fn().mockResolvedValue(1),
            }),
        };

        // Reset mocks
        vi.clearAllMocks();

        // Setup AI mock
        const mockModel = {
            generateContent: vi.fn(),
        };
        // Must use `function` (not arrow) because this mock is invoked with `new`
        vi.mocked(GoogleGenerativeAI).mockImplementation(function () {
            return { getGenerativeModel: () => mockModel } as unknown as GoogleGenerativeAI;
        });
        mockGenerateContent = mockModel.generateContent;

        // Setup LocatorManager mock
        mockUpdateLocator = vi.fn().mockResolvedValue(undefined);
        mockRecordSelectorFailure = vi.fn().mockResolvedValue(undefined);
        mockRecordSelectorHealed = vi.fn().mockResolvedValue(undefined);
        vi.mocked(LocatorManager.getInstance).mockReturnValue({
            getLocator: vi.fn(),
            updateLocator: mockUpdateLocator,
            recordSelectorFailure: mockRecordSelectorFailure,
            recordSelectorHealed: mockRecordSelectorHealed,
        } as unknown as LocatorManager);

        autoHealer = new AutoHealer(mockPage as unknown as Page, 'mock-key', 'gemini');
    });

    describe('click() Healing Flow', () => {
        it('should retry click with new selector when initial click fails', async () => {
            const brokenSelector = '#broken-btn';
            const healedSelector = '#fixed-btn';

            // Mock page.click to fail once, then succeed
            mockPage.click.mockRejectedValueOnce(new Error('Element not found')).mockResolvedValueOnce(undefined);

            // Mock AI to return a healed selector
            mockGenerateContent.mockResolvedValue({
                response: {
                    text: () => healedSelector,
                },
            });

            await autoHealer.click(brokenSelector);

            // Expect heal to have been called
            expect(mockGenerateContent).toHaveBeenCalled();

            // Expect page.click to be called twice
            expect(mockPage.click).toHaveBeenCalledTimes(2);

            // First call with broken selector
            expect(mockPage.click).toHaveBeenNthCalledWith(1, brokenSelector, expect.anything());

            // Second call with HEALED selector
            // Note: The second argument is 'options'. We passed undefined, so it should be checked loosely or specifically.
            // In the implementation: await this.page.click(result.selector, options);
            expect(mockPage.click).toHaveBeenNthCalledWith(2, healedSelector, undefined);
        });

        it('should update locator manager if a key was provided', async () => {
            const key = 'submitButton';
            const brokenSelector = '#old-submit';
            const healedSelector = '#new-submit';

            // Mock LocatorManager to return broken selector for the key
            (LocatorManager.getInstance() as unknown as MockLocatorManagerInstance).getLocator.mockReturnValue(
                brokenSelector
            );

            // Mock page failure and AI success
            mockPage.click.mockRejectedValueOnce(new Error('Element not found')).mockResolvedValueOnce(undefined);
            mockGenerateContent.mockResolvedValue({
                response: { text: () => healedSelector },
            });

            await autoHealer.click(key);

            // Expect updateLocator to be called
            expect(mockUpdateLocator).toHaveBeenCalledWith(key, healedSelector);
            // Expect recordSelectorHealed to be called after a successful heal
            expect(mockRecordSelectorHealed).toHaveBeenCalledWith(key);
        });

        it('should record selector failure when a keyed selector fails', async () => {
            const key = 'submitButton';
            const brokenSelector = '#old-submit';
            const healedSelector = '#new-submit';

            (LocatorManager.getInstance() as unknown as MockLocatorManagerInstance).getLocator.mockReturnValue(
                brokenSelector
            );
            mockPage.click.mockRejectedValueOnce(new Error('Element not found')).mockResolvedValueOnce(undefined);
            mockGenerateContent.mockResolvedValue({ response: { text: () => healedSelector } });

            await autoHealer.click(key);

            expect(mockRecordSelectorFailure).toHaveBeenCalledWith(key);
        });

        it('should skip test if healing fails (returns null)', async () => {
            const brokenSelector = '#broken';

            mockPage.click.mockRejectedValue(new Error('Element not found'));

            // Mock AI to return FAIL or throw
            mockGenerateContent.mockResolvedValue({
                response: { text: () => 'FAIL' },
            });

            await autoHealer.click(brokenSelector);

            // Should not retry click
            expect(mockPage.click).toHaveBeenCalledTimes(1);

            const { test } = await import('@playwright/test');
            expect(test.skip).toHaveBeenCalledWith(
                true,
                'Test skipped because AutoHealer AI could not find a suitable replacement selector.'
            );
        });
    });

    describe('fill() Healing Flow', () => {
        it('should retry fill with new selector when initial fill fails', async () => {
            const brokenSelector = '#broken-input';
            const healedSelector = '#fixed-input';
            const value = 'test value';

            // Mock page.fill to fail once, then succeed
            mockPage.fill.mockRejectedValueOnce(new Error('Element not found')).mockResolvedValueOnce(undefined);

            // Mock AI
            mockGenerateContent.mockResolvedValue({
                response: { text: () => healedSelector },
            });

            await autoHealer.fill(brokenSelector, value);

            expect(mockPage.fill).toHaveBeenCalledTimes(2);
            expect(mockPage.fill).toHaveBeenNthCalledWith(1, brokenSelector, value, expect.anything());
            expect(mockPage.fill).toHaveBeenNthCalledWith(2, healedSelector, value, undefined);
        });
    });

    describe('healAll()', () => {
        it('should return all success when every operation passes in Phase 1', async () => {
            // Arrange
            mockPage.click.mockResolvedValue(undefined);
            mockPage.fill.mockResolvedValue(undefined);

            const operations = [
                { selectorOrKey: '#btn-a', action: 'click' as const },
                { selectorOrKey: '#input-b', action: 'fill' as const, value: 'hello' },
            ];

            // Act
            const results = await autoHealer.healAll(operations);

            // Assert
            expect(results).toEqual([
                { selectorOrKey: '#btn-a', success: true },
                { selectorOrKey: '#input-b', success: true },
            ]);
            expect(mockGenerateContent).not.toHaveBeenCalled();
        });

        it('should heal a failing operation and return success with healedSelector', async () => {
            // Arrange
            const healedSelector = '#healed-btn';
            const locatorManagerMock = LocatorManager.getInstance() as unknown as MockLocatorManagerInstance;
            locatorManagerMock.getLocator.mockReturnValue('#broken-btn');

            // Phase 1: click fails
            mockPage.click
                .mockRejectedValueOnce(new Error('Element not found'))
                // Phase 3: retry succeeds
                .mockResolvedValueOnce(undefined);

            // AI returns a healed selector
            mockGenerateContent.mockResolvedValue({
                response: { text: () => healedSelector },
            });

            const operations = [{ selectorOrKey: 'page.button', action: 'click' as const }];

            // Act
            const results = await autoHealer.healAll(operations);

            // Assert
            expect(results).toEqual([
                {
                    selectorOrKey: 'page.button',
                    success: true,
                    healedSelector,
                },
            ]);
            expect(mockUpdateLocator).toHaveBeenCalledWith('page.button', healedSelector);
            expect(mockRecordSelectorHealed).toHaveBeenCalledWith('page.button');
        });

        it('should return failure with error message when AI returns null (FAIL)', async () => {
            // Arrange
            mockPage.click.mockRejectedValueOnce(new Error('Element not found'));

            // AI returns FAIL → heal() returns null
            mockGenerateContent.mockResolvedValue({
                response: { text: () => 'FAIL' },
            });

            const operations = [{ selectorOrKey: '#broken', action: 'click' as const }];

            // Act
            const results = await autoHealer.healAll(operations);

            // Assert
            expect(results).toEqual([
                {
                    selectorOrKey: '#broken',
                    success: false,
                    error: 'AI could not find a replacement selector',
                },
            ]);
        });

        it('should return failure with healedSelector when retry also fails after healing', async () => {
            // Arrange
            const healedSelector = '#healed-btn';

            // Phase 1: fails, Phase 3: also fails
            mockPage.click
                .mockRejectedValueOnce(new Error('Element not found'))
                .mockRejectedValueOnce(new Error('Still not found'));

            mockGenerateContent.mockResolvedValue({
                response: { text: () => healedSelector },
            });

            const operations = [{ selectorOrKey: '#broken', action: 'click' as const }];

            // Act
            const results = await autoHealer.healAll(operations);

            // Assert
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                selectorOrKey: '#broken',
                success: false,
                healedSelector,
            });
            expect(results[0]?.error).toBeDefined();
            expect(results[0]?.error).toContain('Still not found');
        });

        it('should fire AI healing concurrently for multiple failures', async () => {
            // Arrange
            const healedA = '#healed-a';
            const healedB = '#healed-b';

            // Both operations fail in Phase 1
            mockPage.click
                .mockRejectedValueOnce(new Error('A not found'))
                .mockRejectedValueOnce(new Error('B not found'))
                // Phase 3: both retries succeed
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined);

            // AI heals both
            mockGenerateContent
                .mockResolvedValueOnce({ response: { text: () => healedA } })
                .mockResolvedValueOnce({ response: { text: () => healedB } });

            const operations = [
                { selectorOrKey: '#btn-a', action: 'click' as const },
                { selectorOrKey: '#btn-b', action: 'click' as const },
            ];

            // Act
            const results = await autoHealer.healAll(operations);

            // Assert — both healed successfully
            expect(results).toEqual([
                { selectorOrKey: '#btn-a', success: true, healedSelector: healedA },
                { selectorOrKey: '#btn-b', success: true, healedSelector: healedB },
            ]);
            // heal() was called twice (one per failure, concurrently via Promise.allSettled)
            expect(mockGenerateContent).toHaveBeenCalledTimes(2);
        });

        it('should call recordSelectorFailure when a keyed selector fails in Phase 1', async () => {
            // Arrange
            const locatorManagerMock = LocatorManager.getInstance() as unknown as MockLocatorManagerInstance;
            locatorManagerMock.getLocator.mockReturnValue('#resolved-selector');

            mockPage.click.mockRejectedValueOnce(new Error('Element not found'));

            // AI returns FAIL so we don't need to handle Phase 3
            mockGenerateContent.mockResolvedValue({
                response: { text: () => 'FAIL' },
            });

            const operations = [{ selectorOrKey: 'booksToScrape.searchInput', action: 'click' as const }];

            // Act
            await autoHealer.healAll(operations);

            // Assert
            expect(mockRecordSelectorFailure).toHaveBeenCalledWith('booksToScrape.searchInput');
        });
    });
});
