import { expect } from '@playwright/test';
import { BasePage } from './BasePage.js';
import { logger } from '../utils/Logger.js';
import { config } from '../config/index.js';

/**
 * Dot-path keys into the locator store. Both target a single element, so they
 * are passed to the healer as bare keys — letting a repaired selector be
 * persisted back to the store for subsequent runs.
 */
const KEYS = {
    bookDetailTitle: 'booksToScrape.bookDetailTitle',
    bookDetailPrice: 'booksToScrape.bookDetailPrice',
} as const;

/**
 * BookDetailPage - Page object for individual book detail pages on Books to Scrape.
 *
 * Provides access to book metadata (title, price) and the add-to-cart action.
 * Reads route through `AutoHealer` via {@link BasePage.safeWaitForSelector}, so a
 * stale detail-page selector is repaired rather than failing the assertion.
 *
 * @example
 * ```typescript
 * const detailPage = await homePage.clickBook(0);
 * const title = await detailPage.getTitle();
 * ```
 */
export class BookDetailPage extends BasePage {
    private readonly timeouts = config.test.timeouts;

    /**
     * Read the text of a healed single-element selector.
     *
     * Waiting through the healer first means the selector resolved by
     * {@link BasePage.selectorFor} afterwards reflects any repair that just
     * happened, rather than the stale value that failed.
     *
     * @param key - Dot-path locator key.
     * @returns Trimmed text content, or an empty string when the node has none.
     */
    private async healedText(key: string): Promise<string> {
        await this.safeWaitForSelector(key, {
            state: 'visible',
            timeout: this.timeouts.productVisibility,
        });
        const text = await this.page.locator(this.selectorFor(key)).first().textContent();
        return text?.trim() ?? '';
    }

    /**
     * Get the book title from the detail page.
     *
     * @returns The book title text.
     */
    async getTitle(): Promise<string> {
        return this.healedText(KEYS.bookDetailTitle);
    }

    /**
     * Get the book price from the detail page.
     *
     * @returns The price text (e.g. "51.77").
     */
    async getPrice(): Promise<string> {
        return this.healedText(KEYS.bookDetailPrice);
    }

    /**
     * Verify that the book detail page is displaying correctly
     * by asserting the title and price are visible and non-empty.
     */
    async verifyBookDisplayed(): Promise<void> {
        logger.debug('Verifying book detail page...');

        const title = await this.getTitle();
        expect(title.length).toBeGreaterThan(0);

        const price = await this.getPrice();
        expect(price.length).toBeGreaterThan(0);

        logger.debug(`Verified book displayed: "${title}" at ${price}`);
    }
}
