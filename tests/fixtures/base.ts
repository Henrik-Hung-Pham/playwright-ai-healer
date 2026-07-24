import * as fs from 'fs';
import * as path from 'path';
import { test as base } from '@playwright/test';
import { AutoHealer } from '../../src/AutoHealer.js';
import { BooksHomePage } from '../../src/pages/BooksHomePage.js';
import { BooksToScrapeHandler } from '../../src/utils/SiteHandler.js';
import { config } from '../../src/config/index.js';
import { logger } from '../../src/utils/Logger.js';
import { HealingMetrics } from '../../src/utils/HealingMetrics.js';
import { HEALING_SHARD_DIR } from '../../src/reporters/HealingReporter.js';

// Define custom fixtures
type MyFixtures = {
    autoHealer: AutoHealer | undefined;
    booksPage: BooksHomePage;
};

type MyWorkerFixtures = {
    healingMetricsShard: void;
};

export const test = base.extend<MyFixtures, MyWorkerFixtures>({
    /**
     * Flush this worker's healing events to a shard file during teardown.
     *
     * `HealingMetrics` is a per-process singleton and Playwright runs tests in
     * worker processes, while reporters run in the main process — so a reporter
     * cannot read these events directly. Each worker writes its own shard and
     * `HealingReporter` merges them in `onEnd`.
     *
     * Auto and worker-scoped: every spec benefits without opting in, and the
     * flush happens once per worker rather than once per test.
     */
    healingMetricsShard: [
        // eslint-disable-next-line no-empty-pattern
        async ({}, use, workerInfo) => {
            await use();

            const events = HealingMetrics.getInstance().getEvents();
            if (events.length === 0) return;

            try {
                fs.mkdirSync(HEALING_SHARD_DIR, { recursive: true });
                // workerIndex alone can repeat when Playwright restarts a crashed
                // worker; the pid keeps a restarted worker from clobbering the
                // shard its predecessor already wrote.
                const shard = path.join(HEALING_SHARD_DIR, `worker-${workerInfo.workerIndex}-${process.pid}.json`);
                fs.writeFileSync(shard, JSON.stringify(events, null, 2), 'utf-8');
                logger.debug(`[Fixture] Wrote ${events.length} healing event(s) to ${shard}`);
            } catch (error) {
                // A metrics artifact must never be the reason a green run fails.
                logger.warn(`[Fixture] Could not write healing metrics shard: ${String(error)}`);
            }
        },
        { scope: 'worker', auto: true },
    ],

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
