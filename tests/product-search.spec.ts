import { test, expect } from './fixtures/base.js';

/**
 * Books to Scrape has no search box — the closest user journey is category
 * navigation. These tests treat each category as a "search by topic" and
 * verify that the corresponding listing displays results.
 */
test.describe('Category Search Journey', () => {
    test('should navigate to a category and land on a results listing', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Mystery');
        await booksPage.verifyBooksDisplayed();
    });

    test('should navigate to a category and open the first book detail page', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Travel');
        await booksPage.verifyBooksDisplayed();

        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();
    });

    test('should navigate to different categories and get results each time', async ({ booksPage }) => {
        await booksPage.open();

        // First category
        await booksPage.navigateToCategory('Poetry');
        await booksPage.verifyBooksDisplayed();

        // Navigate back to home and pick another category
        await booksPage.open();
        await booksPage.navigateToCategory('Science Fiction');
        await booksPage.verifyBooksDisplayed();

        // The URL should reflect the second category
        await expect(booksPage.page).toHaveURL(/science-fiction/i);
    });
});
