// Test setup file for proper mock hoisting
import { vi } from 'vitest';

// Create controllable mock functions
export const mockGeminiGenerateContent = vi.fn();
export const mockOpenaiCreate = vi.fn();

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
                maxRetries: 3,
                retryDelay: 5000,
                confidenceThreshold: 0.7,
                domSnapshotCharLimit: 2000,
                failureMode: 'fail' as 'fail' | 'skip',
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
