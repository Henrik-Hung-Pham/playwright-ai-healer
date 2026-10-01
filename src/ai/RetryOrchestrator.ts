import { logger } from '../utils/Logger.js';
import type { AIClientManager } from './AIClientManager.js';
import type { AIError } from '../types.js';

/**
 * Error action classification returned by {@link RetryOrchestrator.classifyError}.
 */
export type ErrorAction = 'retry' | 'rotate_key' | 'switch_provider' | 'fatal';

/**
 * Options for configuring the retry orchestrator.
 */
export interface RetryOptions {
    /** Maximum retries for server (5xx) errors before escalating. Default: 3. */
    maxRetries?: number;
    /**
     * Base delay in ms for exponential backoff. The ceiling for attempt `n` is
     * `2^n * base`; the actual delay is drawn uniformly from the upper half of
     * that range (see {@link backoffDelay}). Default: 1000.
     */
    baseDelayMs?: number;
    /**
     * Wall-clock budget in ms for the whole `execute()` call — every attempt,
     * backoff, key rotation, and provider switch together. When it runs out the
     * orchestrator throws {@link RetryBudgetExceededError} instead of starting
     * another attempt or sleeping past it. Omit for no overall limit.
     */
    budgetMs?: number;
}

/**
 * Thrown when {@link RetryOptions.budgetMs} is exhausted before any attempt succeeds.
 */
export class RetryBudgetExceededError extends Error {
    constructor(budgetMs: number, lastError?: Error) {
        super(
            `[RetryOrchestrator] Healing budget of ${budgetMs}ms exhausted` +
                (lastError ? ` (last error: ${lastError.message})` : '')
        );
        this.name = 'RetryBudgetExceededError';
    }
}

/**
 * Backoff delay for retry number `attempt` (1-based).
 *
 * "Equal jitter": half the exponential ceiling is fixed, the other half is
 * random. Without jitter every Playwright worker that hit the same provider
 * outage retries at exactly the same instants (2s, 4s, 8s …) and the retries
 * arrive as a synchronised burst — the pattern most likely to be rate-limited
 * again. Keeping a fixed floor still guarantees the backoff actually backs off.
 */
export function backoffDelay(attempt: number, baseDelayMs: number, random: () => number = Math.random): number {
    const ceiling = Math.pow(2, attempt) * baseDelayMs;
    return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Result of an orchestrated operation attempt.
 */
export interface OrchestratorResult<T> {
    /** The successful result, if the operation succeeded. */
    result: T;
    /** Whether the provider was switched during execution. */
    providerSwitched: boolean;
}

/**
 * Encapsulates the retry / key-rotation / provider-failover strategy that was
 * previously embedded as nested loops inside `HealingEngine.heal()`.
 *
 * The orchestrator classifies errors into four actions:
 *
 * 1. **retry** — server errors (5xx, timeouts). Exponential backoff up to `maxRetries`.
 * 2. **rotate_key** — authentication errors (401). Advance to the next API key.
 * 3. **switch_provider** — client errors (4xx, rate limits). Switch Gemini ↔ OpenAI.
 * 4. **fatal** — unrecognised errors. Rethrow immediately.
 *
 * @example
 * ```typescript
 * const orchestrator = new RetryOrchestrator(clientManager);
 * const { result } = await orchestrator.execute(
 *     () => clientManager.makeRequest(prompt, timeout),
 * );
 * ```
 */
export class RetryOrchestrator {
    private clientManager: AIClientManager;

    constructor(clientManager: AIClientManager) {
        this.clientManager = clientManager;
    }

    /**
     * Classify an error into the appropriate retry action.
     */
    classifyError(error: AIError): ErrorAction {
        const msg = (error.message ?? '').toLowerCase();

        // 5xx / server / timeout → retry with backoff
        const isServerError =
            (error.status !== undefined && error.status >= 500) ||
            /\b50[03]\b/.test(msg) ||
            msg.includes('service unavailable') ||
            msg.includes('overloaded') ||
            msg.includes('internal server error') ||
            msg.includes('bad gateway') ||
            msg.includes('timed out');

        if (isServerError) return 'retry';

        // 401 / unauthorized → rotate API key
        const isAuthError = error.status === 401 || /\b401\b/.test(msg) || msg.includes('unauthorized');

        if (isAuthError) return 'rotate_key';

        // Other 4xx (rate limit, quota, etc.) → switch provider
        const is4xxError =
            (error.status !== undefined && error.status >= 400 && error.status < 500) ||
            /\b429\b/.test(msg) ||
            msg.includes('rate limit') ||
            msg.includes('resource exhausted') ||
            msg.includes('insufficient quota');

        if (is4xxError) return 'switch_provider';

        return 'fatal';
    }

    /**
     * Execute an operation with automatic retry, key rotation, and provider failover.
     *
     * @param operation - The async operation to attempt (typically `clientManager.makeRequest`).
     *   Receives the milliseconds left in the budget (`Infinity` when no
     *   `budgetMs` is set) so it can cap its own per-request timeout to fit.
     * @param options - Retry configuration
     * @returns The successful result wrapped in an {@link OrchestratorResult}
     * @throws The last error if all retry strategies are exhausted, or
     *   {@link RetryBudgetExceededError} if `budgetMs` runs out first
     */
    async execute<T>(
        operation: (remainingMs: number) => Promise<T>,
        options: RetryOptions = {}
    ): Promise<OrchestratorResult<T>> {
        const maxRetries = options.maxRetries ?? 3;
        const baseDelayMs = options.baseDelayMs ?? 1000;
        const budgetMs = options.budgetMs;
        const deadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
        const remaining = () => deadline - Date.now();
        let lastError: Error | undefined;

        let hasSwitchedProvider = false;
        let maxKeyRotations = this.clientManager.getKeyCount();

        for (let keyIter = 0; keyIter < maxKeyRotations; keyIter++) {
            let retryCount = 0;

            logger.info(
                `[RetryOrchestrator] Key iteration ${keyIter}, key index ${this.clientManager.getCurrentKeyIndex()}`
            );

            while (retryCount <= maxRetries) {
                logger.info(`[RetryOrchestrator] Attempt: keyIter=${keyIter}, retry=${retryCount}/${maxRetries}`);

                if (remaining() <= 0) {
                    logger.error(`[RetryOrchestrator] Budget of ${budgetMs}ms exhausted before next attempt.`);
                    throw new RetryBudgetExceededError(budgetMs ?? 0, lastError);
                }

                try {
                    const result = await operation(remaining());
                    return { result, providerSwitched: hasSwitchedProvider };
                } catch (err) {
                    const error = err as AIError;
                    lastError = error;
                    const action = this.classifyError(error);

                    logger.error(
                        `[RetryOrchestrator] Error: status=${error.status}, action=${action}, msg="${error.message}"`
                    );

                    switch (action) {
                        case 'retry': {
                            if (retryCount < maxRetries) {
                                retryCount++;
                                const delay = backoffDelay(retryCount, baseDelayMs);
                                // Sleeping past the deadline only to throw on waking
                                // wastes the rest of the test's time budget.
                                if (delay >= remaining()) {
                                    logger.error(
                                        `[RetryOrchestrator] Backoff of ${delay}ms would overrun the ${budgetMs}ms budget. Giving up.`
                                    );
                                    throw new RetryBudgetExceededError(budgetMs ?? 0, error);
                                }
                                logger.warn(
                                    `[RetryOrchestrator] Server error. Retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`
                                );
                                await new Promise(resolve => setTimeout(resolve, delay));
                                continue;
                            }
                            logger.error(`[RetryOrchestrator] Server error after ${maxRetries} retries. Giving up.`);
                            throw error;
                        }

                        case 'rotate_key': {
                            const rotated = this.clientManager.rotateKey();
                            if (rotated) {
                                logger.info(
                                    `[RetryOrchestrator] Key rotated to index ${this.clientManager.getCurrentKeyIndex()}`
                                );
                                break; // break switch, continue outer keyIter loop
                            }
                            logger.warn(
                                `[RetryOrchestrator] Key rotation exhausted. Falling through to provider switch.`
                            );
                        }
                        // Intentional fallthrough when key rotation exhausted

                        // eslint-disable-next-line no-fallthrough
                        case 'switch_provider': {
                            if (!hasSwitchedProvider && this.clientManager.switchProvider()) {
                                hasSwitchedProvider = true;
                                maxKeyRotations = this.clientManager.getKeyCount();
                                keyIter = -1; // will become 0 after for-loop increment
                                logger.info(
                                    `[RetryOrchestrator] Switched provider to ${this.clientManager.getProvider()}`
                                );
                                break; // break switch, restart outer loop
                            }
                            logger.error(`[RetryOrchestrator] No alternate provider available. Giving up.`);
                            throw error;
                        }

                        case 'fatal':
                        default:
                            throw error;
                    }

                    break; // break while loop → advance to next keyIter
                }
            }
        }

        // Should not reach here, but satisfy TypeScript
        throw new Error('[RetryOrchestrator] All retry strategies exhausted.');
    }
}
