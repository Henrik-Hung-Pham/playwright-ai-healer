import { test, expect } from './fixtures/base.js';
import { config } from '../src/config/index.js';

test.describe('Back Navigation', () => {
    test('should navigate from home to book detail and go back', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.verifyBooksDisplayed();
        const homeUrl = booksPage.page.url();

        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();

        await booksPage.page.goBack({ waitUntil: 'load' });

        await expect(booksPage.page).toHaveURL(homeUrl, {
            timeout: config.test.timeouts.urlVerify,
        });
        await booksPage.verifyBooksDisplayed();
    });

    test('should navigate from category to book detail and go back to the category listing', async ({ booksPage }) => {
        await booksPage.open();
        await booksPage.navigateToCategory('Travel');
        await booksPage.verifyBooksDisplayed();
        const categoryUrl = booksPage.page.url();

        const detailPage = await booksPage.clickBook(0);
        await detailPage.verifyBookDisplayed();

        await booksPage.page.goBack({ waitUntil: 'load' });

        await expect(booksPage.page).toHaveURL(categoryUrl, {
            timeout: config.test.timeouts.urlVerify,
        });
        await booksPage.verifyBooksDisplayed();
    });
});
