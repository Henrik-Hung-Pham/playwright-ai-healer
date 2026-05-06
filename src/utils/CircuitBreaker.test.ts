import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from './CircuitBreaker.js';

describe('CircuitBreaker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('initial state', () => {
        it('starts CLOSED', () => {
            const cb = new CircuitBreaker();
            expect(cb.getState()).toBe('CLOSED');
            expect(cb.isOpen()).toBe(false);
        });

        it('has zero consecutive failures initially', () => {
            const cb = new CircuitBreaker();
            expect(cb.getConsecutiveFailures()).toBe(0);
        });
    });

    describe('CLOSED → OPEN transition', () => {
        it('opens after reaching the failure threshold', () => {
            const cb = new CircuitBreaker({ failureThreshold: 3 });
            cb.onFailure();
            cb.onFailure();
            expect(cb.getState()).toBe('CLOSED');
            cb.onFailure(); // 3rd failure hits threshold
            expect(cb.getState()).toBe('OPEN');
            expect(cb.isOpen()).toBe(true);
        });

        it('does not open before the threshold is reached', () => {
            const cb = new CircuitBreaker({ failureThreshold: 5 });
            for (let i = 0; i < 4; i++) cb.onFailure();
            expect(cb.getState()).toBe('CLOSED');
            expect(cb.isOpen()).toBe(false);
        });
    });

    describe('OPEN → HALF_OPEN transition', () => {
        it('transitions to HALF_OPEN after the reset timeout', () => {
            const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
            cb.onFailure();
            expect(cb.getState()).toBe('OPEN');

            vi.advanceTimersByTime(10_001);
            expect(cb.isOpen()).toBe(false); // probe allowed through
            expect(cb.getState()).toBe('HALF_OPEN');
        });

        it('stays OPEN before the reset timeout elapses', () => {
            const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
            cb.onFailure();
            vi.advanceTimersByTime(9_999);
            expect(cb.isOpen()).toBe(true);
            expect(cb.getState()).toBe('OPEN');
        });
    });

    describe('HALF_OPEN behaviour', () => {
        it('closes on success from HALF_OPEN', () => {
            const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 });
            cb.onFailure();
            vi.advanceTimersByTime(1_001);
            cb.isOpen(); // triggers OPEN → HALF_OPEN
            cb.onSuccess();
            expect(cb.getState()).toBe('CLOSED');
            expect(cb.getConsecutiveFailures()).toBe(0);
        });

        it('reopens immediately on failure from HALF_OPEN', () => {
            const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 });
            cb.onFailure();
            vi.advanceTimersByTime(1_001);
            cb.isOpen(); // OPEN → HALF_OPEN
            cb.onFailure(); // probe fails → reopen
            expect(cb.getState()).toBe('OPEN');
            expect(cb.isOpen()).toBe(true);
        });
    });

    describe('onSuccess resets failure counter', () => {
        it('resets consecutive failures and closes the circuit', () => {
            const cb = new CircuitBreaker({ failureThreshold: 5 });
            cb.onFailure();
            cb.onFailure();
            cb.onSuccess();
            expect(cb.getConsecutiveFailures()).toBe(0);
            expect(cb.getState()).toBe('CLOSED');
        });

        it('failures accumulated before success do not count toward the threshold after reset', () => {
            const cb = new CircuitBreaker({ failureThreshold: 3 });
            cb.onFailure();
            cb.onFailure();
            cb.onSuccess();
            cb.onFailure();
            cb.onFailure();
            // Only 2 failures since last success — circuit should still be CLOSED
            expect(cb.getState()).toBe('CLOSED');
        });
    });

    describe('custom options', () => {
        it('uses default threshold of 5 and reset timeout of 60s', () => {
            const cb = new CircuitBreaker();
            for (let i = 0; i < 4; i++) cb.onFailure();
            expect(cb.getState()).toBe('CLOSED');
            cb.onFailure();
            expect(cb.getState()).toBe('OPEN');

            vi.advanceTimersByTime(59_999);
            expect(cb.isOpen()).toBe(true);
            vi.advanceTimersByTime(2);
            expect(cb.isOpen()).toBe(false); // HALF_OPEN
        });
    });
});
