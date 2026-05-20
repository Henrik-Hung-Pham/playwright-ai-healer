import * as fs from 'fs';
import * as path from 'path';
import { logger } from './Logger.js';
import type { HealingEvent, HealingReport, ProviderStats, HealedSelectorEntry } from '../types.js';

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
        if (this.events.length === 0) return 0;
        const successes = this.events.filter(e => e.success).length;
        return (successes / this.events.length) * 100;
    }

    /**
     * Get the average healing duration in milliseconds.
     *
     * @returns Average heal time in ms, or 0 if no events recorded
     */
    public getAverageHealTime(): number {
        if (this.events.length === 0) return 0;
        const totalMs = this.events.reduce((sum, e) => sum + e.durationMs, 0);
        return totalMs / this.events.length;
    }

    /**
     * Get healing statistics broken down by AI provider.
     *
     * @returns Map of provider name to attempt/success counts
     */
    public getProviderBreakdown(): Record<string, ProviderStats> {
        const breakdown: Record<string, ProviderStats> = {};
        for (const event of this.events) {
            const provider = event.provider;
            if (!breakdown[provider]) {
                breakdown[provider] = { attempts: 0, successes: 0 };
            }
            const stats = breakdown[provider];
            stats.attempts++;
            if (event.success) {
                stats.successes++;
            }
        }
        return breakdown;
    }

    /**
     * Get the most frequently healed selectors, sorted by count descending.
     *
     * @returns Array of selector healing entries
     */
    public getSelectorBreakdown(): HealedSelectorEntry[] {
        const selectorMap = new Map<string, { healed: string; count: number }>();
        for (const event of this.events) {
            if (event.success && event.result) {
                const key = event.originalSelector;
                const existing = selectorMap.get(key);
                if (existing) {
                    existing.count++;
                    existing.healed = event.result.selector;
                } else {
                    selectorMap.set(key, {
                        healed: event.result.selector,
                        count: 1,
                    });
                }
            }
        }

        const entries: HealedSelectorEntry[] = [];
        for (const [original, data] of selectorMap) {
            entries.push({
                original,
                healed: data.healed,
                count: data.count,
            });
        }

        return entries.sort((a, b) => b.count - a.count);
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
        let total = 0;
        const byProvider: Record<string, number> = {};

        for (const event of this.events) {
            if (event.tokensUsed) {
                total += event.tokensUsed.total;
                const provider = event.provider;
                byProvider[provider] = (byProvider[provider] ?? 0) + event.tokensUsed.total;
            }
        }

        return { total, byProvider };
    }

    /**
     * Generate a complete healing report aggregating all recorded metrics.
     *
     * @returns A typed `HealingReport` object
     */
    public generateReport(): HealingReport {
        const successCount = this.events.filter(e => e.success).length;
        const failureCount = this.events.length - successCount;
        const tokenUsage = this.getTokenUsage();

        return {
            totalEvents: this.events.length,
            successCount,
            failureCount,
            successRate: this.getSuccessRate(),
            averageHealTimeMs: this.getAverageHealTime(),
            totalTokensUsed: tokenUsage.total,
            providerStats: this.getProviderBreakdown(),
            topHealedSelectors: this.getSelectorBreakdown(),
            tokenUsage,
            generatedAt: new Date().toISOString(),
        };
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
