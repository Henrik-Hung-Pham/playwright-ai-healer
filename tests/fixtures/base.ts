import { test as base } from '@playwright/test';
import { AutoHealer } from '../../src/AutoHealer.js';
import { BooksHomePage } from '../../src/pages/BooksHomePage.js';
import { BooksToScrapeHandler } from '../../src/utils/SiteHandler.js';
import { config } from '../../src/config/index.js';
import { logger } from '../../src/utils/Logger.js';

// Define custom fixtures
type MyFixtures = {
    autoHealer: AutoHealer | undefined;
    booksPage: BooksHomePage;
};

export const test = base.extend<MyFixtures>({
    autoHealer: async ({ page }, use) => {
        const { ai } = config;

        let provider: 'openai' | 'gemini';
        let apiKeys: string | string[];
        let model: string;

        if (ai.gemini.apiKey) {
            provider = 'gemini';
            apiKeys = ai.gemini.apiKey;
            model = ai.gemini.modelName;
        } else if (ai.openai.apiKeys && ai.openai.apiKeys.length > 0) {
            logger.debug(`[Fixture] Checking openai keys. Length: ${ai.openai.apiKeys.length}`);
            provider = 'openai';
            apiKeys = ai.openai.apiKeys;
            model = ai.openai.modelName;
        } else {
            logger.error('[Fixture] No API keys found for Gemini or OpenAI');
            throw new Error('API Key missing! Check src/config/index.ts or .env');
        }

        const healer = new AutoHealer(page, apiKeys, provider, model, true);
        await use(healer);
    },

    booksPage: async ({ page, autoHealer }, use) => {
        const handler = new BooksToScrapeHandler();
        const booksPage = new BooksHomePage(page, autoHealer, handler);
        await use(booksPage);
    },
});

export { expect } from '@playwright/test';
