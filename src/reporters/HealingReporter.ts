import * as fs from 'fs';
import * as path from 'path';
import type { Reporter } from '@playwright/test/reporter';
import { HealingMetrics } from '../utils/HealingMetrics.js';
import type { HealingEvent } from '../types.js';

/**
 * Directory into which each Playwright worker flushes the healing events it
 * recorded. Written by the `healingMetricsShard` worker fixture in
 * `tests/fixtures/base.ts`, consumed by {@link HealingReporter}.
 */
export const HEALING_SHARD_DIR = path.join('test-results', 'healing-metrics');

/** Path of the merged, run-wide healing report. */
export const HEALING_REPORT_PATH = path.join('test-results', 'healing-report.json');

/**
 * Aggregates healing metrics across all Playwright workers into a single report.
 *
 * `HealingMetrics` is a per-process singleton, and Playwright runs tests in
 * worker processes while reporters run in the main process — so the reporter
 * cannot read the workers' in-memory events directly. The flow is therefore:
 *
 * 1. `HealingEngine` records each `HealingEvent` into the worker's `HealingMetrics`.
 * 2. A worker-scoped auto fixture flushes that worker's events to a shard file
 *    in {@link HEALING_SHARD_DIR} during teardown.
 * 3. This reporter merges every shard in `onEnd` and writes {@link HEALING_REPORT_PATH}.
 *
 * Before this existed, `HealingMetrics` collected events into a singleton that
 * nothing ever read: `exportToJSON()` was called only from unit tests, so a full
 * CI run produced no healing artifact at all.
 */
export default class HealingReporter implements Reporter {
    /** This reporter writes a summary to stdout. */
    printsToStdio(): boolean {
        return true;
    }

    /**
     * Clear shards left over from a previous run so a run that heals nothing
     * cannot inherit a stale predecessor's numbers.
     */
    onBegin(): void {
        try {
            fs.rmSync(HEALING_SHARD_DIR, { recursive: true, force: true });
        } catch {
            // Non-fatal: a stale shard would skew the report but must never
            // fail the test run itself.
        }
    }

    /** Merge worker shards, write the report, and print a short summary. */
    onEnd(): void {
        const events = this.readShards();
        const report = HealingMetrics.buildReport(events);

        try {
            fs.mkdirSync(path.dirname(HEALING_REPORT_PATH), { recursive: true });
            fs.writeFileSync(HEALING_REPORT_PATH, JSON.stringify(report, null, 4), 'utf-8');
        } catch (error) {
            console.error(`[HealingReporter] Failed to write ${HEALING_REPORT_PATH}: ${String(error)}`);
            return;
        }

        if (report.totalEvents === 0) {
            console.log('\n🏥 Healing report: no healing was attempted in this run.');
            console.log(`   Written to ${HEALING_REPORT_PATH}\n`);
            return;
        }

        const lines = [
            '',
            '🏥 Healing report',
            `   Attempts      ${report.totalEvents} (${report.successCount} healed, ${report.failureCount} failed)`,
            `   Success rate  ${report.successRate.toFixed(1)}%`,
            `   Avg heal time ${Math.round(report.averageHealTimeMs)}ms`,
            `   Tokens used   ${report.totalTokensUsed}`,
        ];

        for (const [provider, stats] of Object.entries(report.providerStats)) {
            lines.push(`   ${provider.padEnd(13)} ${stats.successes}/${stats.attempts} succeeded`);
        }

        for (const entry of report.topHealedSelectors.slice(0, 5)) {
            lines.push(`   ↳ ${entry.original} → ${entry.healed} (×${entry.count})`);
        }

        lines.push(`   Written to ${HEALING_REPORT_PATH}`, '');
        console.log(lines.join('\n'));
    }

    /**
     * Read and concatenate every worker shard.
     *
     * A malformed or unreadable shard is skipped with a warning rather than
     * failing the run — a metrics artifact must never be the reason CI goes red.
     */
    private readShards(): HealingEvent[] {
        if (!fs.existsSync(HEALING_SHARD_DIR)) return [];

        const events: HealingEvent[] = [];
        for (const file of fs.readdirSync(HEALING_SHARD_DIR)) {
            if (!file.endsWith('.json')) continue;
            const full = path.join(HEALING_SHARD_DIR, file);
            try {
                const parsed: unknown = JSON.parse(fs.readFileSync(full, 'utf-8'));
                if (Array.isArray(parsed)) events.push(...(parsed as HealingEvent[]));
            } catch (error) {
                console.warn(`[HealingReporter] Skipping unreadable shard ${file}: ${String(error)}`);
            }
        }
        return events;
    }
}
