import { type Page, test } from '@playwright/test';
import { config } from './config/index.js';
import { LocatorManager } from './utils/LocatorManager.js';
import { logger } from './utils/Logger.js';
import { AIClientManager } from './ai/AIClientManager.js';
import { HealingEngine } from './ai/HealingEngine.js';
import type {
    AIProvider,
    ClickOptions,
    FillOptions,
    HoverOptions,
    TypeOptions,
    SelectOptionOptions,
    SelectOptionValues,
    CheckOptions,
    WaitForSelectorOptions,
    HealingResult,
    HealingEvent,
    HealOperation,
    HealAllResult,
} from './types.js';

/**
 * AutoHealer - Self-healing test automation agent
 *
 * This class wraps Playwright page interactions and automatically attempts to heal
 * broken selectors using AI (OpenAI or Google Gemini) when interactions fail.
 * The AI healing logic is delegated to {@link HealingEngine}, making this class
 * a thin Playwright-interaction layer.
 *
 * @example
 * ```typescript
 * const healer = new AutoHealer(page, process.env['GEMINI_API_KEY']!, 'gemini');
 * await healer.click('booksToScrape.searchInput');
 * await healer.fill('booksToScrape.searchInput', 'laptop');
 * ```
 */
export class AutoHealer {
    private page: Page;
    private debug: boolean;
    private healingEngine: HealingEngine;

    /**
     * Creates an AutoHealer instance
     *
     * @param page - Playwright page instance
     * @param apiKeys - API key(s) for the AI provider. Can be a single key or array for rotation
     * @param provider - AI provider to use ('openai' or 'gemini')
     * @param modelName - Model name to use (defaults based on provider)
     * @param debug - Enable debug logging
     */
    constructor(
        page: Page,
        apiKeys: string | string[],
        provider: AIProvider = 'gemini',
        modelName?: string,
        debug = false
    ) {
        this.page = page;
        this.debug = debug;
        const resolvedModel =
            modelName || (provider === 'openai' ? config.ai.openai.modelName : config.ai.gemini.modelName);
        const clientManager = new AIClientManager(apiKeys, provider, resolvedModel, debug);
        this.healingEngine = new HealingEngine(clientManager);
    }

    /**
     * Safe click method that attempts self-healing on failure
     *
     * Attempts to click on an element. If the click fails, uses AI to find
     * a new selector and retries the click.
     *
     * @param selectorOrKey - CSS selector or locator key from locators.json
     * @param options - Playwright click options
     * The test is skipped (`test.skip`) when the AI cannot return a usable
     * replacement selector. If a healed selector is returned but interaction
     * still fails, behaviour follows `config.ai.healing.failureMode`
     * (`fail` → throw, `skip` → `test.skip`).
     */
    async click(selectorOrKey: string, options?: ClickOptions) {
        await this.executeAction(
            selectorOrKey,
            'click',
            async selector => {
                await this.page.click(selector, { timeout: config.test.timeouts.short, ...options });
            },
            async selector => {
                await this.page.click(selector, options);
            }
        );
    }

    /**
     * Safe fill method that attempts self-healing on failure
     *
     * Attempts to fill an input element. If the fill fails, uses AI to find
     * a new selector and retries the fill.
     *
     * @param selectorOrKey - CSS selector or locator key from locators.json
     * @param value - Text value to fill
     * @param options - Playwright fill options
     * The test is skipped (`test.skip`) when the AI cannot return a usable
     * replacement selector. If a healed selector is returned but interaction
     * still fails, behaviour follows `config.ai.healing.failureMode`
     * (`fail` → throw, `skip` → `test.skip`).
     */
    async fill(selectorOrKey: string, value: string, options?: FillOptions) {
        await this.executeAction(
            selectorOrKey,
            'fill',
            async selector => {
                await this.page.fill(selector, value, { timeout: config.test.timeouts.short, ...options });
            },
            async selector => {
                await this.page.fill(selector, value, options);
            }
        );
    }

    private async executeAction(
        selectorOrKey: string,
        actionName: string,
        actionFn: (selector: string) => Promise<void>,
        retryFn: (selector: string) => Promise<void>
    ) {
        const locatorManager = LocatorManager.getInstance();
        const selector = locatorManager.getLocator(selectorOrKey) || selectorOrKey;
        const locatorKey = locatorManager.getLocator(selectorOrKey) ? selectorOrKey : null;

        try {
            if (this.debug)
                logger.info(`[AutoHealer] 🎯 Attempting ${actionName} on: ${selector} (Key: ${locatorKey || 'N/A'})`);
            try {
                await this.page.locator(selector).waitFor({ state: 'visible', timeout: config.test.timeouts.short });
            } catch {
                logger.warn(
                    `[AutoHealer] ⚠️ Element ${selector} not visible after timeout. Proceeding to action anyway.`
                );
            }
            await actionFn(selector);
        } catch (error) {
            logger.warn(`[AutoHealer] 💥 ${actionName} failed on: ${selector}. Initiating healing protocol...`);
            if (locatorKey) {
                await locatorManager.recordSelectorFailure(locatorKey);
            }
            const result = await this.heal(selector, error as Error);
            if (result) {
                logger.info(`[AutoHealer] 🔄 Retrying with new selector: ${result.selector}`);

                try {
                    // Pre-validation: verify new selector exists before attempting action
                    try {
                        const target = this.page.locator(result.selector);
                        const count = await target.count();
                        if (count === 0) {
                            throw new Error(
                                `Healed selector '${result.selector}' resulted in 0 matches in the active DOM.`
                            );
                        }
                    } catch (validationErr) {
                        logger.warn(`[AutoHealer] ⚠️ Healed selector validation failed: ${String(validationErr)}`);
                        throw validationErr; // Pass to outer catch context for skipping
                    }

                    await retryFn(result.selector);

                    // Update locator if we have a key
                    if (locatorKey) {
                        logger.info(`[AutoHealer] 💾 Updating locator key '${locatorKey}' with new value.`);
                        await locatorManager.updateLocator(locatorKey, result.selector);
                        await locatorManager.recordSelectorHealed(locatorKey);
                    }
                } catch (retryError) {
                    logger.error(`[AutoHealer] ❌ Failed to interact with healed selector: ${String(retryError)}`);
                    const msg = `Healed selector '${result.selector}' failed during interaction.`;
                    if (config.ai.healing.failureMode === 'skip') {
                        test.info().annotations.push({ type: 'warning', description: `Test skipped because ${msg}` });
                        test.skip(true, `Test skipped because ${msg}`);
                    } else {
                        throw new Error(`[AutoHealer] ${msg}`);
                    }
                }
            } else {
                // When the AI cannot return a usable replacement selector, the test
                // physically cannot proceed — always skip regardless of failureMode.
                logger.warn(`[AutoHealer] 🚫 AI could not find a new selector.`);
                const msg = 'AutoHealer AI could not find a suitable replacement selector.';
                test.info().annotations.push({ type: 'warning', description: `Test skipped because ${msg}` });
                test.skip(true, `Test skipped because ${msg}`);
            }
        }
    }

    /**
     * Safe hover method that attempts self-healing on failure
     */
    async hover(selectorOrKey: string, options?: HoverOptions) {
        await this.executeAction(
            selectorOrKey,
            'hover',
            async selector => {
                await this.page.hover(selector, { timeout: config.test.timeouts.click, ...options });
            },
            async selector => {
                await this.page.hover(selector, options);
            }
        );
    }

    /**
     * Safe type method (pressSequentially) that attempts self-healing on failure
     */
    async type(selectorOrKey: string, text: string, options?: TypeOptions) {
        await this.executeAction(
            selectorOrKey,
            'type',
            async selector => {
                await this.page.locator(selector).pressSequentially(text, {
                    ...(options?.delay !== undefined && { delay: options.delay }),
                    timeout: options?.timeout ?? config.test.timeouts.fill,
                });
            },
            async selector => {
                await this.page
                    .locator(selector)
                    .pressSequentially(text, options?.delay !== undefined ? { delay: options.delay } : {});
            }
        );
    }

    /**
     * Safe selectOption method that attempts self-healing on failure
     */
    async selectOption(selectorOrKey: string, values: SelectOptionValues, options?: SelectOptionOptions) {
        await this.executeAction(
            selectorOrKey,
            'selectOption',
            async selector => {
                await this.page.selectOption(selector, values, { timeout: config.test.timeouts.click, ...options });
            },
            async selector => {
                await this.page.selectOption(selector, values, options);
            }
        );
    }

    /**
     * Safe check method that attempts self-healing on failure
     */
    async check(selectorOrKey: string, options?: CheckOptions) {
        await this.executeAction(
            selectorOrKey,
            'check',
            async selector => {
                await this.page.check(selector, { timeout: config.test.timeouts.click, ...options });
            },
            async selector => {
                await this.page.check(selector, options);
            }
        );
    }

    /**
     * Safe uncheck method that attempts self-healing on failure
     */
    async uncheck(selectorOrKey: string, options?: CheckOptions) {
        await this.executeAction(
            selectorOrKey,
            'uncheck',
            async selector => {
                await this.page.uncheck(selector, { timeout: config.test.timeouts.click, ...options });
            },
            async selector => {
                await this.page.uncheck(selector, options);
            }
        );
    }

    /**
     * Safe waitForSelector method that attempts self-healing on failure
     */
    async waitForSelector(selectorOrKey: string, options?: WaitForSelectorOptions) {
        await this.executeAction(
            selectorOrKey,
            'waitForSelector',
            async selector => {
                await this.page.waitForSelector(selector, { timeout: config.test.timeouts.default, ...options });
            },
            async selector => {
                await this.page.waitForSelector(selector, options ?? {});
            }
        );
    }

    /**
     * Get all healing events recorded during the current session.
     * Delegates to {@link HealingEngine.getHealingEvents}.
     */
    getHealingEvents(): readonly HealingEvent[] {
        return this.healingEngine.getHealingEvents();
    }

    /**
     * Heal multiple operations concurrently.
     *
     * Runs all operations sequentially (to avoid Playwright race conditions),
     * then fires AI healing for every failed operation **in parallel**, and
     * retries healed operations sequentially. This reduces total wall-clock
     * time when several selectors need AI-powered repair in the same test run.
     *
     * @param operations - Array of actions to attempt
     * @returns Per-operation results including success flag and healed selector
     *
     * @example
     * ```typescript
     * const results = await healer.healAll([
     *   { selectorOrKey: 'booksToScrape.searchInput', action: 'click' },
     *   { selectorOrKey: 'booksToScrape.cookieBtn',   action: 'click' },
     *   { selectorOrKey: 'booksToScrape.filterBox',   action: 'fill', value: 'laptop' },
     * ]);
     * results.forEach(r => console.log(r.selectorOrKey, r.success, r.healedSelector));
     * ```
     */
    async healAll(operations: HealOperation[]): Promise<HealAllResult[]> {
        const locatorManager = LocatorManager.getInstance();

        // -- Phase 1: attempt all actions, collect failures ----
        type FailureRecord = {
            index: number;
            op: HealOperation;
            selector: string;
            locatorKey: string | null;
            error: Error;
        };

        const results: HealAllResult[] = operations.map(op => ({
            selectorOrKey: op.selectorOrKey,
            success: false,
        }));

        const failures: FailureRecord[] = [];

        for (let i = 0; i < operations.length; i++) {
            const op = operations[i];
            if (!op) continue;
            const resolved = locatorManager.getLocator(op.selectorOrKey);
            const selector = resolved || op.selectorOrKey;
            const locatorKey = resolved ? op.selectorOrKey : null;

            try {
                await this.runOperation(op, selector);
                results[i] = { selectorOrKey: op.selectorOrKey, success: true };
            } catch (err) {
                if (locatorKey) {
                    await locatorManager.recordSelectorFailure(locatorKey);
                }
                failures.push({ index: i, op, selector, locatorKey, error: err as Error });
            }
        }

        if (failures.length === 0) return results;

        logger.info(
            `[AutoHealer:healAll] ⚡ ${failures.length} operation(s) failed — firing AI healing in parallel...`
        );

        // -- Phase 2: heal all failures concurrently ----
        const healed = await Promise.allSettled(failures.map(f => this.heal(f.selector, f.error)));

        // -- Phase 3: retry healed operations sequentially ----
        for (let j = 0; j < failures.length; j++) {
            const failure = failures[j];
            const healResult = healed[j];
            if (!failure || !healResult) continue;

            if (healResult.status === 'fulfilled' && healResult.value) {
                const newSelector = healResult.value.selector;
                try {
                    await this.runOperation(failure.op, newSelector);
                    results[failure.index] = {
                        selectorOrKey: failure.op.selectorOrKey,
                        success: true,
                        healedSelector: newSelector,
                    };
                    if (failure.locatorKey) {
                        await locatorManager.updateLocator(failure.locatorKey, newSelector);
                        await locatorManager.recordSelectorHealed(failure.locatorKey);
                    }
                } catch (retryErr) {
                    results[failure.index] = {
                        selectorOrKey: failure.op.selectorOrKey,
                        success: false,
                        healedSelector: newSelector,
                        error: String(retryErr),
                    };
                }
            } else {
                results[failure.index] = {
                    selectorOrKey: failure.op.selectorOrKey,
                    success: false,
                    error: 'AI could not find a replacement selector',
                };
            }
        }

        return results;
    }

    /**
     * Execute a single HealOperation against the resolved selector.
     * @private
     */
    private async runOperation(op: HealOperation, selector: string): Promise<void> {
        switch (op.action) {
            case 'click':
                await this.page.click(selector, { timeout: config.test.timeouts.click });
                break;
            case 'fill':
                await this.page.fill(selector, op.value ?? '', { timeout: config.test.timeouts.fill });
                break;
            case 'hover':
                await this.page.hover(selector, { timeout: config.test.timeouts.click });
                break;
            case 'type':
                await this.page.locator(selector).pressSequentially(op.value ?? '', {
                    delay: 50,
                });
                break;
            case 'check':
                await this.page.check(selector, { timeout: config.test.timeouts.click });
                break;
            case 'uncheck':
                await this.page.uncheck(selector, { timeout: config.test.timeouts.click });
                break;
            case 'waitForSelector':
                await this.page.waitForSelector(selector, { timeout: config.test.timeouts.default });
                break;
            default: {
                const _exhaustive: never = op.action;
                throw new Error(`[AutoHealer:runOperation] Unsupported action: ${_exhaustive}`);
            }
        }
    }

    /**
     * Delegates healing to the {@link HealingEngine}.
     * @private
     */
    private async heal(originalSelector: string, error: Error): Promise<HealingResult | null> {
        return this.healingEngine.heal(this.page, originalSelector, error);
    }
}
