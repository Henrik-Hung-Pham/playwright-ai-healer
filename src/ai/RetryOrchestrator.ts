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
    /** Base delay in ms for exponential backoff. Actual delay: 2^attempt * base. Default: 1000. */
    baseDelayMs?: number;
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
     * @param operation - The async operation to attempt (typically `clientManager.makeRequest`)
     * @param options - Retry configuration
     * @returns The successful result wrapped in an {@link OrchestratorResult}
     * @throws The last error if all retry strategies are exhausted
     */
    async execute<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<OrchestratorResult<T>> {
        const maxRetries = options.maxRetries ?? 3;
        const baseDelayMs = options.baseDelayMs ?? 1000;

        let hasSwitchedProvider = false;
        let maxKeyRotations = this.clientManager.getKeyCount();

        for (let keyIter = 0; keyIter < maxKeyRotations; keyIter++) {
            let retryCount = 0;

            logger.info(
                `[RetryOrchestrator] Key iteration ${keyIter}, key index ${this.clientManager.getCurrentKeyIndex()}`
            );

            while (retryCount <= maxRetries) {
                logger.info(`[RetryOrchestrator] Attempt: keyIter=${keyIter}, retry=${retryCount}/${maxRetries}`);

                try {
                    const result = await operation();
                    return { result, providerSwitched: hasSwitchedProvider };
                } catch (err) {
                    const error = err as AIError;
                    const action = this.classifyError(error);

                    logger.error(
                        `[RetryOrchestrator] Error: status=${error.status}, action=${action}, msg="${error.message}"`
                    );

                    switch (action) {
                        case 'retry': {
                            if (retryCount < maxRetries) {
                                retryCount++;
                                const delay = Math.pow(2, retryCount) * baseDelayMs;
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
