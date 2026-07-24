import * as fs from 'fs';
import * as path from 'path';
import { logger } from './Logger.js';
import type { HealingEvent, HealingReport, ProviderStats, HealedSelectorEntry } from '../types.js';

// ── Pure aggregation helpers ─────────────────────────────────────────────────
//
// Kept free of instance state so the same logic serves both the per-process
// singleton and `HealingMetrics.buildReport()`, which the Playwright reporter
// uses to aggregate events collected in *other* processes (worker shards).

/** Success rate as a percentage (0-100); 0 when there are no events. */
function computeSuccessRate(events: readonly HealingEvent[]): number {
    if (events.length === 0) return 0;
    return (events.filter(e => e.success).length / events.length) * 100;
}

/** Mean healing duration in milliseconds; 0 when there are no events. */
function computeAverageHealTime(events: readonly HealingEvent[]): number {
    if (events.length === 0) return 0;
    return events.reduce((sum, e) => sum + e.durationMs, 0) / events.length;
}

/** Attempt/success counts keyed by provider. */
function computeProviderBreakdown(events: readonly HealingEvent[]): Record<string, ProviderStats> {
    const breakdown: Record<string, ProviderStats> = {};
    for (const event of events) {
        const stats = (breakdown[event.provider] ??= { attempts: 0, successes: 0 });
        stats.attempts++;
        if (event.success) stats.successes++;
    }
    return breakdown;
}

/** Successfully healed selectors, most frequently healed first. */
function computeSelectorBreakdown(events: readonly HealingEvent[]): HealedSelectorEntry[] {
    const selectorMap = new Map<string, { healed: string; count: number }>();
    for (const event of events) {
        if (!event.success || !event.result) continue;
        const existing = selectorMap.get(event.originalSelector);
        if (existing) {
            existing.count++;
            existing.healed = event.result.selector;
        } else {
            selectorMap.set(event.originalSelector, { healed: event.result.selector, count: 1 });
        }
    }

    return Array.from(selectorMap, ([original, data]) => ({
        original,
        healed: data.healed,
        count: data.count,
    })).sort((a, b) => b.count - a.count);
}

/** Total token spend and its per-provider breakdown. */
function computeTokenUsage(events: readonly HealingEvent[]): { total: number; byProvider: Record<string, number> } {
    let total = 0;
    const byProvider: Record<string, number> = {};

    for (const event of events) {
        if (!event.tokensUsed) continue;
        total += event.tokensUsed.total;
        byProvider[event.provider] = (byProvider[event.provider] ?? 0) + event.tokensUsed.total;
    }

    return { total, byProvider };
}

/**
 * HealingMetrics - Singleton collector for healing event metrics.
 *
 * Records `HealingEvent` objects emitted by `HealingEngine` and provides
 * aggregated statistics such as success rates, timing, provider breakdowns,
 * and token usage. Reports can be exported to JSON for CI artifact collection.
 *
 * @example
 * ```typescript
 * const metrics = HealingMetrics.getInstance();
 * metrics.recordEvent(event);
 * const report = metrics.generateReport();
 * await metrics.exportToJSON('test-results/healing-report.json');
 * ```
 */
export class HealingMetrics {
    private static instance: HealingMetrics;
    private events: HealingEvent[] = [];

    private constructor() {}

    /**
     * Returns the singleton HealingMetrics instance, creating it on first call.
     */
    public static getInstance(): HealingMetrics {
        if (!HealingMetrics.instance) {
            HealingMetrics.instance = new HealingMetrics();
        }
        return HealingMetrics.instance;
    }

    /**
     * Record a healing event for metrics tracking.
     *
     * @param event - The healing event to record
     */
    public recordEvent(event: HealingEvent): void {
        this.events.push(event);
        logger.debug(
            `[HealingMetrics] Recorded event: selector="${event.originalSelector}" success=${event.success} provider=${event.provider}`
        );
    }

    /**
     * Get the healing success rate as a percentage (0-100).
     *
     * @returns Success rate percentage, or 0 if no events recorded
     */
    public getSuccessRate(): number {
        return computeSuccessRate(this.events);
    }

    /**
     * Get the average healing duration in milliseconds.
     *
     * @returns Average heal time in ms, or 0 if no events recorded
     */
    public getAverageHealTime(): number {
        return computeAverageHealTime(this.events);
    }

    /**
     * Get healing statistics broken down by AI provider.
     *
     * @returns Map of provider name to attempt/success counts
     */
    public getProviderBreakdown(): Record<string, ProviderStats> {
        return computeProviderBreakdown(this.events);
    }

    /**
     * Get the most frequently healed selectors, sorted by count descending.
     *
     * @returns Array of selector healing entries
     */
    public getSelectorBreakdown(): HealedSelectorEntry[] {
        return computeSelectorBreakdown(this.events);
    }

    /**
     * Get total token usage and per-provider breakdown.
     *
     * @returns Token usage statistics
     */
    public getTokenUsage(): {
        total: number;
        byProvider: Record<string, number>;
    } {
        return computeTokenUsage(this.events);
    }

    /**
     * Build a report from an arbitrary set of healing events.
     *
     * Exposed as a static so callers outside this process's singleton can
     * aggregate events they collected elsewhere — specifically `HealingReporter`,
     * which runs in Playwright's main process and merges the per-worker shards
     * that each worker's `HealingMetrics` singleton flushed to disk.
     *
     * @param events - Events to aggregate. An empty array yields a zeroed report.
     */
    public static buildReport(events: readonly HealingEvent[]): HealingReport {
        const successCount = events.filter(e => e.success).length;
        const tokenUsage = computeTokenUsage(events);

        return {
            totalEvents: events.length,
            successCount,
            failureCount: events.length - successCount,
            successRate: computeSuccessRate(events),
            averageHealTimeMs: computeAverageHealTime(events),
            totalTokensUsed: tokenUsage.total,
            providerStats: computeProviderBreakdown(events),
            topHealedSelectors: computeSelectorBreakdown(events),
            tokenUsage,
            generatedAt: new Date().toISOString(),
        };
    }

    /**
     * Generate a complete healing report aggregating all recorded metrics.
     *
     * @returns A typed `HealingReport` object
     */
    public generateReport(): HealingReport {
        return HealingMetrics.buildReport(this.events);
    }

    /**
     * Export the healing report to a JSON file.
     *
     * Creates parent directories if they do not exist.
     *
     * @param filePath - Absolute or relative path to write the JSON report
     */
    public exportToJSON(filePath: string): void {
        const report = this.generateReport();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(report, null, 4), 'utf-8');
        logger.info(`[HealingMetrics] Report exported to ${filePath}`);
    }

    /**
     * Clear all recorded events. Useful between test suites.
     */
    public reset(): void {
        this.events = [];
        logger.debug('[HealingMetrics] All metrics cleared.');
    }

    /**
     * Get a read-only copy of all recorded events.
     *
     * @returns Array of recorded healing events
     */
    public getEvents(): readonly HealingEvent[] {
        return this.events;
    }

    /**
     * Reset the singleton instance. Intended for testing only.
     * @internal
     */
    public static resetInstance(): void {
        HealingMetrics.instance = undefined as unknown as HealingMetrics;
    }
}
