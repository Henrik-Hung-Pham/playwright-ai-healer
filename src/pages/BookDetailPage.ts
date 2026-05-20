import { expect } from '@playwright/test';
import { BasePage } from './BasePage.js';
import { logger } from '../utils/Logger.js';
import { config } from '../config/index.js';

import locators from '../config/locators.json' with { type: 'json' };

const { bookDetailTitle, bookDetailPrice } = locators.booksToScrape;

/**
 * BookDetailPage - Page object for individual book detail pages on Books to Scrape.
 *
 * Provides access to book metadata (title, price) and the add-to-cart action.
 *
 * @example
 * ```typescript
 * const detailPage = await homePage.clickBook(0);
 * const title = await detailPage.getTitle();
 * await detailPage.addToCart();
 * ```
 */
export class BookDetailPage extends BasePage {
    private readonly timeouts = config.test.timeouts;

    /**
     * Get the book title from the detail page.
     *
     * @returns The book title text.
     */
    async getTitle(): Promise<string> {
        const titleEl = this.page.locator(bookDetailTitle).first();
        await titleEl.waitFor({
            state: 'visible',
            timeout: this.timeouts.productVisibility,
        });
        const text = await titleEl.textContent();
        return text?.trim() ?? '';
    }

    /**
     * Get the book price from the detail page.
     *
     * @returns The price text (e.g. "51.77").
     */
    async getPrice(): Promise<string> {
        const priceEl = this.page.locator(bookDetailPrice).first();
        await priceEl.waitFor({
            state: 'visible',
            timeout: this.timeouts.productVisibility,
        });
        const text = await priceEl.textContent();
        return text?.trim() ?? '';
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
