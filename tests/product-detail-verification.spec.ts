import { test, expect } from './fixtures/base.js';

test.describe('Book Detail Verification', () => {
    test('should verify book details after opening from home page', async ({ booksPage }) => {
        await booksPage.open();
        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();

        const title = await detailPage.getTitle();
        expect(title.length).toBeGreaterThan(0);

        const price = await detailPage.getPrice();
        expect(price).toMatch(/\d/); // price should contain at least one digit
    });

    test('should verify book details after navigating from Mystery category', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Mystery');
        await booksPage.verifyBooksDisplayed();

        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();
    });

    test('should verify book details after navigating from Poetry category', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Poetry');
        await booksPage.verifyBooksDisplayed();

        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();

        const title = await detailPage.getTitle();
        expect(title.length).toBeGreaterThan(0);
    });
});
