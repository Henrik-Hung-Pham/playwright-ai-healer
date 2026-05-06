import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from '@playwright/test';
import { HealingEngine } from './HealingEngine.js';
import type { AIClientManager } from './AIClientManager.js';

// ---------------------------------------------------------------------------
// Hoist controllable mock functions so vi.mock() factories can reference them
// ---------------------------------------------------------------------------

const { mockGetSimplifiedDOM, mockParseAIResponse, mockValidateSelector } = vi.hoisted(() => ({
    mockGetSimplifiedDOM: vi.fn<() => Promise<string>>(),
    mockParseAIResponse: vi.fn<(raw: string | undefined) => string | null>(),
    mockValidateSelector: vi.fn<(selector: string) => boolean>(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@playwright/test', () => ({
    test: {
        info: vi.fn().mockReturnValue({ annotations: [] }),
        skip: vi.fn(),
    },
}));

vi.mock('../utils/Logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/index.js', () => ({
    config: {
        ai: {
            healing: { domSnapshotCharLimit: 2000, confidenceThreshold: 0.7, maxRetries: 3, retryDelay: 100 },
            prompts: { healingPrompt: (_s: string, _e: string, _h: string) => 'mock-prompt' },
        },
        test: { timeouts: { default: 5000 } },
    },
}));

vi.mock('./DOMSerializer.js', () => ({ getSimplifiedDOM: mockGetSimplifiedDOM }));
vi.mock('./ResponseParser.js', () => ({ parseAIResponse: mockParseAIResponse }));
vi.mock('./SelectorValidator.js', () => ({ validateSelector: mockValidateSelector }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPage(elementCount = 1): Page {
    return {
        locator: vi.fn().mockReturnValue({
            count: vi.fn().mockResolvedValue(elementCount),
        }),
    } as unknown as Page;
}

function makeMockClientManager(overrides: Partial<AIClientManager> = {}): AIClientManager {
    return {
        getProvider: vi.fn().mockReturnValue('gemini'),
        getModelName: vi.fn().mockReturnValue('gemini-flash-latest'),
        getKeyCount: vi.fn().mockReturnValue(1),
        getCurrentKeyIndex: vi.fn().mockReturnValue(0),
        makeRequest: vi.fn().mockResolvedValue({ raw: '#healed-selector' }),
        rotateKey: vi.fn().mockReturnValue(false),
        switchProvider: vi.fn().mockReturnValue(false),
        ...overrides,
    } as unknown as AIClientManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HealingEngine', () => {
    let engine: HealingEngine;
    let clientManager: AIClientManager;
    let page: Page;

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSimplifiedDOM.mockResolvedValue('<html><button id="new-btn">Click</button></html>');
        mockParseAIResponse.mockReturnValue('#new-btn');
        mockValidateSelector.mockReturnValue(true);

        clientManager = makeMockClientManager();
        engine = new HealingEngine(clientManager);
        page = makeMockPage(1);
    });

    // ── Success path ─────────────────────────────────────────────────────────

    it('returns a HealingResult when AI suggests a valid selector', async () => {
        const result = await engine.heal(page, '#old-btn', new Error('Element not found'));

        expect(result).not.toBeNull();
        expect(result?.selector).toBe('#new-btn');
        expect(result?.confidence).toBe(1.0);
    });

    it('records a success event after a successful heal', async () => {
        await engine.heal(page, '#old-btn', new Error('not found'));

        const events = engine.getHealingEvents();
        expect(events).toHaveLength(1);
        expect(events[0]?.success).toBe(true);
        expect(events[0]?.originalSelector).toBe('#old-btn');
        expect(events[0]?.result?.selector).toBe('#new-btn');
    });

    // ── Failure paths ─────────────────────────────────────────────────────────

    it('returns null when parseAIResponse returns null (FAIL response)', async () => {
        mockParseAIResponse.mockReturnValue(null);

        const result = await engine.heal(page, '#broken', new Error('not found'));

        expect(result).toBeNull();
    });

    it('records a failure event when AI returns FAIL', async () => {
        mockParseAIResponse.mockReturnValue(null);

        await engine.heal(page, '#broken', new Error('selector failed'));

        const events = engine.getHealingEvents();
        expect(events[0]?.success).toBe(false);
        expect(events[0]?.error).toBe('selector failed');
    });

    it('returns null when validateSelector rejects the AI-suggested selector', async () => {
        mockValidateSelector.mockReturnValue(false);

        const result = await engine.heal(page, '#broken', new Error('not found'));

        expect(result).toBeNull();
    });

    it('returns null when healed selector matches 0 elements on the page', async () => {
        page = makeMockPage(0); // locator().count() → 0

        const result = await engine.heal(page, '#broken', new Error('not found'));

        expect(result).toBeNull();
    });

    // ── Retry and error handling ──────────────────────────────────────────────

    it('retries on 503 server errors and returns null after exhausting retries', async () => {
        vi.useFakeTimers();
        const serverError = Object.assign(new Error('Service Unavailable'), { status: 503 });
        vi.mocked(clientManager.makeRequest).mockRejectedValue(serverError);

        const healPromise = engine.heal(page, '#selector', new Error('timeout'));
        // Advance through all exponential backoff delays
        await vi.runAllTimersAsync();
        const result = await healPromise;

        vi.useRealTimers();
        expect(result).toBeNull();
        // Should have attempted multiple retries
        expect(vi.mocked(clientManager.makeRequest).mock.calls.length).toBeGreaterThan(1);
    });

    it('returns null on 4xx error when no alternate provider is available', async () => {
        const clientError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
        vi.mocked(clientManager.makeRequest).mockRejectedValue(clientError);
        vi.mocked(clientManager.switchProvider).mockReturnValue(false);

        const result = await engine.heal(page, '#selector', new Error('not found'));

        expect(result).toBeNull();
    });

    it('rotates to the next API key on 401 auth error', async () => {
        const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
        vi.mocked(clientManager.makeRequest).mockRejectedValueOnce(authError).mockResolvedValueOnce({ raw: '#healed' });
        vi.mocked(clientManager.rotateKey).mockReturnValue(true);
        vi.mocked(clientManager.getKeyCount).mockReturnValue(2);

        const result = await engine.heal(page, '#selector', new Error('not found'));

        expect(vi.mocked(clientManager.rotateKey)).toHaveBeenCalled();
        expect(result).not.toBeNull();
    });

    // ── getHealingEvents ──────────────────────────────────────────────────────

    it('getHealingEvents returns an empty array initially', () => {
        expect(engine.getHealingEvents()).toEqual([]);
    });

    it('accumulates events across multiple heal calls', async () => {
        await engine.heal(page, '#sel-1', new Error('e1'));
        mockParseAIResponse.mockReturnValue(null);
        await engine.heal(page, '#sel-2', new Error('e2'));

        const events = engine.getHealingEvents();
        expect(events).toHaveLength(2);
        expect(events[0]?.originalSelector).toBe('#sel-1');
        expect(events[1]?.originalSelector).toBe('#sel-2');
    });

    it('includes durationMs and domSnapshotLength in every event', async () => {
        await engine.heal(page, '#sel', new Error('err'));

        const event = engine.getHealingEvents()[0];
        expect(typeof event?.durationMs).toBe('number');
        expect(event?.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof event?.domSnapshotLength).toBe('number');
    });
});
