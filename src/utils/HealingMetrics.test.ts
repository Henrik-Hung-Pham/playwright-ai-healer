import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HealingMetrics } from './HealingMetrics.js';
import type { HealingEvent } from '../types.js';

// Mock fs and path for exportToJSON
vi.mock('fs', () => ({
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

function makeEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
    return {
        timestamp: new Date().toISOString(),
        originalSelector: '#broken',
        result: { selector: '#fixed', confidence: 1.0, reasoning: 'AI fix', strategy: 'css' },
        success: true,
        provider: 'gemini',
        durationMs: 1500,
        tokensUsed: { prompt: 100, completion: 50, total: 150 },
        domSnapshotLength: 5000,
        ...overrides,
    };
}

describe('HealingMetrics', () => {
    beforeEach(() => {
        HealingMetrics.resetInstance();
    });

    it('should be a singleton', () => {
        const a = HealingMetrics.getInstance();
        const b = HealingMetrics.getInstance();
        expect(a).toBe(b);
    });

    it('should record events', () => {
        const metrics = HealingMetrics.getInstance();
        const event = makeEvent();
        metrics.recordEvent(event);
        expect(metrics.getEvents()).toHaveLength(1);
        expect(metrics.getEvents()[0]).toBe(event);
    });

    describe('getSuccessRate', () => {
        it('should return 0 when no events recorded', () => {
            expect(HealingMetrics.getInstance().getSuccessRate()).toBe(0);
        });

        it('should calculate correct success rate', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent({ success: true }));
            metrics.recordEvent(makeEvent({ success: true }));
            metrics.recordEvent(makeEvent({ success: false }));
            expect(metrics.getSuccessRate()).toBeCloseTo(66.67, 1);
        });

        it('should return 100 when all succeed', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent({ success: true }));
            metrics.recordEvent(makeEvent({ success: true }));
            expect(metrics.getSuccessRate()).toBe(100);
        });

        it('should return 0 when all fail', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent({ success: false }));
            metrics.recordEvent(makeEvent({ success: false }));
            expect(metrics.getSuccessRate()).toBe(0);
        });
    });

    describe('getAverageHealTime', () => {
        it('should return 0 when no events', () => {
            expect(HealingMetrics.getInstance().getAverageHealTime()).toBe(0);
        });

        it('should calculate average', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent({ durationMs: 1000 }));
            metrics.recordEvent(makeEvent({ durationMs: 3000 }));
            expect(metrics.getAverageHealTime()).toBe(2000);
        });
    });

    describe('getProviderBreakdown', () => {
        it('should break down by provider', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent({ provider: 'gemini', success: true }));
            metrics.recordEvent(makeEvent({ provider: 'gemini', success: false }));
            metrics.recordEvent(makeEvent({ provider: 'openai', success: true }));

            const breakdown = metrics.getProviderBreakdown();
            expect(breakdown['gemini']).toEqual({ attempts: 2, successes: 1 });
            expect(breakdown['openai']).toEqual({ attempts: 1, successes: 1 });
        });
    });

    describe('getSelectorBreakdown', () => {
        it('should track most healed selectors', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(
                makeEvent({
                    originalSelector: '#btn-a',
                    result: { selector: '#btn-a-fixed', confidence: 1, reasoning: '', strategy: 'css' },
                    success: true,
                })
            );
            metrics.recordEvent(
                makeEvent({
                    originalSelector: '#btn-a',
                    result: { selector: '#btn-a-fixed-v2', confidence: 1, reasoning: '', strategy: 'css' },
                    success: true,
                })
            );
            metrics.recordEvent(
                makeEvent({
                    originalSelector: '#btn-b',
                    result: { selector: '#btn-b-fixed', confidence: 1, reasoning: '', strategy: 'css' },
                    success: true,
                })
            );
            // Failed events should not appear in selector breakdown
            metrics.recordEvent(makeEvent({ originalSelector: '#btn-c', success: false, result: null }));

            const breakdown = metrics.getSelectorBreakdown();
            expect(breakdown[0]!.original).toBe('#btn-a');
            expect(breakdown[0]!.count).toBe(2);
            expect(breakdown[1]!.original).toBe('#btn-b');
            expect(breakdown[1]!.count).toBe(1);
            expect(breakdown).toHaveLength(2);
        });
    });

    describe('getTokenUsage', () => {
        it('should aggregate token usage', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(
                makeEvent({
                    provider: 'gemini',
                    tokensUsed: { prompt: 100, completion: 50, total: 150 },
                })
            );
            metrics.recordEvent(
                makeEvent({
                    provider: 'openai',
                    tokensUsed: { prompt: 200, completion: 100, total: 300 },
                })
            );
            // Event without tokensUsed — should not contribute to totals
            const noTokenEvent: HealingEvent = {
                timestamp: new Date().toISOString(),
                originalSelector: '#no-tokens',
                success: true,
                provider: 'gemini',
                durationMs: 500,
                domSnapshotLength: 1000,
                result: null,
            };
            metrics.recordEvent(noTokenEvent);

            const usage = metrics.getTokenUsage();
            expect(usage.total).toBe(450);
            expect(usage.byProvider['gemini']).toBe(150);
            expect(usage.byProvider['openai']).toBe(300);
        });
    });

    describe('generateReport', () => {
        it('should aggregate all metrics into a report', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent({ success: true, durationMs: 1000 }));
            metrics.recordEvent(makeEvent({ success: false, durationMs: 2000, result: null }));

            const report = metrics.generateReport();
            expect(report.totalEvents).toBe(2);
            expect(report.successCount).toBe(1);
            expect(report.failureCount).toBe(1);
            expect(report.successRate).toBe(50);
            expect(report.averageHealTimeMs).toBe(1500);
            expect(report.generatedAt).toBeDefined();
            expect(report.providerStats).toBeDefined();
            expect(report.topHealedSelectors).toBeDefined();
            expect(report.tokenUsage).toBeDefined();
        });
    });

    describe('exportToJSON', () => {
        it('should write report to file', async () => {
            const fs = await import('fs');
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent());

            metrics.exportToJSON('/tmp/test-report.json');

            expect(fs.writeFileSync).toHaveBeenCalledWith(
                '/tmp/test-report.json',
                expect.stringContaining('"totalEvents": 1'),
                'utf-8'
            );
        });

        it('should create directory if missing', async () => {
            const fs = await import('fs');
            vi.mocked(fs.existsSync).mockReturnValueOnce(false);

            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent());
            metrics.exportToJSON('/new/dir/report.json');

            expect(fs.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true });
        });
    });

    describe('reset', () => {
        it('should clear all events', () => {
            const metrics = HealingMetrics.getInstance();
            metrics.recordEvent(makeEvent());
            metrics.recordEvent(makeEvent());
            expect(metrics.getEvents()).toHaveLength(2);

            metrics.reset();
            expect(metrics.getEvents()).toHaveLength(0);
            expect(metrics.getSuccessRate()).toBe(0);
        });
    });
});
