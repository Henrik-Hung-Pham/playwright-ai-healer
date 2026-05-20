import winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { type TestInfo } from '@playwright/test';

import { config } from '../config/index.js';

// Get current directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logsDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for console output with colors and timestamps
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] ${level}: ${message}`;
    })
);

// Custom format for file output (no colors, JSON-friendly)
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] [${level.toUpperCase()}]: ${message}`;
    })
);

// Lazily create the winston logger. Deferring construction avoids a TDZ error
// from the circular import between Logger.ts and config/index.ts — config reads
// `logger` at module scope, so touching `config` during Logger's own module
// init would fail when config/index.ts is loaded first.
let winstonLoggerInstance: winston.Logger | undefined;
function getWinstonLogger(): winston.Logger {
    if (!winstonLoggerInstance) {
        winstonLoggerInstance = winston.createLogger({
            level: config.logging.level,
            transports: [
                new winston.transports.Console({
                    format: consoleFormat,
                    level: config.logging.consoleLevel,
                }),
                new winston.transports.File({
                    filename: path.join(logsDir, 'execution.log'),
                    format: fileFormat,
                    maxsize: 5 * 1024 * 1024, // 5MB max file size
                    maxFiles: 3, // Keep up to 3 rotated log files
                }),
            ],
        });
    }
    return winstonLoggerInstance;
}

/**
 * Logger - Singleton logger wrapping Winston with Playwright report integration.
 *
 * Writes structured log messages to the console and a rotating file at `logs/execution.log`.
 * When a Playwright `TestInfo` object is attached via `setTestInfo`, log entries are also
 * pushed as annotations to the Playwright HTML report.
 *
 * Use the exported `logger` constant rather than constructing instances directly.
 *
 * @example
 * ```typescript
 * import { logger } from './utils/Logger.js';
 *
 * logger.info('Starting test');
 * logger.error('Something went wrong');
 * ```
 */
export class Logger {
    private static instance: Logger;
    private playwrightTestInfo: TestInfo | null = null;

    private constructor() {}

    /**
     * Returns the singleton Logger instance, creating it on first call.
     */
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Attach a Playwright test.info() object to enable report integration.
     * Call this at the start of a test: Logger.getInstance().setTestInfo(test.info());
     */
    public setTestInfo(testInfo: TestInfo): void {
        this.playwrightTestInfo = testInfo;
    }

    /**
     * Clear the test info (call at the end of a test or in afterEach).
     */
    public clearTestInfo(): void {
        this.playwrightTestInfo = null;
    }

    private log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
        // Strip Unicode emoji when LOG_EMOJI=false (e.g. for CI log parsers or Windows terminals)
        const msg = config.logging.emoji
            ? message
            : message.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
        getWinstonLogger().log(level, msg);

        // Optionally attach to Playwright test report
        if (this.playwrightTestInfo) {
            try {
                this.playwrightTestInfo.annotations.push({
                    type: level,
                    description: msg,
                });
            } catch {
                // Ignore if test context is not active
            }
        }
    }

    /** Log an informational message. @param message - The message to log. */
    public info(message: string): void {
        this.log('info', message);
    }

    /** Log a warning message. @param message - The message to log. */
    public warn(message: string): void {
        this.log('warn', message);
    }

    /** Log an error message. @param message - The message to log. */
    public error(message: string): void {
        this.log('error', message);
    }

    /** Log a debug message. Only visible when `LOG_LEVEL=debug`. @param message - The message to log. */
    public debug(message: string): void {
        this.log('debug', message);
    }
}

// Export a singleton instance for convenience
export const logger = Logger.getInstance();
