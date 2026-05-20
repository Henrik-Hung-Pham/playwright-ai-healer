import { test, expect } from './fixtures/base.js';

/**
 * Books to Scrape has a flat category sidebar (no nested subcategories).
 * These tests cover deep navigation: category -> book detail, verifying that
 * the listing -> detail path works across a range of categories.
 */
test.describe('Category Deep Navigation', () => {
    const journeys = ['Travel', 'Mystery', 'Historical Fiction', 'Science Fiction', 'Poetry'] as const;

    for (const category of journeys) {
        test(`should navigate to ${category} and open a book detail`, async ({ booksPage }) => {
            await booksPage.open();
            await booksPage.navigateToCategory(category);
            await booksPage.verifyBooksDisplayed();

            const detailPage = await booksPage.clickBook(0);
            await detailPage.verifyBookDisplayed();

            const title = await detailPage.getTitle();
            expect(title.length).toBeGreaterThan(0);
        });
    }
});
