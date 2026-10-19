import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from './Logger.js';
import { type TestInfo } from '@playwright/test';

// Hoist mock object so it's accessible in both mock factory and tests
const { mockLogger } = vi.hoisted(() => {
    return {
        mockLogger: {
            log: vi.fn(),
            add: vi.fn(),
            remove: vi.fn(),
        },
    };
});

// Mock Winston
vi.mock('winston', () => {
    return {
        default: {
            createLogger: vi.fn(() => mockLogger),
            transports: {
                Console: vi.fn(),
                File: vi.fn(),
            },
            format: {
                combine: vi.fn(),
                timestamp: vi.fn(),
                colorize: vi.fn(),
                printf: vi.fn(),
            },
        },
    };
});

describe('Logger', () => {
    let loggerInstance: Logger;

    beforeEach(() => {
        vi.clearAllMocks();
        // Access private instance via static method since it's a singleton
        loggerInstance = Logger.getInstance();
    });

    it('should be a singleton', () => {
        const instance1 = Logger.getInstance();
        const instance2 = Logger.getInstance();
        expect(instance1).toBe(instance2);
    });

    it('should log info messages', () => {
        loggerInstance.info('test info');
        expect(mockLogger.log).toHaveBeenCalledWith('info', 'test info');
    });

    it('should log error messages', () => {
        loggerInstance.error('test error');
        expect(mockLogger.log).toHaveBeenCalledWith('error', 'test error');
    });

    describe('Test Info Integration', () => {
        it('should attach annotations to test info if present', () => {
            const mockTestInfo = {
                annotations: [],
            } as unknown as TestInfo;

            loggerInstance.setTestInfo(mockTestInfo);
            loggerInstance.warn('test warning');

            expect(mockTestInfo.annotations).toHaveLength(1);
            expect(mockTestInfo.annotations[0]).toEqual({
                type: 'warn',
                description: 'test warning',
            });

            // Cleanup
            loggerInstance.clearTestInfo();
        });

        it('should NOT attach annotations if test info is cleared', () => {
            const mockTestInfo = {
                annotations: [],
            } as unknown as TestInfo;

            loggerInstance.setTestInfo(mockTestInfo);
            loggerInstance.clearTestInfo();
            loggerInstance.info('test info');

            expect(mockTestInfo.annotations).toHaveLength(0);
        });
    });
});
