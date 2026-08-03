import type { Page, Locator } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { AutoHealer } from '../AutoHealer.js';
import { logger } from '../utils/Logger.js';
import { config } from '../config/index.js';
import { LocatorManager } from '../utils/LocatorManager.js';
import { type SiteHandler, BooksToScrapeHandler } from '../utils/SiteHandler.js';

/**
 * Browser/network error fragments that indicate a transient, retryable
 * navigation failure. The external sites under test occasionally refuse or
 * reset a connection, or momentarily fail to resolve; those blips are worth a
 * retry rather than an immediate test failure. Covers Chromium (`ERR_*`) and
 * Firefox (`NS_ERROR_*`) naming, plus Playwright's navigation `Timeout`.
 */
const TRANSIENT_NAV_ERRORS = [
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_NETWORK_CHANGED',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_TIMED_OUT',
    'ERR_EMPTY_RESPONSE',
    'ERR_SOCKET_NOT_CONNECTED',
    'NS_ERROR_CONNECTION_REFUSED',
    'NS_ERROR_NET_RESET',
    'NS_ERROR_NET_TIMEOUT',
    'Timeout',
] as const;

/** Does this navigation error look like a transient blip worth retrying? */
export function isTransientNavigationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return TRANSIENT_NAV_ERRORS.some(fragment => message.includes(fragment));
}

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

    /** Number of navigation attempts before giving up (initial try + retries). */
    private static readonly NAV_MAX_ATTEMPTS = 3;
    /** Base backoff between navigation retries, multiplied by the attempt number. */
    private static readonly NAV_RETRY_BASE_DELAY_MS = 1000;

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
     * Navigate to the given URL, retrying transient network failures.
     *
     * The external sites under test (e.g. books.toscrape.com) occasionally
     * refuse or reset connections. A bare `page.goto()` surfaces that as an
     * immediate, unrecoverable `ERR_CONNECTION_REFUSED` and fails the whole
     * test. Retrying a small number of times with a short linear backoff
     * absorbs those blips without masking a genuinely unreachable target, which
     * still throws after the final attempt. Non-transient errors (e.g. an
     * invalid URL) are re-thrown immediately without retrying.
     *
     * @param url - Absolute URL to navigate to.
     */
    async goto(url: string) {
        for (let attempt = 1; attempt <= BasePage.NAV_MAX_ATTEMPTS; attempt++) {
            try {
                await this.page.goto(url);
                return;
            } catch (error) {
                if (attempt === BasePage.NAV_MAX_ATTEMPTS || !isTransientNavigationError(error)) {
                    throw error;
                }
                const delay = BasePage.NAV_RETRY_BASE_DELAY_MS * attempt;
                logger.warn(
                    `[BasePage] 🌐 Navigation to ${url} failed (attempt ${attempt}/${BasePage.NAV_MAX_ATTEMPTS}): ` +
                        `${error instanceof Error ? error.message : String(error)}. Retrying in ${delay}ms...`
                );
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
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
     * Resolve a dot-path locator key to its current selector string.
     *
     * Reads through {@link LocatorManager} on every call rather than from a
     * module-scoped `locators.json` import, so a selector repaired earlier in
     * the same run is picked up immediately instead of at next process start.
     *
     * Use this when a selector must be *composed* — pinned to an index, chained
     * into a parent, or narrowed by text — because those forms have to be built
     * from the resolved value. When the target is a single element, prefer
     * passing the bare key to {@link safeClick} / {@link safeWaitForSelector}:
     * a bare key also lets `AutoHealer` persist the repaired selector back to
     * the store, which a composed string cannot do.
     *
     * @param key - Dot-path locator key (e.g. `booksToScrape.bookTitle`).
     * @returns The stored selector, or `key` unchanged when it is not a known key.
     */
    protected selectorFor(key: string): string {
        return LocatorManager.getInstance().getLocator(key) ?? key;
    }

    /**
     * Wait for an element, dismissing overlays first and delegating to `AutoHealer` when available.
     *
     * Pass a bare locator key so a broken selector is both healed and persisted.
     * This is the read-path counterpart to {@link safeClick}: page objects that
     * only *read* an element (title, price) still route through the healer
     * instead of silently failing on a stale selector.
     *
     * @param selectorOrKey - Dot-notation locator key or raw CSS selector.
     * @param options.state - Element state to wait for.
     * @param options.timeout - Maximum time in milliseconds to wait.
     */
    async safeWaitForSelector(
        selectorOrKey: string,
        options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }
    ): Promise<void> {
        await this.ensureOverlaysDismissed();
        if (this.autoHealer) {
            await this.withSecurityCheck(() => this.autoHealer!.waitForSelector(selectorOrKey, options));
        } else {
            await this.withSecurityCheck(() => this.page.waitForSelector(selectorOrKey, options ?? {}));
        }
    }

    /**
     * Click an element, dismissing overlays first and delegating to `AutoHealer` when available.
     *
     * Accepts a dot-notation locator key (e.g. `booksToScrape.bookTitle`) or a raw CSS selector.
     * When a string selector is provided and `autoHealer` is configured, healing is attempted
     * automatically on failure.
     *
     * **Passing a `Locator` bypasses healing entirely** — the object is clicked directly,
     * because a pre-resolved `Locator` carries no selector string for the AI to repair.
     * Prefer a key or a selector string composed via {@link selectorFor}; reserve the
     * `Locator` overload for elements that genuinely cannot be addressed by a selector.
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
