import type { Page } from '@playwright/test';

/**
 * SiteHandler - Strategy interface for site-specific overlay dismissal.
 *
 * Implement this interface to handle cookie banners, consent dialogs, or any
 * other overlay that must be dismissed before page interactions can proceed.
 * Register your implementation via the `BasePage` constructor.
 */
export interface SiteHandler {
    /**
     * Dismiss any overlays (cookie banners, consent dialogs, etc.) on the given page.
     *
     * Implementations should be idempotent — safe to call multiple times. If no overlay
     * is present, this method should return without error.
     *
     * @param page - Playwright page instance to operate on.
     */
    dismissOverlays(page: Page): Promise<void>;
}

/**
 * NoOpHandler - No-operation SiteHandler for sites that have no overlays.
 *
 * Use this as the `siteHandler` argument to `BasePage` when the target site
 * does not require any overlay dismissal.
 */
export class NoOpHandler implements SiteHandler {
    async dismissOverlays(_page: Page): Promise<void> {
        // Do nothing
    }
}

/**
 * BooksToScrapeHandler - SiteHandler for books.toscrape.com.
 *
 * Books to Scrape is a clean test site with no cookie banners or overlays.
 * This handler is a named no-op that exists for clarity and future extensibility
 * (e.g. if the site ever adds consent dialogs or promotional modals).
 */
export class BooksToScrapeHandler implements SiteHandler {
    async dismissOverlays(_page: Page): Promise<void> {
        // books.toscrape.com has no overlays to dismiss
    }
}
