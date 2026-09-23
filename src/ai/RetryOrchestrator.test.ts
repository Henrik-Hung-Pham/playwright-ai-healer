import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryOrchestrator, RetryBudgetExceededError, backoffDelay } from './RetryOrchestrator.js';
import type { AIClientManager } from './AIClientManager.js';
import type { AIError } from '../types.js';

function makeError(status: number | undefined, message: string): AIError {
    const err = new Error(message) as AIError;
    if (status !== undefined) err.status = status;
    return err;
}

function makeMockClientManager(overrides: Partial<AIClientManager> = {}) {
    return {
        getProvider: vi.fn().mockReturnValue('gemini'),
        getModelName: vi.fn().mockReturnValue('gemini-flash'),
        getKeyCount: vi.fn().mockReturnValue(2),
        getCurrentKeyIndex: vi.fn().mockReturnValue(0),
        rotateKey: vi.fn().mockReturnValue(true),
        switchProvider: vi.fn().mockReturnValue(true),
        makeRequest: vi.fn(),
        ...overrides,
    } as unknown as AIClientManager;
}

describe('RetryOrchestrator', () => {
    describe('classifyError', () => {
        let orchestrator: RetryOrchestrator;

        beforeEach(() => {
            orchestrator = new RetryOrchestrator(makeMockClientManager());
        });

        it('should classify 500 as retry', () => {
            expect(orchestrator.classifyError(makeError(500, 'Internal Server Error'))).toBe('retry');
        });

        it('should classify 503 as retry', () => {
            expect(orchestrator.classifyError(makeError(503, 'Service Unavailable'))).toBe('retry');
        });

        it('should classify timeout as retry', () => {
            expect(orchestrator.classifyError(makeError(undefined, 'request timed out'))).toBe('retry');
        });

        it('should classify overloaded as retry', () => {
            expect(orchestrator.classifyError(makeError(undefined, 'model is overloaded'))).toBe('retry');
        });

        it('should classify 401 as rotate_key', () => {
            expect(orchestrator.classifyError(makeError(401, 'Unauthorized'))).toBe('rotate_key');
        });

        it('should classify unauthorized message as rotate_key', () => {
            expect(orchestrator.classifyError(makeError(undefined, 'unauthorized access'))).toBe('rotate_key');
        });

        it('should classify 429 as switch_provider', () => {
            expect(orchestrator.classifyError(makeError(429, 'Rate limit exceeded'))).toBe('switch_provider');
        });

        it('should classify 403 as switch_provider', () => {
            expect(orchestrator.classifyError(makeError(403, 'Forbidden'))).toBe('switch_provider');
        });

        it('should classify resource exhausted as switch_provider', () => {
            expect(orchestrator.classifyError(makeError(undefined, 'resource exhausted'))).toBe('switch_provider');
        });

        it('should classify unknown errors as fatal', () => {
            expect(orchestrator.classifyError(makeError(undefined, 'Something weird'))).toBe('fatal');
        });
    });

    describe('execute', () => {
        it('should return result on first success', async () => {
            const client = makeMockClientManager();
            const orchestrator = new RetryOrchestrator(client);
            const operation = vi.fn().mockResolvedValueOnce('ok');

            const { result, providerSwitched } = await orchestrator.execute(operation);

            expect(result).toBe('ok');
            expect(providerSwitched).toBe(false);
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should retry on server error with backoff', async () => {
            const client = makeMockClientManager();
            const orchestrator = new RetryOrchestrator(client);

            const operation = vi
                .fn()
                .mockRejectedValueOnce(makeError(503, 'Service Unavailable'))
                .mockResolvedValueOnce('recovered');

            const { result } = await orchestrator.execute(operation, {
                maxRetries: 3,
                baseDelayMs: 1, // fast for tests
            });

            expect(result).toBe('recovered');
            expect(operation).toHaveBeenCalledTimes(2);
        });

        it('should throw after max retries on persistent server error', async () => {
            const client = makeMockClientManager();
            const orchestrator = new RetryOrchestrator(client);

            const operation = vi.fn().mockRejectedValue(makeError(500, 'Internal Server Error'));

            await expect(orchestrator.execute(operation, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow(
                'Internal Server Error'
            );

            // Initial attempt + 2 retries = 3 calls
            expect(operation).toHaveBeenCalledTimes(3);
        });

        it('should rotate key on 401 and retry', async () => {
            const client = makeMockClientManager({
                rotateKey: vi.fn().mockReturnValue(true),
            } as unknown as Partial<AIClientManager>);
            const orchestrator = new RetryOrchestrator(client);

            const operation = vi
                .fn()
                .mockRejectedValueOnce(makeError(401, 'Unauthorized'))
                .mockResolvedValueOnce('ok-with-new-key');

            const { result } = await orchestrator.execute(operation, { baseDelayMs: 1 });

            expect(result).toBe('ok-with-new-key');
            expect(client.rotateKey).toHaveBeenCalledTimes(1);
        });

        it('should switch provider on 429 and retry', async () => {
            const client = makeMockClientManager({
                switchProvider: vi.fn().mockReturnValue(true),
                getKeyCount: vi.fn().mockReturnValue(1),
            } as unknown as Partial<AIClientManager>);
            const orchestrator = new RetryOrchestrator(client);

            const operation = vi
                .fn()
                .mockRejectedValueOnce(makeError(429, 'Rate limit'))
                .mockResolvedValueOnce('ok-new-provider');

            const { result, providerSwitched } = await orchestrator.execute(operation, {
                baseDelayMs: 1,
            });

            expect(result).toBe('ok-new-provider');
            expect(providerSwitched).toBe(true);
            expect(client.switchProvider).toHaveBeenCalledTimes(1);
        });

        it('should throw on fatal error immediately', async () => {
            const client = makeMockClientManager();
            const orchestrator = new RetryOrchestrator(client);

            const operation = vi.fn().mockRejectedValue(makeError(undefined, 'Something weird'));

            await expect(orchestrator.execute(operation, { baseDelayMs: 1 })).rejects.toThrow('Something weird');

            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should fallthrough from rotate_key to switch_provider when keys exhausted', async () => {
            const client = makeMockClientManager({
                rotateKey: vi.fn().mockReturnValue(false), // no more keys
                switchProvider: vi.fn().mockReturnValue(true),
                getKeyCount: vi.fn().mockReturnValue(1),
            } as unknown as Partial<AIClientManager>);
            const orchestrator = new RetryOrchestrator(client);

            const operation = vi
                .fn()
                .mockRejectedValueOnce(makeError(401, 'Unauthorized'))
                .mockResolvedValueOnce('ok-after-switch');

            const { result, providerSwitched } = await orchestrator.execute(operation, {
                baseDelayMs: 1,
            });

            expect(result).toBe('ok-after-switch');
            expect(providerSwitched).toBe(true);
            expect(client.rotateKey).toHaveBeenCalled();
            expect(client.switchProvider).toHaveBeenCalled();
        });

        it('should throw when both key rotation and provider switch are exhausted', async () => {
            const client = makeMockClientManager({
                rotateKey: vi.fn().mockReturnValue(false),
                switchProvider: vi.fn().mockReturnValue(false),
                getKeyCount: vi.fn().mockReturnValue(1),
            } as unknown as Partial<AIClientManager>);
            const orchestrator = new RetryOrchestrator(client);

            const operation = vi.fn().mockRejectedValue(makeError(429, 'Rate limit'));

            await expect(orchestrator.execute(operation, { baseDelayMs: 1 })).rejects.toThrow('Rate limit');
        });
    });
    describe('backoffDelay', () => {
        it('stays within the upper half of the exponential ceiling', () => {
            expect(backoffDelay(1, 1000, () => 0)).toBe(1000);
            expect(backoffDelay(1, 1000, () => 1)).toBe(2000);
            expect(backoffDelay(3, 1000, () => 0)).toBe(4000);
            expect(backoffDelay(3, 1000, () => 1)).toBe(8000);
        });

        it('varies between calls so parallel workers do not retry in lockstep', () => {
            const delays = new Set(Array.from({ length: 20 }, () => backoffDelay(2, 1000)));
            expect(delays.size).toBeGreaterThan(1);
        });
    });

    describe('budgetMs', () => {
        it('passes the remaining budget to the operation', async () => {
            const orchestrator = new RetryOrchestrator(makeMockClientManager());
            const operation = vi.fn().mockResolvedValue('ok');

            await orchestrator.execute(operation, { budgetMs: 30_000 });

            const remaining = operation.mock.calls[0]?.[0] as number;
            expect(remaining).toBeGreaterThan(29_000);
            expect(remaining).toBeLessThanOrEqual(30_000);
        });

        it('passes Infinity when no budget is set', async () => {
            const orchestrator = new RetryOrchestrator(makeMockClientManager());
            const operation = vi.fn().mockResolvedValue('ok');

            await orchestrator.execute(operation);

            expect(operation).toHaveBeenCalledWith(Infinity);
        });

        it('gives up instead of sleeping past the budget', async () => {
            const orchestrator = new RetryOrchestrator(makeMockClientManager());
            const operation = vi.fn().mockRejectedValue(makeError(503, 'Service Unavailable'));

            const started = Date.now();
            // First backoff is at least 2^1 * 1000 / 2 = 1000ms, which overruns a 500ms budget.
            await expect(
                orchestrator.execute(operation, { maxRetries: 3, baseDelayMs: 1000, budgetMs: 500 })
            ).rejects.toBeInstanceOf(RetryBudgetExceededError);

            expect(operation).toHaveBeenCalledTimes(1);
            expect(Date.now() - started).toBeLessThan(500);
        });

        it('does not start another attempt once the budget is spent', async () => {
            vi.useFakeTimers();
            try {
                const client = makeMockClientManager({
                    getKeyCount: vi.fn().mockReturnValue(10),
                    rotateKey: vi.fn().mockReturnValue(true),
                } as unknown as Partial<AIClientManager>);
                const orchestrator = new RetryOrchestrator(client);
                // Each attempt burns 400ms of wall clock before failing auth.
                const operation = vi.fn().mockImplementation(() => {
                    vi.advanceTimersByTime(400);
                    return Promise.reject(makeError(401, 'Unauthorized'));
                });

                const run = orchestrator.execute(operation, { budgetMs: 1000 });

                await expect(run).rejects.toThrow(/budget of 1000ms exhausted.*Unauthorized/);
                // 0ms, 400ms, 800ms start; the fourth would start at 1200ms.
                expect(operation).toHaveBeenCalledTimes(3);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
