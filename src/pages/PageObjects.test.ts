import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator } from '@playwright/test';
import { BooksHomePage } from './BooksHomePage.js';
import { BookDetailPage } from './BookDetailPage.js';
import { AutoHealer } from '../AutoHealer.js';
import type { SiteHandler } from '../utils/SiteHandler.js';

/**
 * Selector store used by the mocked LocatorManager. Page objects now resolve
 * keys through `LocatorManager` at call time rather than importing
 * `locators.json` statically, so the mock lives at that seam.
 */
const STORE: Record<string, string> = {
    'booksToScrape.categoryLink': '.side_categories a',
    'booksToScrape.bookCard': 'article.product_pod',
    'booksToScrape.bookTitle': 'article.product_pod h3 a',
    'booksToScrape.bookPrice': '.price_color',
    'booksToScrape.addToCartButton': '.btn-primary',
    'booksToScrape.nextPageButton': '.pager .next a',
    'booksToScrape.bookDetailTitle': '.product_main h1',
    'booksToScrape.bookDetailPrice': '.product_main .price_color',
};

const mockGetLocator = vi.fn((key: string) => STORE[key] ?? null);

vi.mock('../utils/LocatorManager.js', () => ({
    LocatorManager: {
        getInstance: () => ({
            getLocator: (key: string) => mockGetLocator(key),
        }),
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
        mockGetLocator.mockClear();

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
            waitForSelector: vi.fn(),
            waitForTimeout: vi.fn(),
            on: vi.fn(),
        };

        mockAutoHealer = {
            click: vi.fn(),
            fill: vi.fn(),
            waitForSelector: vi.fn(),
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

        it('should route category navigation through the healer with an anchored matcher', async () => {
            await homePage.navigateToCategory('Mystery');
            expect(mockAutoHealer.click).toHaveBeenCalledWith(
                '.side_categories a:text-matches("^\\\\s*Mystery\\\\s*$", "i") >> nth=0',
                expect.any(Object)
            );
            // The Locator overload would bypass healing entirely.
            expect(mockLocator.click).not.toHaveBeenCalled();
        });

        it.each(['travel', 'MYSTERY', 'Historical Fiction'])(
            'should match category %s case-insensitively',
            async category => {
                await homePage.navigateToCategory(category);
                const selector = (mockAutoHealer.click as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
                expect(selector).toContain(':text-matches(');
                expect(selector).toContain('"i"');
                expect(selector).toContain(category);
            }
        );

        it('should anchor the matcher so Fiction never also selects Science Fiction', async () => {
            await homePage.navigateToCategory('Fiction');
            const selector = (mockAutoHealer.click as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
            // `^…$` anchoring is what separates the two labels; a substring
            // matcher such as the unquoted `text=` engine would match both.
            expect(selector).toContain('^\\\\s*Fiction\\\\s*$');
        });

        it('should escape regex metacharacters in a category label', async () => {
            await homePage.navigateToCategory('Sci-Fi (Classic)');
            const selector = (mockAutoHealer.click as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
            expect(selector).toContain('Sci-Fi \\\\(Classic\\\\)');
        });

        it('should get book count', async () => {
            const count = await homePage.getBookCount();
            expect(mockPage.locator).toHaveBeenCalledWith('article.product_pod');
            expect(count).toBe(5);
        });

        it('should route book clicks through the healer pinned to the index', async () => {
            const detailPage = await homePage.clickBook(2);
            expect(mockAutoHealer.click).toHaveBeenCalledWith('article.product_pod h3 a >> nth=2', expect.any(Object));
            expect(detailPage).toBeInstanceOf(BookDetailPage);
        });

        it('should verify books are displayed via a healed, uniqueness-pinned wait', async () => {
            await homePage.verifyBooksDisplayed();
            // Pinned rather than a bare key: assertUniqueMatch() rejects a healed
            // selector matching >1 element, so a bare multi-match key could never heal.
            expect(mockAutoHealer.waitForSelector).toHaveBeenCalledWith(
                'article.product_pod >> nth=0',
                expect.objectContaining({ state: 'visible' })
            );
        });

        it('should route add-to-cart through the healer as a chained selector', async () => {
            await homePage.addToCart(1);
            expect(mockAutoHealer.click).toHaveBeenCalledWith(
                'article.product_pod >> nth=1 >> .btn-primary',
                expect.any(Object)
            );
        });

        it('should report whether a next page exists', async () => {
            const hasNext = await homePage.hasNextPage();
            expect(mockPage.locator).toHaveBeenCalledWith('.pager .next a');
            expect(hasNext).toBe(true);
        });

        it('should return false from hasNextPage when visibility check rejects', async () => {
            (mockLocator.isVisible as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('detached'));
            const hasNext = await homePage.hasNextPage();
            expect(hasNext).toBe(false);
        });

        it('should pass the bare key when paginating so a heal can be persisted', async () => {
            await homePage.goToNextPage();
            expect(mockAutoHealer.click).toHaveBeenCalledWith('booksToScrape.nextPageButton', expect.any(Object));
        });

        it('should get the price of a book by index', async () => {
            const price = await homePage.getBookPrice(0);
            expect(mockPage.locator).toHaveBeenCalledWith('article.product_pod >> nth=0 >> .price_color >> nth=0');
            expect(price).toBe('Test Text');
        });

        it('should return an empty string when a book price is missing', async () => {
            (mockLocator.textContent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
            const price = await homePage.getBookPrice(2);
            expect(price).toBe('');
        });

        it('should fall back to the raw key when it is absent from the store', async () => {
            mockGetLocator.mockImplementationOnce(() => null);
            await homePage.clickBook(0);
            expect(mockAutoHealer.click).toHaveBeenCalledWith('booksToScrape.bookTitle >> nth=0', expect.any(Object));
        });

        it('should click directly without a healer configured', async () => {
            const plainPage = new BooksHomePage(mockPage as Page, undefined, mockSiteHandler);
            await plainPage.goToNextPage();
            expect(mockPage.click).toHaveBeenCalledWith('booksToScrape.nextPageButton', expect.any(Object));
        });
    });

    describe('BookDetailPage', () => {
        let detailPage: BookDetailPage;

        beforeEach(() => {
            detailPage = new BookDetailPage(mockPage as Page, mockAutoHealer as AutoHealer, mockSiteHandler);
        });

        it('should get the book title through a healed wait', async () => {
            const title = await detailPage.getTitle();
            expect(mockAutoHealer.waitForSelector).toHaveBeenCalledWith(
                'booksToScrape.bookDetailTitle',
                expect.objectContaining({ state: 'visible' })
            );
            expect(mockPage.locator).toHaveBeenCalledWith('.product_main h1');
            expect(title).toBe('Test Text');
        });

        it('should get the book price through a healed wait', async () => {
            const price = await detailPage.getPrice();
            expect(mockAutoHealer.waitForSelector).toHaveBeenCalledWith(
                'booksToScrape.bookDetailPrice',
                expect.objectContaining({ state: 'visible' })
            );
            expect(price).toBe('Test Text');
        });

        it('should verify book is displayed', async () => {
            await detailPage.verifyBookDisplayed();
            expect(mockPage.locator).toHaveBeenCalledWith('.product_main h1');
            expect(mockPage.locator).toHaveBeenCalledWith('.product_main .price_color');
        });

        it('should wait directly without a healer configured', async () => {
            const plainPage = new BookDetailPage(mockPage as Page, undefined, mockSiteHandler);
            await plainPage.getTitle();
            expect(mockPage.waitForSelector).toHaveBeenCalledWith(
                'booksToScrape.bookDetailTitle',
                expect.objectContaining({ state: 'visible' })
            );
        });
    });
});
