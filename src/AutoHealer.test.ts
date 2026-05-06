// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { mockGeminiGenerateContent } from './test-setup.js';
import { AutoHealer } from './AutoHealer.js';
import { validateSelector } from './ai/SelectorValidator.js';

const { mockLocatorManager } = vi.hoisted(() => {
    return {
        mockLocatorManager: {
            getLocator: vi.fn((key: string) => (key === 'app.btn' ? '#old-selector' : null)),
            updateLocator: vi.fn().mockResolvedValue(undefined),
            recordSelectorFailure: vi.fn(),
            recordSelectorHealed: vi.fn(),
        },
    };
});

// Mock LocatorManager
vi.mock('./utils/LocatorManager.js', () => ({
    LocatorManager: {
        getInstance: vi.fn(() => mockLocatorManager),
    },
}));

// Mock page factory — includes all methods exercised by the 8 public action methods
const createMockPage = (): Partial<Page> => {
    const mockLocatorHandle = {
        waitFor: vi.fn().mockResolvedValue(undefined),
        pressSequentially: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(1),
    };
    return {
        click: vi.fn(),
        fill: vi.fn(),
        hover: vi.fn(),
        selectOption: vi.fn(),
        check: vi.fn(),
        uncheck: vi.fn(),
        waitForSelector: vi.fn(),
        evaluate: vi.fn().mockResolvedValue('<html><body><button id="btn">Click</button></body></html>'),
        locator: vi.fn().mockReturnValue(mockLocatorHandle),
    } as unknown as Partial<Page>;
};

describe('AutoHealer', () => {
    let mockPage: Partial<Page>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockPage = createMockPage();

        // Default mock response for Gemini
        mockGeminiGenerateContent.mockResolvedValue({
            response: { text: () => '#healed-selector' },
        });
    });

    describe('Constructor', () => {
        it('should initialize with Gemini provider', () => {
            const healer = new AutoHealer(mockPage as Page, 'test-api-key', 'gemini');
            expect(healer).toBeDefined();
        });

        it('should initialize with OpenAI provider', () => {
            const healer = new AutoHealer(mockPage as Page, 'test-api-key', 'openai');
            expect(healer).toBeDefined();
        });

        it('should accept array of API keys for key rotation', () => {
            const healer = new AutoHealer(mockPage as Page, ['key1', 'key2'], 'gemini');
            expect(healer).toBeDefined();
        });

        it('should use custom model name when provided', () => {
            const healer = new AutoHealer(mockPage as Page, 'key', 'gemini', 'gemini-pro', true);
            expect(healer).toBeDefined();
        });
    });

    describe('click()', () => {
        it('should click successfully without healing when element is found', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#existing-button');

            expect(mockPage.click).toHaveBeenCalledTimes(1);
            expect(mockPage.click).toHaveBeenCalledWith('#existing-button', expect.any(Object));
        });

        it('should attempt healing and retry when click fails', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError: Element not found'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#broken-selector');

            // Should have tried twice: original + healed
            expect(mockPage.click).toHaveBeenCalledTimes(2);
            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });

        it('should skip test when healing returns FAIL (no replacement selector found)', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Element not found'));
            mockGeminiGenerateContent.mockResolvedValue({
                response: { text: () => 'FAIL' },
            });

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);

            // Skip is unconditional when the AI cannot return a usable selector,
            // independent of config.ai.healing.failureMode.
            await healer.click('#nonexistent');

            const { test } = await import('@playwright/test');
            expect(test.skip).toHaveBeenCalledWith(
                true,
                expect.stringContaining('could not find a suitable replacement selector')
            );
        });

        it('should clean markdown code blocks from AI response', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            // AI returns selector wrapped in markdown
            mockGeminiGenerateContent.mockResolvedValue({
                response: { text: () => '```\n#clean-selector\n```' },
            });

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#broken');

            // Second call should use cleaned selector
            expect(mockPage.click).toHaveBeenLastCalledWith('#clean-selector', undefined);
        });
    });

    describe('fill()', () => {
        it('should fill successfully without healing when element is found', async () => {
            (mockPage.fill as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.fill('#input-field', 'test value');

            expect(mockPage.fill).toHaveBeenCalledTimes(1);
            expect(mockPage.fill).toHaveBeenCalledWith('#input-field', 'test value', expect.any(Object));
        });

        it('should attempt healing and retry when fill fails', async () => {
            (mockPage.fill as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.fill('#broken-input', 'value');

            expect(mockPage.fill).toHaveBeenCalledTimes(2);
            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });
    });

    describe('DOM Simplification (Interactive Elements + Ancestors)', () => {
        it('should include interactive elements and exclude scripts/styles', async () => {
            document.body.innerHTML = `
                <div id="wrapper">
                    <button id="keep-me">Keep Me</button>
                    <script>console.log("bad")</script>
                    <style>.css { color: red }</style>
                    <div style="color: blue">Decorative Div</div>
                    <!-- I am a comment -->
                </div>
            `;

            // Run the actual evaluate function in JSDOM
            (mockPage.evaluate as ReturnType<typeof vi.fn>).mockImplementation((fn: () => string) => fn());

            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#keep-me');

            const aiCallArgs = String(mockGeminiGenerateContent.mock.calls[0]![0]);

            // Interactive element (button) should be included
            expect(aiCallArgs).toContain('button');
            expect(aiCallArgs).toContain('keep-me');
            // Scripts/styles should not appear
            expect(aiCallArgs).not.toContain('<script>');
            expect(aiCallArgs).not.toContain('<style>');
            // Non-whitelisted attributes like style should be stripped
            expect(aiCallArgs).not.toContain('style="color: blue"');
        });

        it('should include ancestor chain of interactive elements', async () => {
            document.body.innerHTML = `
                <main id="app">
                    <section id="search-area">
                        <div id="inner-wrapper">
                            <input id="search-input" type="text" placeholder="Search..." />
                        </div>
                    </section>
                    <footer id="foot">
                        <p>Copyright 2025</p>
                    </footer>
                </main>
            `;

            (mockPage.evaluate as ReturnType<typeof vi.fn>).mockImplementation((fn: () => string) => fn());
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#search-input');

            const aiCallArgs = String(mockGeminiGenerateContent.mock.calls[0]![0]);

            // Interactive element and its ancestors should be included
            expect(aiCallArgs).toContain('search-input');
            expect(aiCallArgs).toContain('inner-wrapper');
            expect(aiCallArgs).toContain('search-area');
            expect(aiCallArgs).toContain('app');
            // Footer with no interactive children should NOT be included
            expect(aiCallArgs).not.toContain('foot');
            expect(aiCallArgs).not.toContain('Copyright');
        });

        it('should truncate long text nodes', async () => {
            const longText = 'a'.repeat(300);
            document.body.innerHTML = `<div><button id="btn">${longText}</button></div>`;

            (mockPage.evaluate as ReturnType<typeof vi.fn>).mockImplementation((fn: () => string) => fn());
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#target');

            const aiCallArgs = String(mockGeminiGenerateContent.mock.calls[0]![0]);
            expect(aiCallArgs).toContain('a'.repeat(80) + '...');
            expect(aiCallArgs).not.toContain('a'.repeat(81));
        });

        it('should collapse 3+ repeated siblings', async () => {
            document.body.innerHTML = `
                <ul id="product-list">
                    <li class="product-card"><button>Product 1</button></li>
                    <li class="product-card"><button>Product 2</button></li>
                    <li class="product-card"><button>Product 3</button></li>
                    <li class="product-card"><button>Product 4</button></li>
                    <li class="product-card"><button>Product 5</button></li>
                </ul>
            `;

            (mockPage.evaluate as ReturnType<typeof vi.fn>).mockImplementation((fn: () => string) => fn());
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#target');

            const aiCallArgs = String(mockGeminiGenerateContent.mock.calls[0]![0]);

            // First 2 products should be serialized
            expect(aiCallArgs).toContain('Product 1');
            expect(aiCallArgs).toContain('Product 2');
            // Remaining 3 should be collapsed
            expect(aiCallArgs).toContain('3 more <li>');
            // Individual items beyond the 2nd should not appear
            expect(aiCallArgs).not.toContain('Product 3');
            expect(aiCallArgs).not.toContain('Product 5');
        });
    });

    describe('AI Provider Integration', () => {
        it('should call Gemini API with correct prompt structure', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Element not found'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.click('#broken');

            expect(mockGeminiGenerateContent).toHaveBeenCalled();
            const callArg = String(mockGeminiGenerateContent.mock.calls[0]![0]);
            expect(callArg).toContain('#broken'); // Original selector in prompt
            expect(callArg).toContain('Element not found'); // Error message in prompt
        });
    });

    describe('Locator Updates', () => {
        it('should update locator file when healing succeeds with a key', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);

            // Use 'app.btn' which our mock LocatorManager recognizes
            await healer.click('app.btn');

            const { LocatorManager } = await import('./utils/LocatorManager.js');
            const manager = LocatorManager.getInstance();
            // Verify updateLocator was called with correct args
            expect(manager.updateLocator).toHaveBeenCalledWith('app.btn', '#healed-selector');
        });
    });

    describe('Error Handling', () => {
        it('should rotate keys on 401 error', async () => {
            const healer = new AutoHealer(mockPage as Page, ['key1', 'key2'], 'gemini');

            // First call fails with 401
            mockGeminiGenerateContent.mockRejectedValueOnce({ status: 401, message: 'Unauthorized' });
            // Second call succeeds
            mockGeminiGenerateContent.mockResolvedValueOnce({ response: { text: () => '#healed-selector' } });

            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout')) // Initial click fails
                .mockResolvedValueOnce(undefined); // Retry succeeds

            await healer.click('#broken');

            // Should have tried twice
            expect(mockGeminiGenerateContent).toHaveBeenCalledTimes(2);
        });

        it('should skip test on 429 Rate Limit when fallback is unavailable', async () => {
            const healer = new AutoHealer(mockPage as Page, 'key1', 'gemini');

            // Setup config to ensure no fallback is possible
            const { config } = await import('./config/index.js');
            const originalOpenAiKeys = config.ai.openai.apiKeys;
            config.ai.openai.apiKeys = undefined as unknown as string[];

            // Fail with 429
            mockGeminiGenerateContent.mockRejectedValueOnce({ status: 429, message: 'Rate Limit Exceeded' });
            (mockPage.click as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Timeout'));

            await healer.click('#broken');

            const { test } = await import('@playwright/test');
            expect(test.skip).toHaveBeenCalledWith(
                true,
                expect.stringContaining('could not find a suitable replacement selector')
            );

            // Restore config
            config.ai.openai.apiKeys = originalOpenAiKeys;
        });

        it('should switch AI provider on 4xx Client Error', async () => {
            const healer = new AutoHealer(mockPage as Page, 'key1', 'gemini');

            const { config } = await import('./config/index.js');
            const originalOpenAiKeys = config.ai.openai.apiKeys;
            config.ai.openai.apiKeys = ['mock-openai-key']; // Enable fallback

            // First call fails with 429 (Gemini)
            mockGeminiGenerateContent.mockRejectedValueOnce({ status: 429, message: 'Rate Limit Exceeded' });

            // Setup second call to succeed (OpenAI)
            const { mockOpenaiCreate } = await import('./test-setup.js');
            mockOpenaiCreate.mockResolvedValueOnce({
                id: 'mock-id',
                model: 'mock-model',
                choices: [{ message: { content: '#healed-selector' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });

            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout')) // Initial click fails
                .mockResolvedValueOnce(undefined); // Retry succeeds

            await healer.click('#broken');

            // Should have tried both providers
            expect(mockGeminiGenerateContent).toHaveBeenCalledTimes(1);
            expect(mockOpenaiCreate).toHaveBeenCalledTimes(1);

            config.ai.openai.apiKeys = originalOpenAiKeys;
        });
    });

    describe('hover()', () => {
        it('should hover successfully without healing when element is found', async () => {
            (mockPage.hover as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.hover('#existing-button');

            expect(mockPage.hover).toHaveBeenCalledTimes(1);
            expect(mockPage.hover).toHaveBeenCalledWith('#existing-button', expect.any(Object));
        });

        it('should attempt healing and retry when hover fails', async () => {
            (mockPage.hover as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.hover('#broken-selector');

            expect(mockPage.hover).toHaveBeenCalledTimes(2);
            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });
    });

    describe('type()', () => {
        it('should type successfully without healing when element is found', async () => {
            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.type('#input-field', 'hello');

            const locatorMock = mockPage.locator as ReturnType<typeof vi.fn>;
            expect(locatorMock).toHaveBeenCalledWith('#input-field');
        });

        it('should pass delay option to pressSequentially', async () => {
            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.type('#input-field', 'hello', { delay: 100 });

            const locatorMock = mockPage.locator as ReturnType<typeof vi.fn>;
            const locatorHandle = locatorMock.mock.results[0]?.value as { pressSequentially: ReturnType<typeof vi.fn> };
            expect(locatorHandle.pressSequentially).toHaveBeenCalledWith(
                'hello',
                expect.objectContaining({ delay: 100 })
            );
        });

        it('should attempt healing and retry when type fails', async () => {
            const pressSequentiallyMock = vi
                .fn()
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const mockLocatorHandle = {
                waitFor: vi.fn().mockResolvedValue(undefined),
                pressSequentially: pressSequentiallyMock,
                count: vi.fn().mockResolvedValue(1),
            };
            (mockPage.locator as ReturnType<typeof vi.fn>).mockReturnValue(mockLocatorHandle);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.type('#broken', 'hello');

            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });
    });

    describe('selectOption()', () => {
        it('should select option successfully without healing', async () => {
            (mockPage.selectOption as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.selectOption('#dropdown', 'option1');

            expect(mockPage.selectOption).toHaveBeenCalledTimes(1);
            expect(mockPage.selectOption).toHaveBeenCalledWith('#dropdown', 'option1', expect.any(Object));
        });

        it('should attempt healing and retry when selectOption fails', async () => {
            (mockPage.selectOption as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.selectOption('#broken-dropdown', 'option1');

            expect(mockPage.selectOption).toHaveBeenCalledTimes(2);
            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });
    });

    describe('check()', () => {
        it('should check successfully without healing', async () => {
            (mockPage.check as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.check('#checkbox');

            expect(mockPage.check).toHaveBeenCalledTimes(1);
            expect(mockPage.check).toHaveBeenCalledWith('#checkbox', expect.any(Object));
        });

        it('should attempt healing and retry when check fails', async () => {
            (mockPage.check as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.check('#broken-checkbox');

            expect(mockPage.check).toHaveBeenCalledTimes(2);
            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });
    });

    describe('uncheck()', () => {
        it('should uncheck successfully without healing', async () => {
            (mockPage.uncheck as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.uncheck('#checkbox');

            expect(mockPage.uncheck).toHaveBeenCalledTimes(1);
            expect(mockPage.uncheck).toHaveBeenCalledWith('#checkbox', expect.any(Object));
        });

        it('should attempt healing and retry when uncheck fails', async () => {
            (mockPage.uncheck as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.uncheck('#broken-checkbox');

            expect(mockPage.uncheck).toHaveBeenCalledTimes(2);
            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });
    });

    describe('waitForSelector()', () => {
        it('should wait for selector successfully without healing', async () => {
            (mockPage.waitForSelector as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.waitForSelector('#element');

            expect(mockPage.waitForSelector).toHaveBeenCalledTimes(1);
            expect(mockPage.waitForSelector).toHaveBeenCalledWith('#element', expect.any(Object));
        });

        it('should attempt healing and retry when waitForSelector fails', async () => {
            (mockPage.waitForSelector as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);
            await healer.waitForSelector('#broken-selector');

            expect(mockPage.waitForSelector).toHaveBeenCalledTimes(2);
            expect(mockGeminiGenerateContent).toHaveBeenCalled();
        });
    });

    describe('getHealingEvents()', () => {
        it('should return empty array initially', () => {
            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            expect(healer.getHealingEvents()).toEqual([]);
        });

        it('should return healing events after a healing attempt', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('TimeoutError'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            await healer.click('#broken');

            const events = healer.getHealingEvents();
            expect(events.length).toBe(1);
            expect(events[0]!.originalSelector).toBe('#broken');
            expect(events[0]!.success).toBe(true);
        });
    });

    describe('healAll()', () => {
        it('should return success for all operations when none fail', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
            (mockPage.fill as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([
                { selectorOrKey: '#btn1', action: 'click' },
                { selectorOrKey: '#input1', action: 'fill', value: 'test' },
            ]);

            expect(results).toHaveLength(2);
            expect(results[0]!.success).toBe(true);
            expect(results[1]!.success).toBe(true);
        });

        it('should heal failed operations and retry them', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Element not found'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#broken-btn', action: 'click' }]);

            expect(results).toHaveLength(1);
            expect(results[0]!.success).toBe(true);
            expect(results[0]!.healedSelector).toBe('#healed-selector');
        });

        it('should report failure when healing returns null', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Element not found'));
            mockGeminiGenerateContent.mockResolvedValue({
                response: { text: () => 'FAIL' },
            });

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#broken-btn', action: 'click' }]);

            expect(results).toHaveLength(1);
            expect(results[0]!.success).toBe(false);
            expect(results[0]!.error).toBe('AI could not find a replacement selector');
        });

        it('should report failure when retry with healed selector also fails', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Element not found'));

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#broken-btn', action: 'click' }]);

            expect(results).toHaveLength(1);
            expect(results[0]!.success).toBe(false);
            expect(results[0]!.healedSelector).toBe('#healed-selector');
            expect(results[0]!.error).toBeDefined();
        });

        it('should update locator when healing succeeds with a locator key', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Element not found'))
                .mockResolvedValueOnce(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            await healer.healAll([{ selectorOrKey: 'app.btn', action: 'click' }]);

            expect(mockLocatorManager.updateLocator).toHaveBeenCalledWith('app.btn', '#healed-selector');
            expect(mockLocatorManager.recordSelectorHealed).toHaveBeenCalledWith('app.btn');
        });

        it('should handle hover action in runOperation', async () => {
            (mockPage.hover as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#link', action: 'hover' }]);

            expect(results[0]!.success).toBe(true);
            expect(mockPage.hover).toHaveBeenCalled();
        });

        it('should handle type action in runOperation', async () => {
            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#input', action: 'type', value: 'text' }]);

            expect(results[0]!.success).toBe(true);
        });

        it('should handle check action in runOperation', async () => {
            (mockPage.check as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#chk', action: 'check' }]);

            expect(results[0]!.success).toBe(true);
            expect(mockPage.check).toHaveBeenCalled();
        });

        it('should handle uncheck action in runOperation', async () => {
            (mockPage.uncheck as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#chk', action: 'uncheck' }]);

            expect(results[0]!.success).toBe(true);
            expect(mockPage.uncheck).toHaveBeenCalled();
        });

        it('should handle waitForSelector action in runOperation', async () => {
            (mockPage.waitForSelector as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#el', action: 'waitForSelector' }]);

            expect(results[0]!.success).toBe(true);
            expect(mockPage.waitForSelector).toHaveBeenCalled();
        });

        it('should handle fill action in runOperation', async () => {
            (mockPage.fill as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            const results = await healer.healAll([{ selectorOrKey: '#input', action: 'fill', value: 'hello' }]);

            expect(results[0]!.success).toBe(true);
            expect(mockPage.fill).toHaveBeenCalledWith('#input', 'hello', expect.any(Object));
        });

        it('should record selector failure for operations with locator keys', async () => {
            (mockPage.click as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Element not found'));
            mockGeminiGenerateContent.mockResolvedValue({
                response: { text: () => 'FAIL' },
            });

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini');
            await healer.healAll([{ selectorOrKey: 'app.btn', action: 'click' }]);

            expect(mockLocatorManager.recordSelectorFailure).toHaveBeenCalledWith('app.btn');
        });
    });

    describe('Confidence Threshold', () => {
        it('should skip test when healed selector matches 0 DOM elements', async () => {
            // First click fails, triggering healing
            (mockPage.click as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
                new Error('TimeoutError: Element not found')
            );

            // AI returns a valid-looking selector
            mockGeminiGenerateContent.mockResolvedValue({
                response: { text: () => '#valid-but-absent' },
            });

            // The locator().count() returns 0 — element not in DOM
            const mockLocatorHandle = {
                waitFor: vi.fn().mockResolvedValue(undefined),
                count: vi.fn().mockResolvedValue(0),
            };
            (mockPage.locator as ReturnType<typeof vi.fn>).mockReturnValue(mockLocatorHandle);

            const healer = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);

            await healer.click('#broken-selector');

            // heal() should reject the selector and executeAction should skip the test
            // unconditionally when no usable replacement selector is found.
            const { test } = await import('@playwright/test');
            expect(test.skip).toHaveBeenCalledWith(
                true,
                expect.stringContaining('could not find a suitable replacement selector')
            );

            // The retry click must NOT have been attempted with the healed selector
            const clickCalls = (mockPage.click as ReturnType<typeof vi.fn>).mock.calls;
            expect(clickCalls).toHaveLength(1); // Only the original failed call
        });
    });

    describe('validateSelector()', () => {
        describe('valid CSS selectors', () => {
            it('should accept a simple element selector', () => {
                expect(validateSelector('button')).toBe(true);
            });

            it('should accept an ID selector', () => {
                expect(validateSelector('#submit-btn')).toBe(true);
            });

            it('should accept a class selector', () => {
                expect(validateSelector('.primary-button')).toBe(true);
            });

            it('should accept a compound selector with descendant combinator', () => {
                expect(validateSelector('form .submit-button')).toBe(true);
            });

            it('should accept a selector with child combinator', () => {
                expect(validateSelector('ul > li.active')).toBe(true);
            });

            it('should accept a selector with a pseudo-class', () => {
                expect(validateSelector('input:focus')).toBe(true);
            });

            it('should accept an attribute selector', () => {
                expect(validateSelector('[data-testid="search-input"]')).toBe(true);
            });

            it('should accept a type + attribute compound selector', () => {
                expect(validateSelector('input[type="text"]')).toBe(true);
            });

            it('should accept a selector with adjacent sibling combinator', () => {
                expect(validateSelector('label + input')).toBe(true);
            });
        });

        describe('valid XPath selectors', () => {
            it('should accept an absolute XPath starting with //', () => {
                expect(validateSelector('//button[@id="submit"]')).toBe(true);
            });

            it('should accept a relative XPath starting with ./', () => {
                expect(validateSelector('./div/span[@class="label"]')).toBe(true);
            });

            it('should accept an XPath with text()', () => {
                expect(validateSelector('//button[text()="Submit"]')).toBe(true);
            });

            it('should accept an XPath with contains()', () => {
                expect(validateSelector('//input[contains(@placeholder,"Search")]')).toBe(true);
            });
        });

        describe('valid Playwright text engine selectors', () => {
            it('should accept text= selector', () => {
                expect(validateSelector('text=Submit')).toBe(true);
            });

            it('should accept role= selector', () => {
                expect(validateSelector('role=button')).toBe(true);
            });

            it('should accept label= selector', () => {
                expect(validateSelector('label=Email address')).toBe(true);
            });

            it('should accept placeholder= selector', () => {
                expect(validateSelector('placeholder=Enter your name')).toBe(true);
            });

            it('should accept alt= selector', () => {
                expect(validateSelector('alt=Company logo')).toBe(true);
            });

            it('should accept title= selector', () => {
                expect(validateSelector('title=Close dialog')).toBe(true);
            });

            it('should accept testid= selector', () => {
                expect(validateSelector('testid=login-form')).toBe(true);
            });

            it('should accept data-testid= selector', () => {
                expect(validateSelector('data-testid=search-input')).toBe(true);
            });

            it('should accept text= with mixed case prefix', () => {
                expect(validateSelector('TEXT=Submit')).toBe(true);
            });
        });

        describe('dangerous patterns — denylist', () => {
            it('should reject javascript: URI', () => {
                expect(validateSelector('javascript:alert(1)')).toBe(false);
            });

            it('should reject javascript: URI with uppercase prefix', () => {
                expect(validateSelector('JavaScript:alert(1)')).toBe(false);
            });

            it('should reject data: URI', () => {
                expect(validateSelector('data:text/html,<h1>hi</h1>')).toBe(false);
            });

            it('should reject a selector containing <script', () => {
                expect(validateSelector('<script>alert(1)</script>')).toBe(false);
            });

            it('should reject a selector containing a closing tag </', () => {
                expect(validateSelector('</div>')).toBe(false);
            });

            it('should reject a selector containing an HTML comment <!--', () => {
                expect(validateSelector('<!-- injected -->')).toBe(false);
            });

            it('should reject a selector containing eval(', () => {
                expect(validateSelector('#id eval(alert(1))')).toBe(false);
            });

            it('should reject a selector containing document.', () => {
                expect(validateSelector('document.getElementById("x")')).toBe(false);
            });

            it('should reject a selector containing window.', () => {
                expect(validateSelector('window.location')).toBe(false);
            });

            it('should reject a selector containing an inline <script tag (no closing slash needed)', () => {
                expect(validateSelector('#id<script>x</script>')).toBe(false);
            });

            it('should reject a selector that starts an HTML comment sequence', () => {
                expect(validateSelector('<!--#id-->')).toBe(false);
            });
        });

        describe('adversarial bypass attempts', () => {
            // ── Protocol bypasses ──────────────────────────────────────────
            it('should reject vbscript: URI (code path: denylist prefix)', () => {
                // vbscript:alert(1) passes the CSS safe-char regex because all its
                // characters are alphanumeric or in the allowed set (:, (, ), digits).
                // The denylist prefix check must fire before the regex allowlist.
                expect(validateSelector('vbscript:alert(1)')).toBe(false);
            });

            it('should reject VBSCRIPT: URI (case-insensitive prefix check)', () => {
                expect(validateSelector('VBSCRIPT:alert(1)')).toBe(false);
            });

            it('should reject vbscript: URI with mixed case', () => {
                expect(validateSelector('VbScRiPt:msgbox(1)')).toBe(false);
            });

            it('should reject javascript: URI with leading BOM character (U+FEFF)', () => {
                // trim() strips BOM — the prefix check must still fire after trim
                expect(validateSelector('\ufeffjavascript:alert(1)')).toBe(false);
            });

            it('should reject data: URI with leading whitespace', () => {
                expect(validateSelector('  data:text/html,<h1>hi</h1>')).toBe(false);
            });

            // ── Injection via newline / control characters ─────────────────
            it('should reject a selector containing a newline before a dangerous keyword', () => {
                // The CSS safe-char regex does not allow \n; this must be rejected
                expect(validateSelector('#id\nwindow.location')).toBe(false);
            });

            it('should reject a selector containing a carriage return', () => {
                expect(validateSelector('#id\reval(x)')).toBe(false);
            });

            it('should reject a selector containing a null byte', () => {
                // Null byte cannot appear in the safe CSS char class
                expect(validateSelector('#id\x00evil')).toBe(false);
            });

            // ── Unicode / lookalike bypasses ───────────────────────────────
            it('should reject a selector with Cyrillic lookalike characters mixed into dangerous payload', () => {
                // Cyrillic 'а' (U+0430) vs ASCII 'a' — not in [a-zA-Z] range so safeCssPattern rejects
                expect(validateSelector('еvаl(аlert(1))')).toBe(false);
            });

            // ── eval() variants ────────────────────────────────────────────
            it('should reject eval( in uppercase (case-insensitive substring check)', () => {
                expect(validateSelector('#id EVAL(alert(1))')).toBe(false);
            });

            it('should reject eval( embedded mid-selector after a valid prefix', () => {
                expect(validateSelector('#btn eval(document.cookie)')).toBe(false);
            });

            // ── document. / window. injection ─────────────────────────────
            it('should reject document. in an XPath string literal', () => {
                // Even inside a valid-looking XPath the denylist must fire
                expect(validateSelector('//div[contains(document.cookie,"x")]')).toBe(false);
            });

            it('should reject window. inside a Playwright text= selector', () => {
                expect(validateSelector('text=window.location')).toBe(false);
            });

            // ── CSS construct bypasses ─────────────────────────────────────
            it('should reject a CSS block with expression() injection', () => {
                // Braces are not in the safe CSS char class
                expect(validateSelector('*{expression(alert(1))}')).toBe(false);
            });

            // ── Chained / multi-payload ────────────────────────────────────
            it('should reject a selector with multiple chained dangerous patterns', () => {
                expect(validateSelector('javascript:eval(document.write("<script>"))')).toBe(false);
            });

            it('should reject a selector that is only dangerous characters with no safe prefix', () => {
                expect(validateSelector('{}[];')).toBe(false);
            });
        });

        describe('edge cases', () => {
            it('should reject an empty string', () => {
                expect(validateSelector('')).toBe(false);
            });

            it('should reject a whitespace-only string', () => {
                expect(validateSelector('   ')).toBe(false);
            });

            it('should reject a selector with only unknown special characters', () => {
                expect(validateSelector('{}')).toBe(false);
            });

            it('should accept a selector with leading/trailing whitespace after trim', () => {
                // Trim is applied internally so surrounding spaces should be fine
                expect(validateSelector('  #submit-btn  ')).toBe(true);
            });
        });

        describe('integration — heal() returns null when selector fails validation', () => {
            it('should treat a malicious AI response as a healing failure', async () => {
                (mockPage.click as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Element not found'));

                // AI returns a dangerous selector
                mockGeminiGenerateContent.mockResolvedValue({
                    response: { text: () => 'javascript:alert(1)' },
                });

                const healerInstance = new AutoHealer(mockPage as Page, 'test-key', 'gemini', undefined, true);

                // heal() returns null for invalid selectors; executeAction then calls test.skip()
                // unconditionally when no usable replacement is found.
                await healerInstance.click('#any-selector');

                const { test } = await import('@playwright/test');
                expect(test.skip).toHaveBeenCalledWith(
                    true,
                    expect.stringContaining('could not find a suitable replacement selector')
                );

                // The retry click must NOT have been called with the malicious selector
                const clickCalls = (mockPage.click as ReturnType<typeof vi.fn>).mock.calls;
                const retryCallArgs = clickCalls.slice(1).flat();
                expect(retryCallArgs).not.toContain('javascript:alert(1)');
            });
        });
    });
});
