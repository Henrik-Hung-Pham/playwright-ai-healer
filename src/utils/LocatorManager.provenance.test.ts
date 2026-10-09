import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import type { HealProvenance } from '../types.js';

/**
 * Heal provenance, revert, and auto-revert.
 *
 * `updateLocator` is a destructive overwrite: a human-authored selector is
 * replaced in place by a model-authored one. Before this, nothing recorded what
 * the previous value was, which model replaced it, or how confident the scorer
 * had been — so a wrong heal was permanent and unreviewable.
 *
 * `fs` is replaced with an in-memory filesystem rather than mocked per-call.
 * Read-after-write consistency is essential here: `atomicMetricUpdate` re-reads
 * the metrics file under the lock before every mutation, so a mock that always
 * replays a fixed fixture would discard each write and quietly test nothing.
 *
 * A temp *directory* is not an option: `LocatorManager` resolves both files
 * relative to its own module directory, with no injection point. An earlier
 * draft of this file therefore wrote into the real `src/config/locators.json`
 * and `metrics.json` — which is exactly how the `test.concurrentString` entry
 * got committed twice, and precisely what the schema guard added alongside this
 * work exists to catch.
 */

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

/** Key by basename: the manager resolves absolute paths we do not control. */
const keyOf = (p: string): string => path.basename(String(p));

vi.mock('fs', () => ({
    existsSync: (p: string) => files.has(keyOf(p)),
    readFileSync: (p: string) => {
        const contents = files.get(keyOf(p));
        if (contents === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return contents;
    },
    writeFileSync: (p: string, data: string) => {
        files.set(keyOf(p), String(data));
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

/** Build a provenance record with sensible defaults. */
const provenanceOf = (previousSelector: string, healedSelector: string): HealProvenance => ({
    previousSelector,
    healedSelector,
    healedAt: new Date().toISOString(),
    provider: 'gemini',
    model: 'gemma-4-31b-it',
    confidence: 0.9,
    strategy: 'id',
});

describe('LocatorManager — heal provenance', () => {
    let manager: import('./LocatorManager.js').LocatorManager;

    beforeEach(async () => {
        vi.resetModules();
        process.env['GEMINI_API_KEY'] = 'test-key';

        files.clear();
        files.set('locators.json', JSON.stringify({ app: { loginButton: '#login-btn' } }, null, 2));
        files.set('metrics.json', '{}');

        const { LocatorManager } = await import('./LocatorManager.js');
        LocatorManager.resetInstance();
        manager = LocatorManager.getInstance();
    });

    describe('recordSelectorHealed', () => {
        it('stores the audit trail for a heal', async () => {
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#login-btn', '#signin-btn'));

            const history = manager.getProvenance('app.loginButton');
            expect(history).toHaveLength(1);
            expect(history[0]).toMatchObject({
                previousSelector: '#login-btn',
                healedSelector: '#signin-btn',
                provider: 'gemini',
                model: 'gemma-4-31b-it',
                confidence: 0.9,
                strategy: 'id',
            });
        });

        it('accumulates successive heals oldest-first', async () => {
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#a', '#b'));
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#b', '#c'));

            expect(manager.getProvenance('app.loginButton').map(h => h.healedSelector)).toEqual(['#b', '#c']);
        });

        it('caps history so metrics.json cannot grow without bound', async () => {
            for (let i = 0; i < 15; i++) {
                await manager.recordSelectorHealed('app.loginButton', provenanceOf(`#s${i}`, `#s${i + 1}`));
            }

            const history = manager.getProvenance('app.loginButton');
            expect(history).toHaveLength(10);
            // Oldest evicted, newest retained — a revert only needs the newest.
            expect(history.at(-1)?.healedSelector).toBe('#s15');
        });

        it('remains backwards compatible when no provenance is supplied', async () => {
            await manager.recordSelectorHealed('app.loginButton');

            expect(manager.getProvenance('app.loginButton')).toEqual([]);
            expect(manager.getMetrics('app.loginButton').healedAt).toBeDefined();
        });

        it('returns an empty history for a key that was never healed', () => {
            expect(manager.getProvenance('app.unknown')).toEqual([]);
        });
    });

    describe('revertLocator', () => {
        it('restores the selector the heal replaced', async () => {
            await manager.updateLocator('app.loginButton', '#signin-btn');
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#login-btn', '#signin-btn'));

            const restored = await manager.revertLocator('app.loginButton');

            expect(restored).toBe('#login-btn');
            expect(manager.getLocator('app.loginButton')).toBe('#login-btn');
        });

        it('pops the reverted entry so repeated calls walk back through heals', async () => {
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#v1', '#v2'));
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#v2', '#v3'));

            expect(await manager.revertLocator('app.loginButton')).toBe('#v2');
            expect(await manager.revertLocator('app.loginButton')).toBe('#v1');
            // Nothing left to undo.
            expect(await manager.revertLocator('app.loginButton')).toBeNull();
        });

        it('returns null when there is no heal history', async () => {
            expect(await manager.revertLocator('app.loginButton')).toBeNull();
            // The stored selector is untouched.
            expect(manager.getLocator('app.loginButton')).toBe('#login-btn');
        });

        it('clears the failure count so the restored selector starts fresh', async () => {
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#login-btn', '#signin-btn'));
            await manager.recordSelectorFailure('app.loginButton');

            await manager.revertLocator('app.loginButton');

            expect(manager.getMetrics('app.loginButton').failureCount).toBe(0);
        });
    });

    describe('auto-revert (via the SELECTOR_QUARANTINE_THRESHOLD quarantine path)', () => {
        /**
         * `recordSelectorHealed` sets `previousSelector` from the provenance
         * record, which is exactly the rollback target the existing automatic
         * quarantine in `recordSelectorFailure` already consumes — so a heal
         * recorded with provenance is quarantined the same way a heal recorded
         * with a bare selector always was.
         */
        it('reverts once a healed selector has failed the configured number of times', async () => {
            await manager.updateLocator('app.loginButton', '#wrong-btn');
            await manager.recordSelectorHealed('app.loginButton', provenanceOf('#login-btn', '#wrong-btn'));

            // Default SELECTOR_QUARANTINE_THRESHOLD is 3.
            await manager.recordSelectorFailure('app.loginButton');
            expect(manager.getLocator('app.loginButton')).toBe('#wrong-btn');

            await manager.recordSelectorFailure('app.loginButton');
            expect(manager.getLocator('app.loginButton')).toBe('#wrong-btn');

            await manager.recordSelectorFailure('app.loginButton');
            expect(manager.getLocator('app.loginButton')).toBe('#login-btn');
        });

        it('does not fire for a selector that was never healed', async () => {
            // No healedAt → recordSelectorFailure is a no-op by design, so the
            // counter never reaches the threshold.
            for (let i = 0; i < 5; i++) await manager.recordSelectorFailure('app.loginButton');

            expect(manager.getLocator('app.loginButton')).toBe('#login-btn');
            expect(manager.getMetrics('app.loginButton').failureCount).toBe(0);
        });
    });
});
