// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { mockGeminiGenerateContent } from './test-setup.js';
import { AutoHealer } from './AutoHealer.js';
import { config } from './config/index.js';

/**
 * `HEALING_MODE` behaviour.
 *
 * The three modes differ in *how far* a failed interaction is allowed to travel:
 *
 *   off     — no snapshot, no request, no record; the original error propagates
 *   suggest — heal and record, but do not retry and do not persist
 *   apply   — heal, retry, persist (the historical behaviour)
 *
 * `suggest` is the one that changes CI semantics: under `apply` a heal that
 * succeeds against a genuinely broken feature turns a real regression green, so
 * these tests pin down that the original error still surfaces.
 */

const { mockLocatorManager } = vi.hoisted(() => ({
    mockLocatorManager: {
        getLocator: vi.fn((key: string) => (key === 'app.btn' ? '#old-selector' : null)),
        updateLocator: vi.fn().mockResolvedValue(undefined),
        recordSelectorFailure: vi.fn().mockResolvedValue({ recorded: true, failureCount: 1, quarantined: false }),
        recordSelectorHealed: vi.fn(),
        getFingerprint: vi.fn(() => null),
    },
}));

vi.mock('./utils/LocatorManager.js', () => ({
    LocatorManager: { getInstance: vi.fn(() => mockLocatorManager) },
}));

/** A page whose `click` always fails, so every test exercises the healing path. */
const createFailingPage = (): Partial<Page> => {
    const handle = {
        waitFor: vi.fn().mockResolvedValue(undefined),
        pressSequentially: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(1),
    };
    return {
        click: vi.fn().mockRejectedValue(new Error('locator.click: Timeout 5000ms exceeded')),
        fill: vi.fn(),
        evaluate: vi.fn().mockResolvedValue('<html><body><button id="new-btn">Click</button></body></html>'),
        locator: vi.fn().mockReturnValue(handle),
    } as unknown as Partial<Page>;
};

describe('AutoHealer — HEALING_MODE', () => {
    let page: Partial<Page>;
    const originalMode = config.ai.healing.mode;

    beforeEach(() => {
        vi.clearAllMocks();
        page = createFailingPage();
        mockGeminiGenerateContent.mockResolvedValue({ response: { text: () => '#new-btn' } });
    });

    afterEach(() => {
        config.ai.healing.mode = originalMode;
    });

    describe('off', () => {
        beforeEach(() => {
            config.ai.healing.mode = 'off';
        });

        it('propagates the original Playwright error untouched', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            // Not wrapped in an "[AutoHealer] …" message — the caller sees exactly
            // what Playwright raised.
            await expect(healer.click('#missing')).rejects.toThrow('locator.click: Timeout 5000ms exceeded');
        });

        it('never contacts the AI provider', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('#missing')).rejects.toThrow();
            expect(mockGeminiGenerateContent).not.toHaveBeenCalled();
        });

        it('never captures a DOM snapshot', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('#missing')).rejects.toThrow();
            // page.evaluate is how getSimplifiedDOM reads the page; no request
            // means no page content leaves the process.
            expect(page.evaluate).not.toHaveBeenCalled();
        });

        it('records no healing event', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('#missing')).rejects.toThrow();
            expect(healer.getHealingEvents()).toHaveLength(0);
        });

        it('does not record a selector failure against the locator store', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('app.btn')).rejects.toThrow();
            expect(mockLocatorManager.recordSelectorFailure).not.toHaveBeenCalled();
        });

        it('reports healAll failures without healing them', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            const results = await healer.healAll([{ selectorOrKey: '#missing', action: 'click' }]);

            expect(results[0]?.success).toBe(false);
            expect(results[0]?.healedSelector).toBeUndefined();
            expect(mockGeminiGenerateContent).not.toHaveBeenCalled();
        });
    });

    describe('suggest', () => {
        beforeEach(() => {
            config.ai.healing.mode = 'suggest';
        });

        it('still fails the test with the original error', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            // The whole point: a heal is available, and the test fails anyway.
            await expect(healer.click('#missing')).rejects.toThrow('locator.click: Timeout 5000ms exceeded');
        });

        it('does contact the provider and record the heal', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('#missing')).rejects.toThrow();

            expect(mockGeminiGenerateContent).toHaveBeenCalled();
            const event = healer.getHealingEvents().at(-1);
            expect(event?.success).toBe(true);
            expect(event?.result?.selector).toBe('#new-btn');
        });

        it('does not retry the action with the healed selector', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('#missing')).rejects.toThrow();

            // Exactly one attempt: the original. A retry would be a second call.
            expect(page.click).toHaveBeenCalledTimes(1);
        });

        it('does not persist the healed selector', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('app.btn')).rejects.toThrow();

            expect(mockLocatorManager.updateLocator).not.toHaveBeenCalled();
            expect(mockLocatorManager.recordSelectorHealed).not.toHaveBeenCalled();
        });

        it('returns the suggestion alongside the failure in healAll', async () => {
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            const results = await healer.healAll([{ selectorOrKey: '#missing', action: 'click' }]);

            expect(results[0]?.success).toBe(false);
            expect(results[0]?.healedSelector).toBe('#new-btn');
            expect(mockLocatorManager.updateLocator).not.toHaveBeenCalled();
        });

        it('fails with the original error when no selector could be found', async () => {
            mockGeminiGenerateContent.mockResolvedValue({ response: { text: () => 'FAIL' } });
            const healer = new AutoHealer(page as Page, 'key', 'gemini');

            await expect(healer.click('#missing')).rejects.toThrow('locator.click: Timeout 5000ms exceeded');
        });
    });

    describe('apply', () => {
        beforeEach(() => {
            config.ai.healing.mode = 'apply';
        });

        it('retries with the healed selector and persists it', async () => {
            // First call (original selector) fails, retry with the healed one succeeds.
            const click = vi
                .fn()
                .mockRejectedValueOnce(new Error('locator.click: Timeout 5000ms exceeded'))
                .mockResolvedValueOnce(undefined);
            page.click = click as unknown as Page['click'];

            const healer = new AutoHealer(page as Page, 'key', 'gemini');
            await healer.click('app.btn');

            expect(click).toHaveBeenCalledTimes(2);
            expect(mockLocatorManager.updateLocator).toHaveBeenCalledWith('app.btn', '#new-btn');
        });
    });
});
