import { test, expect } from './fixtures/base.js';

test.describe('Books to Scrape E2E Tests', () => {
    test.describe('Browse & Verify', () => {
        test('should display books on the home page', async ({ booksPage }) => {
            await booksPage.open();
            await booksPage.verifyBooksDisplayed();

            const count = await booksPage.getBookCount();
            expect(count).toBeGreaterThan(0);
        });

        test('should navigate to a category and display books', async ({ booksPage }) => {
            await booksPage.open();
            await booksPage.navigateToCategory('Mystery');
            await booksPage.verifyBooksDisplayed();
        });

        test('should navigate multiple categories in sequence', async ({ booksPage }) => {
            await booksPage.open();

            const categories = ['Travel', 'Science Fiction', 'Historical Fiction'];
            for (const category of categories) {
                await booksPage.navigateToCategory(category);
                await booksPage.verifyBooksDisplayed();
            }
        });
    });

    test.describe('Book Detail', () => {
        test('should click a book and verify detail page', async ({ booksPage }) => {
            await booksPage.open();
            const detailPage = await booksPage.clickBook(0);
            await detailPage.verifyBookDisplayed();
        });

        test('should display title and price on detail page', async ({ booksPage }) => {
            await booksPage.open();
            const detailPage = await booksPage.clickBook(0);

            const title = await detailPage.getTitle();
            expect(title.length).toBeGreaterThan(0);

            const price = await detailPage.getPrice();
            expect(price).toMatch(/^.+$/); // non-empty price string
        });

        test('should click a book from a category page', async ({ booksPage }) => {
            await booksPage.open();
            await booksPage.navigateToCategory('Poetry');
            await booksPage.verifyBooksDisplayed();

            const detailPage = await booksPage.clickBook(0);
            await detailPage.verifyBookDisplayed();
        });
    });

    test.describe('Pagination', () => {
        test('should detect next page availability on home page', async ({ booksPage }) => {
            await booksPage.open();

            // Home page has 1000 books across 50 pages — next page should exist
            const hasNext = await booksPage.hasNextPage();
            expect(hasNext).toBe(true);
        });

        test('should navigate to the next page and verify books', async ({ booksPage }) => {
            await booksPage.open();
            await booksPage.goToNextPage();
            await booksPage.verifyBooksDisplayed();
        });
    });

    test.describe('Add to Cart', () => {
        test('should add a book to the cart from the home page', async ({ booksPage }) => {
            await booksPage.open();
            await booksPage.verifyBooksDisplayed();
            await booksPage.addToCart(0);
        });
    });

    test.describe('Self-Healing', () => {
        test('should heal a broken selector on the books site', async ({ booksPage, autoHealer }) => {
            test.slow();
            expect(autoHealer).toBeDefined();

            await booksPage.open();

            // Use a broken selector that the AI should heal
            // by finding the correct book card element
            await booksPage.safeClick('#nonexistent-book-card-xyz', {
                timeout: 10000,
            });

            const events = autoHealer!.getHealingEvents();
            expect(events.length).toBeGreaterThan(0);
        });
    });
});
