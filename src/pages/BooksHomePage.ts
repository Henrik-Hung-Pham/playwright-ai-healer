import { expect } from '@playwright/test';
import { BasePage } from './BasePage.js';
import { logger } from '../utils/Logger.js';
import { config } from '../config/index.js';
import { BookDetailPage } from './BookDetailPage.js';

/**
 * Dot-path keys into the locator store. Selectors are resolved through
 * `LocatorManager` at call time (see {@link BasePage.selectorFor}) rather than
 * imported statically, so a selector healed earlier in the same run is used
 * immediately.
 */
const KEYS = {
    categoryLink: 'booksToScrape.categoryLink',
    bookCard: 'booksToScrape.bookCard',
    bookTitle: 'booksToScrape.bookTitle',
    bookPrice: 'booksToScrape.bookPrice',
    addToCartButton: 'booksToScrape.addToCartButton',
    nextPageButton: 'booksToScrape.nextPageButton',
} as const;

/** Escape regular-expression metacharacters in a literal string. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * BooksHomePage - Page object for the Books to Scrape home page.
 *
 * Provides navigation by sidebar category, book counting, book clicking,
 * and pagination support. Demonstrates that the self-healing framework
 * generalizes as the primary test target.
 *
 * Every interaction routes through `AutoHealer` via a selector *string* — either
 * a bare locator key (which also lets a repaired selector be persisted) or a
 * string composed from one. Passing a pre-built `Locator` would skip healing.
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
     * Matching is **case-insensitive but fully anchored**, via Playwright's
     * `:text-matches()` with an `i` flag. Both halves matter: callers pass
     * labels in any case (`'travel'`, `'MYSTERY'`), while anchoring keeps
     * `Fiction` from also selecting `Science Fiction` — which a substring match
     * such as the unquoted `text=` engine would do. The trailing `nth=0` keeps
     * the selector single-match, which Playwright strict mode requires and
     * `AutoHealer` verifies before accepting a healed replacement.
     *
     * @param category - Display name of the category (e.g. 'Mystery', 'Travel').
     */
    async navigateToCategory(category: string): Promise<void> {
        logger.debug(`Navigating to category: ${category}...`);

        // JSON.stringify quotes and escapes the pattern for Playwright's selector parser.
        const pattern = JSON.stringify(`^\\s*${escapeRegExp(category)}\\s*$`);
        const selector = `${this.selectorFor(KEYS.categoryLink)}:text-matches(${pattern}, "i") >> nth=0`;
        await this.safeClick(selector, { timeout: this.timeouts.default });
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
        const count = await this.page.locator(this.selectorFor(KEYS.bookCard)).count();
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

        const selector = `${this.selectorFor(KEYS.bookTitle)} >> nth=${index}`;
        await this.safeClick(selector, { timeout: this.timeouts.default });
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });

        logger.debug('Navigated to book detail page.');
        return new BookDetailPage(this.page, this.autoHealer, this.siteHandler);
    }

    /**
     * Verify that books are displayed on the current page.
     *
     * Routes the wait through `AutoHealer` so a stale `bookCard` selector is
     * repaired rather than failing the assertion outright. The selector is
     * pinned with `nth=0` rather than passed as a bare key: `bookCard` matches
     * every card on the page, and `AutoHealer.assertUniqueMatch()` rejects any
     * healed selector resolving to more than one element — so a bare key here
     * would gain persistence at the cost of making healing impossible.
     *
     * @throws AssertionError if no books are visible within the timeout.
     */
    async verifyBooksDisplayed(): Promise<void> {
        logger.debug('Verifying books are displayed...');
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });

        await this.safeWaitForSelector(`${this.selectorFor(KEYS.bookCard)} >> nth=0`, {
            state: 'visible',
            timeout: this.timeouts.productVisibility,
        });

        const count = await this.page.locator(this.selectorFor(KEYS.bookCard)).count();
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
        const selector =
            `${this.selectorFor(KEYS.bookCard)} >> nth=${index} ` + `>> ${this.selectorFor(KEYS.addToCartButton)}`;
        await this.safeClick(selector, { timeout: this.timeouts.default });
        await this.waitForPageLoad({ networking: true, timeout: this.timeouts.default });
        logger.debug('Book added to cart.');
    }

    /**
     * Check whether a "next" pagination link exists on the current page.
     *
     * Deliberately does *not* heal: absence of the link is the expected answer
     * on the last page, so a "failure" here is information, not a fault.
     *
     * @returns `true` if a next-page link is present.
     */
    async hasNextPage(): Promise<boolean> {
        const nextBtn = this.page.locator(this.selectorFor(KEYS.nextPageButton));
        return nextBtn.isVisible().catch(() => false);
    }

    /**
     * Navigate to the next page of results.
     *
     * Passes the bare locator key so a healed selector is persisted back to the store.
     *
     * @throws Error if no next page link is available.
     */
    async goToNextPage(): Promise<void> {
        logger.debug('Navigating to next page...');
        await this.safeClick(KEYS.nextPageButton, { timeout: this.timeouts.default });
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
        const selector =
            `${this.selectorFor(KEYS.bookCard)} >> nth=${index} ` + `>> ${this.selectorFor(KEYS.bookPrice)} >> nth=0`;
        const text = await this.page.locator(selector).textContent();
        return text?.trim() ?? '';
    }
}
