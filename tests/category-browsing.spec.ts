import { test } from './fixtures/base.js';

test.describe('Category Browsing', () => {
    const categories = ['Travel', 'Mystery', 'Poetry'] as const;

    for (const category of categories) {
        test(`should navigate to ${category} category and display books`, async ({ booksPage }) => {
            await booksPage.open();
            await booksPage.navigateToCategory(category);
            await booksPage.verifyBooksDisplayed();
        });
    }

    test('should navigate to Historical Fiction category and display books', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Historical Fiction');
        await booksPage.verifyBooksDisplayed();
    });

    test('should navigate to Science Fiction category and display books', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Science Fiction');
        await booksPage.verifyBooksDisplayed();
    });
});
