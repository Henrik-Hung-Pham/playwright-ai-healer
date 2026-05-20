import type { Page, Locator } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { AutoHealer } from '../AutoHealer.js';
import { logger } from '../utils/Logger.js';
import { config } from '../config/index.js';
import { type SiteHandler, BooksToScrapeHandler } from '../utils/SiteHandler.js';

/**
 * BasePage - Abstract base class for all page objects.
 *
 * Provides overlay dismissal (cookie banners, security challenges), self-healing
 * interaction wrappers, and Vercel security challenge detection. Extend this class
 * for every page object and use `safeClick()` / `safeFill()` rather than calling
 * Playwright directly so interactions automatically benefit from healing.
 *
 * @example
 * ```typescript
 * class SearchPage extends BasePage {
 *   async search(term: string) {
 *     await this.safeClick('booksToScrape.bookTitle');
 *   }
 * }
 * ```
 */
export abstract class BasePage {
    /** Playwright page instance for direct access when needed. */
    public page: Page;
    /** AutoHealer instance used for self-healing interactions. `undefined` when running without AI. */
    public autoHealer: AutoHealer | undefined;
    protected siteHandler: SiteHandler;

    // -------------------------------------------------------------------------
    // Per-page (static) security-challenge tracking
    //
    // Each test creates multiple BasePage subclass instances that share the same
    // Playwright Page (e.g. BooksHomePage -> BookDetailPage via clickBook).
    // Using instance fields means the NEW subclass instance starts with a fresh
    // signal that was never fired, even if the parent already detected the
    // challenge.  Static WeakMaps keyed on the Page object fix this: all
    // instances sharing a page see the same failed flag and abort signal.
    // -------------------------------------------------------------------------
    private static readonly _pageChallengeFailed = new WeakSet<Page>();
    private static readonly _pageSignals = new WeakMap<
        Page,
        { signal: Promise<never>; reject: ((err: Error) => void) | null }
    >();
    /** Guards against registering more than one response listener per Page. */
    private static readonly _pageListenerAttached = new WeakSet<Page>();

    /**
     * @param page - Playwright page instance.
     * @param autoHealer - Optional AutoHealer for self-healing. Omit to use plain Playwright.
     * @param siteHandler - Site-specific overlay handler. Defaults to `BooksToScrapeHandler`.
     */
    constructor(page: Page, autoHealer?: AutoHealer, siteHandler: SiteHandler = new BooksToScrapeHandler()) {
        this.page = page;
        this.autoHealer = autoHealer;
        this.siteHandler = siteHandler;

        // Initialise the per-page abort signal once; subsequent instances reuse it.
        if (!BasePage._pageSignals.has(page)) {
            const entry: { signal: Promise<never>; reject: ((err: Error) => void) | null } = {
                signal: undefined as unknown as Promise<never>,
                reject: null,
            };
            entry.signal = new Promise<never>((_, reject) => {
                entry.reject = reject;
            });
            // Attach a no-op handler so Node.js never emits unhandledRejection
            // if the signal fires after all racers have already resolved.
            entry.signal.catch(() => {});
            BasePage._pageSignals.set(page, entry);
        }

        const alreadyFailed = BasePage._pageChallengeFailed.has(page);
        if (alreadyFailed) {
            logger.info(
                `[BasePage:${this.constructor.name}] page challenge ALREADY failed, skip will trigger on first action`
            );
        }

        // Monitor for Vercel security challenge failures.
        // Register at most one listener per Page to prevent accumulation across
        // multiple BasePage subclass instances sharing the same Playwright Page.
        if (!BasePage._pageListenerAttached.has(page)) {
            BasePage._pageListenerAttached.add(page);
            this.page.on('response', response => {
                if (
                    config.ai.security.vercelChallengePath &&
                    response.url().includes(config.ai.security.vercelChallengePath)
                ) {
                    const status = response.status();
                    if (status >= 400) {
                        logger.warn(
                            `🚨 [BasePage] Vercel security challenge failed` +
                                ` with status ${status} — aborting all pending operations on this page`
                        );
                        BasePage._pageChallengeFailed.add(page);
                        BasePage._pageSignals
                            .get(page)
                            ?.reject?.(new Error(`Vercel security challenge failed with status ${status}`));
                    }
                }
            });
        }
    }

    /**
     * Navigate to the given URL.
     *
     * @param url - Absolute URL to navigate to.
     */
    async goto(url: string) {
        await this.page.goto(url);
    }

    /**
     * Pause execution for a fixed duration.
     *
     * @param ms - Duration to wait in milliseconds.
     */
    async wait(ms: number) {
        await this.page.waitForTimeout(ms);
    }

    /**
     * Wait for the page to reach `load` and `domcontentloaded` states.
     *
     * @param options.timeout - Maximum wait time in milliseconds.
     * @param options.networking - When `true`, also waits for `networkidle` after load states.
     */
    async waitForPageLoad(options?: { timeout?: number; networking?: boolean }): Promise<void> {
        const { timeout, networking } = options ?? {};
        const pwOptions = timeout !== undefined ? { timeout } : undefined;
        await this.page.waitForLoadState('domcontentloaded', pwOptions);
        await this.page.waitForLoadState('load', pwOptions);
        if (networking) {
            // networkidle requires 500ms of zero activity — unreliable on polling/streaming pages.
            // Cap it at the configured short timeout to avoid long hangs.
            const networkIdleTimeout = Math.min(timeout ?? config.test.timeouts.short, config.test.timeouts.short);
            await this.page.waitForLoadState('networkidle', { timeout: networkIdleTimeout }).catch((error: unknown) => {
                if (error instanceof Error && (error.name === 'TimeoutError' || error.message.includes('Timeout'))) {
                    logger.debug('[BasePage] ⏱️ networkidle timed out; proceeding after load');
                } else {
                    throw error;
                }
            });
        }
    }

    private overlaysDismissed = false;

    protected skipTest(reason: string): void {
        test.skip(true, reason);
    }

    protected checkSecurityChallenge(): void {
        const failed = BasePage._pageChallengeFailed.has(this.page);
        logger.debug(`[BasePage:${this.constructor.name}] checkSecurityChallenge — failed: ${failed}`);
        if (failed) {
            logger.warn(
                `🚫 [${this.constructor.name}] Skipping test — Vercel security challenge previously detected on this page`
            );
            this.skipTest('Aborting test due to Vercel security challenge failure');
        }
    }

    /**
     * Race `fn` against the per-page security-challenge abort signal.
     *
     * When the Vercel security challenge fires the shared signal rejects
     * immediately, aborting `fn` without waiting for its own timeout.
     * `checkSecurityChallenge()` then marks the test as skipped.
     * If `fn` fails for an unrelated reason the original error is re-thrown.
     */
    protected async withSecurityCheck<T>(fn: () => Promise<T>): Promise<T> {
        const signal = BasePage._pageSignals.get(this.page)!.signal;
        const task = fn();
        try {
            return await Promise.race([task, signal]);
        } catch (e) {
            // Suppress any future rejection from the still-running task so Node.js
            // does not emit an unhandledRejection warning after we've moved on.
            task.catch(() => {});
            if (BasePage._pageChallengeFailed.has(this.page)) {
                logger.info(
                    `[BasePage:${this.constructor.name}] withSecurityCheck — security signal fired, aborting task`
                );
            } else {
                logger.debug(
                    `[BasePage:${this.constructor.name}] withSecurityCheck — non-security error: ${(e as Error)?.message}`
                );
            }
            this.checkSecurityChallenge(); // throws SkipError when challenge has fired
            throw e; // re-throw the original error when it's unrelated to the challenge
        }
    }

    protected async dismissOverlaysBeforeAction(): Promise<void> {
        await this.waitForPageLoad({ networking: true, timeout: config.test.timeouts.default });
        this.checkSecurityChallenge();
        await this.siteHandler.dismissOverlays(this.page);
        this.overlaysDismissed = true;
    }

    private async ensureOverlaysDismissed(): Promise<void> {
        if (!this.overlaysDismissed) {
            await this.dismissOverlaysBeforeAction();
        } else {
            // Always re-check on subsequent actions: the banner may have re-appeared
            // after the initial dismissal (e.g. due to site JS re-initialisation).
            this.checkSecurityChallenge();
            await this.siteHandler.dismissOverlays(this.page);
        }
    }

    /**
     * Click an element, dismissing overlays first and delegating to `AutoHealer` when available.
     *
     * Accepts a dot-notation locator key (e.g. `booksToScrape.bookTitle`) or a raw CSS selector.
     * When a string selector is provided and `autoHealer` is configured, healing is attempted
     * automatically on failure. When a `Locator` object is provided, it is clicked directly.
     *
     * @param selectorOrLocator - Dot-notation locator key, CSS selector, or Playwright `Locator`.
     * @param options.force - Bypass actionability checks.
     * @param options.timeout - Maximum time in milliseconds to wait for the element.
     */
    async safeClick(
        selectorOrLocator: string | Locator,
        options?: { force?: boolean; timeout?: number }
    ): Promise<void> {
        await this.ensureOverlaysDismissed();
        if (typeof selectorOrLocator === 'string') {
            if (this.autoHealer) {
                await this.withSecurityCheck(() => this.autoHealer!.click(selectorOrLocator, options));
            } else {
                await this.withSecurityCheck(() => this.page.click(selectorOrLocator, options));
            }
        } else {
            await this.withSecurityCheck(() => selectorOrLocator.click(options));
        }
    }

    /**
     * Fill an input element, dismissing overlays first and delegating to `AutoHealer` when available.
     *
     * When a string selector is provided and `autoHealer` is configured, healing is attempted
     * automatically on failure. When a `Locator` object is provided, the fill is retried with
     * `toPass` to handle transient focus/clear timing issues.
     *
     * @param selectorOrLocator - Dot-notation locator key, CSS selector, or Playwright `Locator`.
     * @param value - Text value to fill into the element.
     * @param options.force - Bypass actionability checks.
     * @param options.timeout - Maximum time in milliseconds for the overall fill operation.
     */
    async safeFill(
        selectorOrLocator: string | Locator,
        value: string,
        options?: { force?: boolean; timeout?: number }
    ): Promise<void> {
        await this.ensureOverlaysDismissed();

        if (typeof selectorOrLocator === 'string') {
            if (this.autoHealer) {
                await this.withSecurityCheck(() => this.autoHealer!.fill(selectorOrLocator, value, options));
            } else {
                await this.withSecurityCheck(() => this.page.fill(selectorOrLocator, value, options));
            }
            return;
        }

        const timeout = options?.timeout ?? config.test.timeouts.default;

        await this.withSecurityCheck(() =>
            expect(async () => {
                await selectorOrLocator.focus({ timeout: config.test.timeouts.short }).catch(() => {});
                await selectorOrLocator.clear({ timeout: config.test.timeouts.short }).catch(() => {});

                await selectorOrLocator.fill(value, {
                    force: true,
                    timeout: config.test.timeouts.short,
                    ...options,
                });

                await expect(selectorOrLocator).toHaveValue(value, { timeout: config.test.timeouts.short });
            }).toPass({ timeout })
        );
    }

    /**
     * Verify URL after dismissing any overlays and waiting for page load
     */
    async safeVerifyURL(pattern: RegExp, options?: { timeout?: number }): Promise<void> {
        await this.ensureOverlaysDismissed();
        await expect(this.page).toHaveURL(pattern, options);
    }

    /**
     * Verify input value after waiting for page load
     */
    async expectValue(locator: Locator, value: string): Promise<void> {
        await this.waitForPageLoad({ networking: true, timeout: config.test.timeouts.default });
        await expect(locator).toHaveValue(value);
    }

    /**
     * Find first matching element from multiple selectors
     * @param selectors Array of CSS selectors to try
     * @param options Optional waitFor options
     * @returns Locator for the first matching element
     */
    async findFirstElement(
        selectors: string[],
        options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }
    ): Promise<Locator> {
        await this.waitForPageLoad({ networking: true, timeout: config.test.timeouts.default });
        const combinedSelector = selectors.join(',');
        const locator = this.page.locator(combinedSelector).first();

        if (options) {
            await this.withSecurityCheck(() => locator.waitFor(options!));
        }

        return locator;
    }
}
