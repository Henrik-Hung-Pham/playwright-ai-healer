import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator } from '@playwright/test';
import { BooksHomePage } from './BooksHomePage.js';
import { BookDetailPage } from './BookDetailPage.js';
import { AutoHealer } from '../AutoHealer.js';
import type { SiteHandler } from '../utils/SiteHandler.js';

// Mock dependencies
vi.mock('../config/locators.json', () => ({
    default: {
        booksToScrape: {
            categoryLink: '.side_categories a',
            bookCard: 'article.product_pod',
            bookTitle: 'article.product_pod h3 a',
            bookPrice: '.price_color',
            addToCartButton: '.btn-primary',
            nextPageButton: '.pager .next a',
            bookDetailTitle: '.product_main h1',
            bookDetailPrice: '.product_main .price_color',
            breadcrumb: '.breadcrumb li',
        },
    },
}));

// Mock logger to avoid clutter
vi.mock('../utils/Logger.js', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe('Page Objects', () => {
    let mockPage: Partial<Page>;
    let mockAutoHealer: Partial<AutoHealer>;
    let mockSiteHandler: SiteHandler;
    let mockLocator: Partial<Locator>;

    beforeEach(() => {
        mockLocator = {
            fill: vi.fn(),
            click: vi.fn(),
            first: vi.fn().mockReturnThis(),
            nth: vi.fn().mockReturnThis(),
            isVisible: vi.fn().mockResolvedValue(true),
            waitFor: vi.fn(),
            focus: vi.fn().mockResolvedValue(undefined),
            clear: vi.fn().mockResolvedValue(undefined),
            count: vi.fn().mockResolvedValue(5),
            filter: vi.fn().mockReturnThis(),
            locator: vi.fn().mockReturnThis(),
            textContent: vi.fn().mockResolvedValue('Test Text'),
        };

        mockPage = {
            goto: vi.fn(),
            click: vi.fn(),
            locator: vi.fn().mockReturnValue(mockLocator),
            getByRole: vi.fn().mockReturnValue(mockLocator),
            waitForLoadState: vi.fn().mockResolvedValue(undefined),
            waitForTimeout: vi.fn(),
            on: vi.fn(),
        };

        mockAutoHealer = {
            click: vi.fn(),
            fill: vi.fn(),
        };

        mockSiteHandler = {
            dismissOverlays: vi.fn().mockResolvedValue(undefined),
        };
    });

    describe('BooksHomePage', () => {
        let homePage: BooksHomePage;

        beforeEach(() => {
            homePage = new BooksHomePage(mockPage as Page, mockAutoHealer as AutoHealer, mockSiteHandler);
        });

        it('should open and navigate to books home page', async () => {
            await homePage.open();
            expect(mockPage.goto).toHaveBeenCalled();
        });

        it('should navigate to a category', async () => {
            await homePage.navigateToCategory('Mystery');
            expect(mockPage.locator).toHaveBeenCalledWith('.side_categories a');
            expect(mockLocator.click).toHaveBeenCalled();
        });

        it('should get book count', async () => {
            const count = await homePage.getBookCount();
            expect(mockPage.locator).toHaveBeenCalledWith('article.product_pod');
            expect(count).toBe(5);
        });

        it('should click a book and return BookDetailPage', async () => {
            const detailPage = await homePage.clickBook(0);
            expect(mockPage.locator).toHaveBeenCalledWith('article.product_pod h3 a');
            expect(mockLocator.click).toHaveBeenCalled();
            expect(detailPage).toBeInstanceOf(BookDetailPage);
        });

        it('should verify books are displayed', async () => {
            await homePage.verifyBooksDisplayed();
            expect(mockPage.locator).toHaveBeenCalledWith('article.product_pod');
            expect(mockLocator.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'visible' }));
        });

        it('should add book to cart from listing page', async () => {
            await homePage.addToCart(0);
            expect(mockPage.locator).toHaveBeenCalledWith('article.product_pod');
            expect(mockLocator.locator).toHaveBeenCalledWith('.btn-primary');
            expect(mockLocator.click).toHaveBeenCalledWith(expect.any(Object));
        });
    });

    describe('BookDetailPage', () => {
        let detailPage: BookDetailPage;

        beforeEach(() => {
            detailPage = new BookDetailPage(mockPage as Page, mockAutoHealer as AutoHealer, mockSiteHandler);
        });

        it('should get the book title', async () => {
            const title = await detailPage.getTitle();
            expect(mockPage.locator).toHaveBeenCalledWith('.product_main h1');
            expect(mockLocator.waitFor).toHaveBeenCalled();
            expect(title).toBe('Test Text');
        });

        it('should get the book price', async () => {
            const price = await detailPage.getPrice();
            expect(mockPage.locator).toHaveBeenCalledWith('.product_main .price_color');
            expect(price).toBe('Test Text');
        });

        it('should verify book is displayed', async () => {
            await detailPage.verifyBookDisplayed();
            expect(mockPage.locator).toHaveBeenCalledWith('.product_main h1');
            expect(mockPage.locator).toHaveBeenCalledWith('.product_main .price_color');
        });
    });
});
