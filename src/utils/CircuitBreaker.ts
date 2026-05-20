/**
 * Circuit breaker for AI provider calls.
 *
 * Prevents cascading failures by fast-failing when an AI provider has
 * exceeded the consecutive-failure threshold. After the reset timeout
 * elapses the breaker enters HALF_OPEN state: one probe request is
 * allowed through; if it succeeds the breaker resets to CLOSED, if it
 * fails it immediately reopens.
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60_000 });
 *
 * if (breaker.isOpen()) {
 *     throw new Error('Circuit is open — AI provider unavailable');
 * }
 * try {
 *     const result = await callAI();
 *     breaker.onSuccess();
 *     return result;
 * } catch (err) {
 *     breaker.onFailure();
 *     throw err;
 * }
 * ```
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
    /** Number of consecutive failures before the circuit opens. Default: 5 */
    failureThreshold?: number;
    /** Milliseconds to wait in OPEN state before probing again. Default: 60 000 */
    resetTimeoutMs?: number;
}

export class CircuitBreaker {
    private state: CircuitState = 'CLOSED';
    private consecutiveFailures = 0;
    private openedAt = 0;

    private readonly failureThreshold: number;
    private readonly resetTimeoutMs: number;

    constructor(options: CircuitBreakerOptions = {}) {
        this.failureThreshold = options.failureThreshold ?? 5;
        this.resetTimeoutMs = options.resetTimeoutMs ?? 60_000;
    }

    /**
     * Returns true when the circuit is OPEN and requests should be fast-failed.
     * Transitions OPEN → HALF_OPEN automatically when the reset timeout elapses.
     */
    isOpen(): boolean {
        if (this.state === 'OPEN') {
            if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
                this.state = 'HALF_OPEN';
                return false;
            }
            return true;
        }
        return false;
    }

    /**
     * Call after a successful AI response.
     * Resets the failure counter and closes the circuit from any state.
     */
    onSuccess(): void {
        this.consecutiveFailures = 0;
        this.state = 'CLOSED';
    }

    /**
     * Call after a transient server-side failure (5xx / timeout).
     * Opens the circuit once the failure threshold is reached.
     */
    onFailure(): void {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failureThreshold || this.state === 'HALF_OPEN') {
            this.state = 'OPEN';
            this.openedAt = Date.now();
        }
    }

    /** Current state of the circuit breaker */
    getState(): CircuitState {
        return this.state;
    }

    /** Number of consecutive failures recorded since last success */
    getConsecutiveFailures(): number {
        return this.consecutiveFailures;
    }
}
