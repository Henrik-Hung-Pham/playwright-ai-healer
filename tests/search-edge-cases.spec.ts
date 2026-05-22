import { test, expect } from './fixtures/base.js';
import { config } from '../src/config/index.js';

/**
 * Category navigation edge cases. Books to Scrape has no search box, so we
 * exercise the category sidebar with case variations and URL-shape assertions
 * to guard against regressions in the navigation matcher.
 */
test.describe('Category Navigation Edge Cases', () => {
    test('should navigate to a category matched case-insensitively (lower-case)', async ({ booksPage }) => {
        await booksPage.open();
        // The matcher in navigateToCategory uses a case-insensitive regex,
        // so a lower-case label should still resolve to the Travel link.
        await booksPage.navigateToCategory('travel');
        await booksPage.verifyBooksDisplayed();

        await expect(booksPage.page).toHaveURL(/travel/i, {
            timeout: config.test.timeouts.urlVerify,
        });
    });

    test('should navigate to a category matched case-insensitively (upper-case)', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('MYSTERY');
        await booksPage.verifyBooksDisplayed();

        await expect(booksPage.page).toHaveURL(/mystery/i, {
            timeout: config.test.timeouts.urlVerify,
        });
    });

    test('should navigate to a category with multi-word name (Historical Fiction)', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Historical Fiction');
        await booksPage.verifyBooksDisplayed();

        await expect(booksPage.page).toHaveURL(/historical-fiction/i, {
            timeout: config.test.timeouts.urlVerify,
        });
    });
});
