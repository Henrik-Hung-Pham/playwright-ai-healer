import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MetricsStore } from '../types.js';

/**
 * Selector-quarantine tests.
 *
 * These drive `recordSelectorFailure` across several calls, so the metrics file
 * has to behave like a file: `atomicMetricUpdate` re-reads it from disk under the
 * lock before every mutation, and a stateless `fs` mock would make each call see
 * a pristine store and never reach the threshold. The mock below keeps a virtual
 * filesystem, keyed by filename so no path guessing is needed.
 */
const { virtualFiles, mockConfig } = vi.hoisted(() => ({
    virtualFiles: new Map<string, string>(),
    mockConfig: {
        ai: { healing: { quarantineThreshold: 3 } },
        locatorStore: 'file' as 'file' | 'sqlite',
    },
}));

/** Collapse any absolute path onto the virtual file it represents. */
function fileKey(target: unknown): string {
    const asString = String(target);
    if (asString.endsWith('metrics.json')) return 'metrics';
    if (asString.endsWith('locators.json')) return 'locators';
    return asString;
}

vi.mock('fs', () => ({
    existsSync: (p: unknown) => virtualFiles.has(fileKey(p)),
    readFileSync: (p: unknown) => {
        const contents = virtualFiles.get(fileKey(p));
        if (contents === undefined) throw new Error(`ENOENT: ${String(p)}`);
        return contents;
    },
    writeFileSync: (p: unknown, data: unknown) => {
        virtualFiles.set(fileKey(p), String(data));
    },
    mkdirSync: vi.fn(),
}));

vi.mock('proper-lockfile', () => {
    const lock = vi.fn().mockResolvedValue(() => Promise.resolve());
    return { lock, check: vi.fn(), unlock: vi.fn(), default: { lock, check: vi.fn(), unlock: vi.fn() } };
});

vi.mock('./Logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/index.js', () => ({ config: mockConfig, resetConfigForTesting: vi.fn() }));

const HEALED_AT = '2026-07-01T00:00:00.000Z';

/** Seed the virtual store and return a fresh LocatorManager over it. */
async function managerWith(locators: object, metrics: MetricsStore) {
    virtualFiles.clear();
    virtualFiles.set('locators', JSON.stringify(locators));
    virtualFiles.set('metrics', JSON.stringify(metrics));

    vi.resetModules();
    const { LocatorManager } = await import('./LocatorManager.js');
    LocatorManager.resetInstance();
    return LocatorManager.getInstance();
}

/** Read the persisted metrics entry for a key straight out of the virtual file. */
function persistedMetrics(key: string) {
    return (JSON.parse(virtualFiles.get('metrics') ?? '{}') as MetricsStore)[key];
}

/** Read a persisted selector straight out of the virtual locator file. */
function persistedSelector(section: string, key: string): string | undefined {
    const store = JSON.parse(virtualFiles.get('locators') ?? '{}') as Record<string, Record<string, string>>;
    return store[section]?.[key];
}

/** A key whose selector was healed once, with a recorded rollback target. */
const healedOnce: MetricsStore = {
    'app.btn': { failureCount: 0, healedAt: HEALED_AT, previousSelector: '#original' },
};
const healedLocators = { app: { btn: '#healed' } };

describe('selector quarantine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.ai.healing.quarantineThreshold = 3;
    });

    describe('below the threshold', () => {
        it('counts failures without rolling the selector back', async () => {
            const manager = await managerWith(healedLocators, healedOnce);

            const first = await manager.recordSelectorFailure('app.btn');
            const second = await manager.recordSelectorFailure('app.btn');

            expect(first).toMatchObject({ recorded: true, failureCount: 1, quarantined: false });
            expect(second).toMatchObject({ recorded: true, failureCount: 2, quarantined: false });
            // The healed selector is still in force — two failures is not yet a pattern.
            expect(persistedSelector('app', 'btn')).toBe('#healed');
            expect(persistedMetrics('app.btn')?.healedAt).toBe(HEALED_AT);
        });
    });

    describe('at the threshold', () => {
        it('rolls the selector back to the value the heal replaced', async () => {
            const manager = await managerWith(healedLocators, healedOnce);

            await manager.recordSelectorFailure('app.btn');
            await manager.recordSelectorFailure('app.btn');
            const outcome = await manager.recordSelectorFailure('app.btn');

            expect(outcome.quarantined).toBe(true);
            expect(outcome.revertedTo).toBe('#original');
            expect(outcome.quarantinedSelector).toBe('#healed');
            // The rollback is persisted, not just reported — this is the whole point:
            // a confidently-wrong heal used to live in the store forever.
            expect(persistedSelector('app', 'btn')).toBe('#original');
            expect(manager.getLocator('app.btn')).toBe('#original');
        });

        it('records the rejected selector and clears the heal', async () => {
            const manager = await managerWith(healedLocators, healedOnce);

            for (let i = 0; i < 3; i++) await manager.recordSelectorFailure('app.btn');

            const metrics = persistedMetrics('app.btn');
            expect(metrics?.quarantinedSelector).toBe('#healed');
            expect(metrics?.quarantinedAt).toBeDefined();
            expect(metrics?.quarantineCount).toBe(1);
            // No heal is in force any more, and the revert target has been consumed.
            expect(metrics?.healedAt).toBeUndefined();
            expect(metrics?.previousSelector).toBeUndefined();
            expect(metrics?.failureCount).toBe(0);
        });

        it('stops accruing failures once the heal has been rolled back', async () => {
            const manager = await managerWith(healedLocators, healedOnce);
            for (let i = 0; i < 3; i++) await manager.recordSelectorFailure('app.btn');

            // The restored selector may well keep failing — that is the original
            // defect, not a bad heal — so it must not drive a second quarantine.
            const afterRollback = await manager.recordSelectorFailure('app.btn');

            expect(afterRollback.recorded).toBe(false);
            expect(afterRollback.quarantined).toBe(false);
            expect(persistedSelector('app', 'btn')).toBe('#original');
        });

        it('counts each quarantine cycle so chronic keys are visible', async () => {
            const manager = await managerWith(healedLocators, {
                'app.btn': { failureCount: 0, healedAt: HEALED_AT, previousSelector: '#original', quarantineCount: 2 },
            });

            for (let i = 0; i < 3; i++) await manager.recordSelectorFailure('app.btn');

            expect(persistedMetrics('app.btn')?.quarantineCount).toBe(3);
        });
    });

    describe('keys that must not be rolled back', () => {
        it('ignores a selector that was never healed', async () => {
            const manager = await managerWith({ app: { btn: '#original' } }, { 'app.btn': { failureCount: 0 } });

            const outcome = await manager.recordSelectorFailure('app.btn');

            expect(outcome).toMatchObject({ recorded: false, quarantined: false });
            expect(persistedSelector('app', 'btn')).toBe('#original');
        });

        it('keeps counting when a healed key has no recorded rollback target', async () => {
            // Metrics written before `previousSelector` existed. Reverting to nothing
            // would be worse than leaving the healed selector in place.
            const manager = await managerWith(healedLocators, {
                'app.btn': { failureCount: 0, healedAt: HEALED_AT },
            });

            for (let i = 0; i < 4; i++) await manager.recordSelectorFailure('app.btn');

            expect(persistedSelector('app', 'btn')).toBe('#healed');
            expect(persistedMetrics('app.btn')?.failureCount).toBe(4);
            expect(persistedMetrics('app.btn')?.quarantinedAt).toBeUndefined();
        });
    });

    describe('threshold configuration', () => {
        it('honours SELECTOR_QUARANTINE_THRESHOLD=1 by reverting on the first failure', async () => {
            mockConfig.ai.healing.quarantineThreshold = 1;
            const manager = await managerWith(healedLocators, healedOnce);

            const outcome = await manager.recordSelectorFailure('app.btn');

            expect(outcome.quarantined).toBe(true);
            expect(persistedSelector('app', 'btn')).toBe('#original');
        });

        it('tolerates more failures at a higher threshold', async () => {
            mockConfig.ai.healing.quarantineThreshold = 5;
            const manager = await managerWith(healedLocators, healedOnce);

            for (let i = 0; i < 4; i++) await manager.recordSelectorFailure('app.btn');
            expect(persistedSelector('app', 'btn')).toBe('#healed');

            const fifth = await manager.recordSelectorFailure('app.btn');
            expect(fifth.quarantined).toBe(true);
            expect(persistedSelector('app', 'btn')).toBe('#original');
        });
    });

    describe('recordSelectorHealed', () => {
        it('stores the replaced selector as the rollback target', async () => {
            const manager = await managerWith({ app: { btn: '#healed' } }, {});

            await manager.recordSelectorHealed('app.btn', '#original');

            const metrics = persistedMetrics('app.btn');
            expect(metrics?.previousSelector).toBe('#original');
            expect(metrics?.healedAt).toBeDefined();
            expect(metrics?.failureCount).toBe(0);
        });

        it('resets the failure count so counts are per heal cycle', async () => {
            const manager = await managerWith(healedLocators, {
                'app.btn': { failureCount: 2, healedAt: HEALED_AT, previousSelector: '#older' },
            });

            await manager.recordSelectorHealed('app.btn', '#original');

            expect(persistedMetrics('app.btn')?.failureCount).toBe(0);
            // The rollback target tracks the most recent heal, not the first one.
            expect(persistedMetrics('app.btn')?.previousSelector).toBe('#original');
        });

        it('leaves a heal un-revertable when no previous selector is supplied', async () => {
            const manager = await managerWith({ app: { btn: '#healed' } }, {});

            await manager.recordSelectorHealed('app.btn');

            expect(persistedMetrics('app.btn')?.previousSelector).toBeUndefined();
        });
    });
});
