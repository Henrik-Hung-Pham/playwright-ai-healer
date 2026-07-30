import { test as base } from '@playwright/test';
import { AutoHealer } from '../../src/AutoHealer.js';
import { resolveAIProvider } from '../../src/ai/ProviderResolver.js';
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
        // Provider selection is `AI_PROVIDER`'s job, delegated to
        // `resolveAIProvider` so it is unit-testable. This fixture used to pick by
        // key presence instead — `if (ai.gemini.apiKey) … else if (openai) …` —
        // which silently ran Gemini whenever a GEMINI_API_KEY happened to be set,
        // even with AI_PROVIDER=openai.
        const { provider, apiKeys, modelName } = resolveAIProvider(config.ai);
        logger.debug(`[Fixture] AI_PROVIDER=${provider}, model=${modelName}`);

        const healer = new AutoHealer(page, apiKeys, provider, modelName, true);
        await use(healer);
    },

    booksPage: async ({ page, autoHealer }, use) => {
        const handler = new BooksToScrapeHandler();
        const booksPage = new BooksHomePage(page, autoHealer, handler);
        await use(booksPage);
    },
});

export { expect } from '@playwright/test';
