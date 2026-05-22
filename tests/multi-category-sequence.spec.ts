import { test } from './fixtures/base.js';

test.describe('Multi-Category Sequential Navigation', () => {
    test('should navigate between Travel and Mystery categories in sequence', async ({ booksPage }) => {
        await booksPage.open();

        await booksPage.navigateToCategory('Travel');
        await booksPage.verifyBooksDisplayed();

        // Return home and pick a different category
        await booksPage.open();
        await booksPage.navigateToCategory('Mystery');
        await booksPage.verifyBooksDisplayed();
    });

    test('should navigate between Poetry and Science Fiction categories in sequence', async ({ booksPage }) => {
        await booksPage.open();

        await booksPage.navigateToCategory('Poetry');
        await booksPage.verifyBooksDisplayed();

        await booksPage.open();
        await booksPage.navigateToCategory('Science Fiction');
        await booksPage.verifyBooksDisplayed();
    });

    test('should navigate to category, open a book, then go to a different category', async ({ booksPage }) => {
        await booksPage.open();

        // First: Historical Fiction -> book detail
        await booksPage.navigateToCategory('Historical Fiction');
        await booksPage.verifyBooksDisplayed();
        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();

        // Then return home and pick a different top-level category
        await booksPage.open();
        await booksPage.navigateToCategory('Travel');
        await booksPage.verifyBooksDisplayed();
    });
});
