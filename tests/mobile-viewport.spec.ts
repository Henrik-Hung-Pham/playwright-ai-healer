import { test } from './fixtures/base.js';

/**
 * Mobile viewport tests.
 *
 * Core journeys executed at the default project viewport — when run against
 * the `mobile-chrome`, `mobile-safari`, or `tablet` project the Playwright
 * device descriptor sets the viewport automatically. On desktop projects
 * they still exercise the same flows, which is valuable for regression
 * coverage across the full browser matrix.
 */
test.describe('Mobile Viewport Journeys', () => {
    test('should browse the home page on mobile viewport', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.verifyBooksDisplayed();
    });

    test('should navigate to a category on mobile viewport', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Mystery');
        await booksPage.verifyBooksDisplayed();
    });

    test('should navigate to a category and open a book detail on mobile viewport', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Travel');
        await booksPage.verifyBooksDisplayed();

        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();
    });
});
