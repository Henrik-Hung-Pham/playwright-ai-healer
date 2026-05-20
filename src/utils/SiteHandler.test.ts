import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { NoOpHandler, BooksToScrapeHandler } from './SiteHandler.js';

describe('SiteHandler', () => {
    let mockPage: Partial<Page>;

    beforeEach(() => {
        vi.clearAllMocks();

        mockPage = {
            waitForResponse: vi.fn(),
            locator: vi.fn(),
            waitForFunction: vi.fn(),
            evaluate: vi.fn(),
        };
    });

    describe('NoOpHandler', () => {
        it('should implement SiteHandler interface', () => {
            const handler = new NoOpHandler();
            expect(handler.dismissOverlays).toBeDefined();
            expect(typeof handler.dismissOverlays).toBe('function');
        });

        it('should resolve without calling any page methods', async () => {
            const handler = new NoOpHandler();
            await handler.dismissOverlays(mockPage as Page);

            expect(mockPage.waitForResponse).not.toHaveBeenCalled();
            expect(mockPage.locator).not.toHaveBeenCalled();
            expect(mockPage.waitForFunction).not.toHaveBeenCalled();
            expect(mockPage.evaluate).not.toHaveBeenCalled();
        });

        it('should return undefined (void promise)', async () => {
            const handler = new NoOpHandler();
            const result = await handler.dismissOverlays(mockPage as Page);
            expect(result).toBeUndefined();
        });
    });

    describe('BooksToScrapeHandler', () => {
        it('should implement SiteHandler interface', () => {
            const handler = new BooksToScrapeHandler();
            expect(handler.dismissOverlays).toBeDefined();
            expect(typeof handler.dismissOverlays).toBe('function');
        });

        it('should resolve without calling any page methods', async () => {
            const handler = new BooksToScrapeHandler();
            await handler.dismissOverlays(mockPage as Page);

            expect(mockPage.locator).not.toHaveBeenCalled();
            expect(mockPage.evaluate).not.toHaveBeenCalled();
        });

        it('should be safe to call multiple times', async () => {
            const handler = new BooksToScrapeHandler();
            await handler.dismissOverlays(mockPage as Page);
            await handler.dismissOverlays(mockPage as Page);
            await handler.dismissOverlays(mockPage as Page);

            expect(mockPage.locator).not.toHaveBeenCalled();
        });
    });
});
