// Test setup file for proper mock hoisting
import { vi, type Mock } from 'vitest';

// Create controllable mock functions
export const mockGeminiGenerateContent: Mock = vi.fn();
export const mockOpenaiCreate: Mock = vi.fn();

// Mock winston globally so no unit test performs real file I/O via the
// Logger's file transport. Files that need to assert on logger calls (e.g.
// Logger.test.ts) still declare their own more detailed vi.mock('winston', ...),
// which takes precedence for that file.
vi.mock('winston', () => ({
    default: {
        createLogger: vi.fn(() => ({
            log: vi.fn(),
            add: vi.fn(),
            remove: vi.fn(),
        })),
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
}));

// ---------------------------------------------------------------------------
// Mock config/index.js — prevents Zod validation + GEMINI_API_KEY check from
// running when any source module (Logger, AutoHealer, BasePage, …) imports
// the config singleton at module scope.
// ---------------------------------------------------------------------------
vi.mock('./config/index.js', () => ({
    config: {
        env: 'dev',
        app: { baseUrl: 'https://books.toscrape.com/' },
        ai: {
            provider: 'gemini',
            gemini: { apiKey: 'mock-gemini-key', modelName: 'gemini-flash-latest' },
            openai: {
                apiKeys: [] as string[],
                modelName: 'gpt-4o',
                apiKey: undefined,
            },
            healing: {
                // Mutable so a test can drive the mode without re-mocking the
                // whole config module. Tests that change it must restore it.
                mode: 'apply' as 'off' | 'suggest' | 'apply',
                maxRetries: 3,
                retryDelay: 5000,
                budgetMs: 60000,
                confidenceThreshold: 0.7,
                domSnapshotCharLimit: 2000,
                failureMode: 'fail' as 'fail' | 'skip',
                quarantineThreshold: 3,
            },
            security: { vercelChallengePath: '.well-known/vercel/security/request-challenge' },
            prompts: {
                healingPrompt: (selector: string, error: string, html: string) =>
                    `Mock prompt: selector=${selector} error=${error} html=${html}`,
            },
        },
        test: {
            timeout: 180000,
            headless: true,
            timeouts: {
                default: 60000,
                cookie: 10000,
                urlVerify: 15000,
                productVisibility: 30000,
                click: 10000,
                fill: 10000,
                short: 5000,
                stabilization: 200,
            },
        },
        logging: { level: 'info', consoleLevel: 'info', emoji: true },
        testData: {
            searchTerms: ['fiction', 'mystery', 'romance', 'poetry', 'travel'],
            getRandomSearchTerm() {
                return 'fiction';
            },
            categories: { travel: { label: 'Travel' }, mystery: { label: 'Mystery' } },
        },
    },
    resetConfigForTesting: vi.fn(),
}));

// Mock @google/generative-ai with a proper class
vi.mock('@google/generative-ai', () => {
    // Define a mock class that can be instantiated with 'new'
    class MockGoogleGenerativeAI {
        constructor(_apiKey: string) {}
        getGenerativeModel() {
            return {
                generateContent: mockGeminiGenerateContent,
            };
        }
    }
    return { GoogleGenerativeAI: MockGoogleGenerativeAI };
});

// Mock openai with a proper class
vi.mock('openai', () => {
    class MockOpenAI {
        chat = {
            completions: {
                create: mockOpenaiCreate,
            },
        };
        constructor(_opts: unknown) {}
    }
    return { default: MockOpenAI };
});

// Mock @playwright/test
vi.mock('@playwright/test', () => ({
    test: {
        info: vi.fn().mockReturnValue({ annotations: [], project: { name: 'unit-test' } }),
        skip: vi.fn(),
    },
    expect: vi.fn().mockImplementation((actual: unknown) => ({
        toPass: vi.fn().mockImplementation(async () => {
            if (typeof actual === 'function') {
                await (actual as () => Promise<void>)();
            }
        }),
        toHaveURL: vi.fn(),
        toHaveValue: vi.fn(),
        toBeVisible: vi.fn(),
        toContainText: vi.fn(),
        toBeGreaterThan: vi.fn(),
        not: {
            toBeVisible: vi.fn(),
        },
    })),
}));
