import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load the appropriate .env file based on TEST_ENV
const testEnv = process.env['TEST_ENV'] || 'dev';
const envPath = path.resolve(`.env.${testEnv}`);

if (fs.existsSync(envPath)) {
    // Only apply non-empty values so empty placeholders don't clobber existing env vars
    const envConfig = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
    for (const [key, value] of Object.entries(envConfig)) {
        if (value && value.trim() !== '') {
            process.env[key] = value;
        }
    }
}

// Ensure the local .env overrides the env-specific file
const basePath = path.resolve('.env');
if (fs.existsSync(basePath)) {
    dotenv.config({ path: basePath, override: true });
}

export default defineConfig({
    testDir: './tests',
    testIgnore: 'tests/unit/**',
    timeout: parseInt(process.env['TEST_TIMEOUT'] || '120000', 10),
    retries: process.env['CI'] ? 2 : 0,
    workers: process.env['CI'] ? 2 : 4,
    fullyParallel: true,

    // Generate HTML report for CI artifacts
    reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

    use: {
        headless: process.env['HEADLESS'] !== 'false',
        baseURL: process.env['BASE_URL'] || 'https://books.toscrape.com/',
        screenshot: 'on-first-failure',
        video: 'retain-on-failure',
        trace: 'retain-on-failure',
    },

    // Environment-specific projects
    projects: [
        // Environment projects (Chromium-based)
        {
            name: 'default',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'dev',
            use: {
                ...devices['Desktop Chrome'],
                headless: false,
            },
        },
        {
            name: 'staging',
            use: {
                ...devices['Desktop Chrome'],
                headless: true,
            },
        },
        {
            name: 'prod',
            use: {
                ...devices['Desktop Chrome'],
                headless: true,
            },
        },

        // Desktop browsers - All major engines
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'chrome',
            use: {
                ...devices['Desktop Chrome'],
                channel: 'chrome', // Uses actual Google Chrome
            },
        },
        {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
        },
        {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
        },
        {
            name: 'edge',
            use: {
                ...devices['Desktop Edge'],
                channel: 'msedge', // Uses actual Microsoft Edge
            },
        },

        // Mobile devices
        {
            name: 'mobile-chrome',
            use: { ...devices['Pixel 5'] },
        },
        {
            name: 'mobile-safari',
            use: { ...devices['iPhone 12'] },
        },
        {
            name: 'tablet',
            use: { ...devices['iPad (gen 7)'] },
        },
    ],
});
