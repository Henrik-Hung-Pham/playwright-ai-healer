import { expect } from '@playwright/test';
import { BasePage } from './BasePage.js';
import { logger } from '../utils/Logger.js';
import { config } from '../config/index.js';
import { BookDetailPage } from './BookDetailPage.js';

import locators from '../config/locators.json' with { type: 'json' };

const { categoryLink, bookCard, bookTitle, bookPrice, addToCartButton, nextPageButton } = locators.booksToScrape;

/**
 * BooksHomePage - Page object for the Books to Scrape home page.
 *
 * Provides navigation by sidebar category, book counting, book clicking,
 * and pagination support. Demonstrates that the self-healing framework
 * generalizes as the primary test target.
 *
 * @example
 * ```typescript
 * const homePage = new BooksHomePage(page, autoHealer, new BooksToScrapeHandler());
 * await homePage.open();
 * await homePage.navigateToCategory('Mystery');
 * const count = await homePage.getBookCount();
 * ```
 */
export class BooksHomePage extends BasePage {
    private readonly url = config.app.baseUrl;
    private readonly timeouts = config.test.timeouts;

    /**
     * Navigate to the Books to Scrape home page.
     */
    async open(): Promise<void> {
        logger.debug(`Navigating to ${this.url} ...`);
        await this.goto(this.url);
        await this.dismissOverlaysBeforeAction();
    }

    /**
     * Navigate to a book category via the sidebar.
     *
     * @param category - Display name of the category (e.g. 'Mystery', 'Travel').
     */
    async navigateToCategory(category: string): Promise<void> {
        logger.debug(`Navigating to category: ${category}...`);

        const link = this.page
            .locator(categoryLink)
            .filter({ hasText: new RegExp(`^\\s*${category}\\s*`, 'i') })
            .first();

        await this.safeClick(link, { timeout: this.timeouts.default });
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });

        logger.debug(`Navigated to ${category} category.`);
    }

    /**
     * Count the number of visible books on the current page.
     *
     * @returns The number of book cards visible on the page.
     */
    async getBookCount(): Promise<number> {
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });
        const count = await this.page.locator(bookCard).count();
        logger.debug(`Found ${count} books on the page.`);
        return count;
    }

    /**
     * Click a specific book by its zero-based index on the page.
     *
     * @param index - Zero-based index of the book to click (default: 0).
     * @returns A BookDetailPage instance for the selected book.
     */
    async clickBook(index: number = 0): Promise<BookDetailPage> {
        logger.debug(`Clicking book at index ${index}...`);

        const bookLink = this.page.locator(bookTitle).nth(index);
        await this.safeClick(bookLink, { timeout: this.timeouts.default });
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });

        logger.debug('Navigated to book detail page.');
        return new BookDetailPage(this.page, this.autoHealer, this.siteHandler);
    }

    /**
     * Verify that books are displayed on the current page.
     *
     * @throws AssertionError if no books are visible within the timeout.
     */
    async verifyBooksDisplayed(): Promise<void> {
        logger.debug('Verifying books are displayed...');
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });

        await this.page
            .locator(bookCard)
            .first()
            .waitFor({ state: 'visible', timeout: this.timeouts.productVisibility });

        const count = await this.page.locator(bookCard).count();
        expect(count).toBeGreaterThan(0);

        logger.debug(`Verified ${count} books are displayed.`);
    }

    /**
     * Click the "Add to basket" button for a specific book on the listing page.
     *
     * @param index - Zero-based index of the book (default: 0).
     */
    async addToCart(index: number = 0): Promise<void> {
        logger.debug(`Adding book at index ${index} to cart...`);
        const button = this.page.locator(bookCard).nth(index).locator(addToCartButton);
        await this.safeClick(button, { timeout: this.timeouts.default });
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });
        logger.debug('Book added to cart.');
    }

    /**
     * Check whether a "next" pagination link exists on the current page.
     *
     * @returns `true` if a next-page link is present.
     */
    async hasNextPage(): Promise<boolean> {
        const nextBtn = this.page.locator(nextPageButton);
        return nextBtn.isVisible().catch(() => false);
    }

    /**
     * Navigate to the next page of results.
     *
     * @throws Error if no next page link is available.
     */
    async goToNextPage(): Promise<void> {
        logger.debug('Navigating to next page...');
        const nextBtn = this.page.locator(nextPageButton);
        await this.safeClick(nextBtn, { timeout: this.timeouts.default });
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });
        logger.debug('Navigated to next page.');
    }

    /**
     * Get the price of a book by its zero-based index.
     *
     * @param index - Zero-based index of the book (default: 0).
     * @returns The price text (e.g. "51.77").
     */
    async getBookPrice(index: number = 0): Promise<string> {
        const price = this.page.locator(bookCard).nth(index).locator(bookPrice).first();
        const text = await price.textContent();
        return text?.trim() ?? '';
    }
}
