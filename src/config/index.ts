import { z } from 'zod';
import { loadEnvironment } from '../utils/Environment.js';
import { logger } from '../utils/Logger.js';

const categoriesData = {
    travel: { label: 'Travel' },
    mystery: { label: 'Mystery' },
    'historical-fiction': { label: 'Historical Fiction' },
    'science-fiction': { label: 'Science Fiction' },
    poetry: { label: 'Poetry' },
} as const;

export type CategoryKey = keyof typeof categoriesData;

// Define the schema for environment variables
const envSchema = z.object({
    ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
    BASE_URL: z
        .string()
        .optional()
        .transform(val => {
            if (!val || val === '/' || val === '') return 'https://books.toscrape.com/';
            return val;
        })
        .pipe(z.string().url()),
    AI_PROVIDER: z.enum(['gemini', 'openai']).default('gemini'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default('gemini-flash-latest'),
    OPENAI_API_KEYS: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4o'),
    TEST_TIMEOUT: z.string().default('180000').transform(Number),
    DOM_SNAPSHOT_CHAR_LIMIT: z.string().default('2000').transform(Number).pipe(z.number().int().min(100)),
    HEADLESS: z
        .string()
        .default('true')
        .transform(val => val !== 'false'),
    LOG_LEVEL: z.string().default('info'),
    CONSOLE_LOG_LEVEL: z.string().default('info'),
    LOG_EMOJI: z
        .string()
        .default('true')
        .transform(val => val !== 'false'),
    LOCATOR_STORE: z.enum(['file', 'sqlite']).default('file'),
    HEALING_FAILURE_MODE: z.enum(['fail', 'skip']).default('fail'),
});

type AppConfig = {
    env: string;
    app: { baseUrl: string };
    ai: {
        provider: string;
        gemini: { apiKey: string | undefined; modelName: string };
        openai: { apiKeys: string[]; modelName: string; apiKey: string | undefined };
        healing: {
            maxRetries: number;
            retryDelay: number;
            confidenceThreshold: number;
            domSnapshotCharLimit: number;
            failureMode: 'fail' | 'skip';
        };
        security: { vercelChallengePath: string };
        prompts: { healingPrompt: (selector: string, error: string, html: string) => string };
    };
    test: {
        timeout: number;
        headless: boolean;
        timeouts: {
            default: number;
            cookie: number;
            urlVerify: number;
            productVisibility: number;
            click: number;
            fill: number;
            short: number;
            stabilization: number;
        };
    };
    locatorStore: 'file' | 'sqlite';
    logging: { level: string; consoleLevel: string; emoji: boolean };
    testData: {
        searchTerms: string[];
        getRandomSearchTerm(): string;
        categories: typeof categoriesData;
    };
};

function buildConfig(): AppConfig {
    // loadEnvironment() is idempotent — safe to call multiple times
    loadEnvironment();

    const env = envSchema.parse(process.env);

    // Validate that the selected provider has a key
    if (env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is required when AI_PROVIDER is gemini');
    }
    if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY && !env.OPENAI_API_KEYS) {
        throw new Error('OPENAI_API_KEY or OPENAI_API_KEYS is required when AI_PROVIDER is openai');
    }

    return {
        env: env.ENV,
        app: {
            baseUrl: env.BASE_URL,
        },
        ai: {
            provider: env.AI_PROVIDER,
            gemini: {
                apiKey: env.GEMINI_API_KEY,
                modelName: env.GEMINI_MODEL,
            },
            openai: {
                apiKeys: (env.OPENAI_API_KEYS || env.OPENAI_API_KEY || '')
                    .split(',')
                    .map(k => k.trim())
                    .filter(Boolean),
                modelName: env.OPENAI_MODEL,
                apiKey: env.OPENAI_API_KEY,
            },
            healing: {
                maxRetries: 3,
                retryDelay: 5000,
                confidenceThreshold: 0.7,
                domSnapshotCharLimit: env.DOM_SNAPSHOT_CHAR_LIMIT,
                failureMode: env.HEALING_FAILURE_MODE,
            },
            security: {
                vercelChallengePath: '.well-known/vercel/security/request-challenge',
            },
            prompts: {
                healingPrompt: (selector: string, error: string, html: string) => {
                    const sanitize = (s: string): string => s.replace(/[<>"'`\\]/g, '').slice(0, 200);
                    return `
      You are a Test Automation AI. A Playwright test failed to find or interact with an element.

      Original Selector: "${sanitize(selector)}"
      Error: "${sanitize(error)}"

      Below is the current HTML of the page.
      Analyze it to find the MOST LIKELY new selector for the element the user intended to interact with.

      CRITICAL INSTRUCTIONS:
      1. Return ONLY the new selector as a plain string.
      2. DO NOT return markdown formatting like backticks (e.g. no \`#selector\`).
      3. Use the original selector name as a semantic clue about the element's purpose, not a literal ID to match.
      4. Only return "FAIL" if there is genuinely no element in the HTML that could serve the intended purpose.

      HTML Snippet:
      ${html}
    `;
                },
            },
        },
        test: {
            timeout: env.TEST_TIMEOUT,
            headless: env.HEADLESS,
            timeouts: {
                // Global unified timeouts
                default: 60000,
                cookie: 10000,
                urlVerify: 15000,
                productVisibility: 30000,
                // AutoHealer action timeouts
                click: 10000,
                fill: 10000,
                // Action timeouts
                short: 5000,
                stabilization: 200,
            },
        },
        locatorStore: env.LOCATOR_STORE,
        logging: {
            level: env.LOG_LEVEL,
            consoleLevel: env.CONSOLE_LOG_LEVEL,
            emoji: env.LOG_EMOJI,
        },
        testData: {
            searchTerms: ['fiction', 'mystery', 'romance', 'poetry', 'travel'],
            getRandomSearchTerm(): string {
                const terms = this.searchTerms;
                const term = terms[Math.floor(Math.random() * terms.length)] ?? 'laptop';
                logger.debug(`[config] getRandomSearchTerm selected: "${term}"`);
                return term;
            },
            categories: categoriesData,
        },
    };
}

/** Lazily-initialized singleton — Zod parsing and env validation only run on first access. */
let _config: AppConfig | undefined;

export const config: AppConfig = new Proxy({} as AppConfig, {
    get(_target, key: string | symbol) {
        if (!_config) _config = buildConfig();
        return Reflect.get(_config, key);
    },
});

/** Reset the config singleton. Use only in tests to allow re-initialisation after env changes. */
export function resetConfigForTesting(): void {
    _config = undefined;
}
