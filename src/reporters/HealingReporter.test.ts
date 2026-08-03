import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import HealingReporter, { HEALING_SHARD_DIR, HEALING_REPORT_PATH } from './HealingReporter.js';
import type { HealingEvent, HealingReport } from '../types.js';

vi.mock('../utils/Logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Build a healing event with sensible defaults. */
function makeEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
    return {
        timestamp: '2026-07-25T00:00:00.000Z',
        originalSelector: '#old',
        result: { selector: '#new', confidence: 1, reasoning: 'r', strategy: 'id' },
        success: true,
        provider: 'gemini',
        durationMs: 100,
        domSnapshotLength: 500,
        ...overrides,
    };
}

describe('HealingReporter', () => {
    let cwd: string;
    let tmpDir: string;

    beforeEach(() => {
        // The reporter resolves its paths relative to cwd, so run each test in
        // a throwaway directory rather than polluting the repo's test-results/.
        cwd = process.cwd();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healing-reporter-'));
        process.chdir(tmpDir);
    });

    afterEach(() => {
        process.chdir(cwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Write a worker shard exactly as the `healingMetricsShard` fixture does. */
    function writeShard(name: string, events: HealingEvent[]): void {
        fs.mkdirSync(HEALING_SHARD_DIR, { recursive: true });
        fs.writeFileSync(path.join(HEALING_SHARD_DIR, name), JSON.stringify(events), 'utf-8');
    }

    function readReport(): HealingReport {
        return JSON.parse(fs.readFileSync(HEALING_REPORT_PATH, 'utf-8')) as HealingReport;
    }

    it('merges shards from multiple workers into one report', () => {
        writeShard('worker-0-111.json', [makeEvent(), makeEvent({ success: false, result: null })]);
        writeShard('worker-1-222.json', [makeEvent({ provider: 'openai' })]);

        new HealingReporter().onEnd();

        const report = readReport();
        expect(report.totalEvents).toBe(3);
        expect(report.successCount).toBe(2);
        expect(report.failureCount).toBe(1);
        expect(report.providerStats['gemini']).toEqual({ attempts: 2, successes: 1 });
        expect(report.providerStats['openai']).toEqual({ attempts: 1, successes: 1 });
    });

    it('writes a zeroed report when no healing happened', () => {
        new HealingReporter().onEnd();

        const report = readReport();
        expect(report.totalEvents).toBe(0);
        expect(report.successRate).toBe(0);
    });

    it('clears stale shards in onBegin so a run cannot inherit old numbers', () => {
        writeShard('worker-0-999.json', [makeEvent(), makeEvent()]);

        const reporter = new HealingReporter();
        reporter.onBegin();
        reporter.onEnd();

        expect(readReport().totalEvents).toBe(0);
    });

    it('skips an unreadable shard rather than failing the run', () => {
        writeShard('good.json', [makeEvent()]);
        fs.writeFileSync(path.join(HEALING_SHARD_DIR, 'bad.json'), '{ not json', 'utf-8');

        expect(() => new HealingReporter().onEnd()).not.toThrow();
        expect(readReport().totalEvents).toBe(1);
    });

    it('ignores non-JSON files in the shard directory', () => {
        writeShard('worker-0-111.json', [makeEvent()]);
        fs.writeFileSync(path.join(HEALING_SHARD_DIR, 'notes.txt'), 'ignore me', 'utf-8');

        new HealingReporter().onEnd();

        expect(readReport().totalEvents).toBe(1);
    });

    it('aggregates token usage across workers', () => {
        writeShard('worker-0-111.json', [makeEvent({ tokensUsed: { prompt: 10, completion: 5, total: 15 } })]);
        writeShard('worker-1-222.json', [
            makeEvent({ provider: 'openai', tokensUsed: { prompt: 20, completion: 5, total: 25 } }),
        ]);

        new HealingReporter().onEnd();

        const report = readReport();
        expect(report.totalTokensUsed).toBe(40);
        expect(report.tokenUsage.byProvider).toEqual({ gemini: 15, openai: 25 });
    });

    it('reports to stdio', () => {
        expect(new HealingReporter().printsToStdio()).toBe(true);
    });
});
