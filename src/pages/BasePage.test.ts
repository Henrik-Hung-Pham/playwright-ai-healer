import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage.js';
import { AutoHealer } from '../AutoHealer.js';
import type { SiteHandler } from '../utils/SiteHandler.js';
import { config } from '../config/index.js';

// Concrete implementation for testing
class TestPage extends BasePage {
    constructor(page: Page, autoHealer: AutoHealer, siteHandler: SiteHandler) {
        super(page, autoHealer, siteHandler);
    }
}

describe('BasePage', () => {
    let mockPage: Partial<Page>;
    let mockAutoHealer: AutoHealer;
    let mockSiteHandler: SiteHandler;
    let basePage: TestPage;

    beforeEach(() => {
        mockPage = {
            goto: vi.fn(),
            waitForTimeout: vi.fn(),
            locator: vi.fn(),
            waitForLoadState: vi.fn().mockResolvedValue(undefined),
            waitForFunction: vi.fn(),
            getByRole: vi.fn(),
            on: vi.fn().mockReturnThis(), // Returns itself for chaining
        };

        mockAutoHealer = {} as AutoHealer;

        mockSiteHandler = {
            dismissOverlays: vi.fn().mockResolvedValue(undefined),
        };

        basePage = new TestPage(mockPage as unknown as Page, mockAutoHealer, mockSiteHandler);
    });

    describe('Security Challenge Handling', () => {
        it('should skip test when security challenge fails', async () => {
            // Verify listener was attached
            expect(mockPage.on).toHaveBeenCalledWith('response', expect.any(Function));

            // Extract the listener from the mock calls
            const onMock = mockPage.on as ReturnType<typeof vi.fn>;
            const responseCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'response') as
                | unknown[]
                | undefined;
            expect(responseCall).toBeDefined();
            const listener = responseCall![1] as (response: { url: () => string; status: () => number }) => void;

            // Simulate failed security challenge response
            const mockResponse = {
                url: () => `https://books.toscrape.com/${config.ai.security?.vercelChallengePath}`,
                status: () => 403,
            };

            // Trigger the listener
            listener(mockResponse);

            // Spy on the protected skipTest method
            // @ts-expect-error - testing protected method
            const skipSpy = vi.spyOn(basePage, 'skipTest').mockImplementation(() => {});

            await basePage.safeClick({ click: vi.fn() } as unknown as Locator);

            expect(skipSpy).toHaveBeenCalledWith(expect.stringContaining('Aborting test'));
        });
    });

    describe('goto', () => {
        it('should navigate to url', async () => {
            await basePage.goto('http://example.com');
            expect(mockPage.goto).toHaveBeenCalledWith('http://example.com');
        });
    });

    describe('wait', () => {
        it('should wait for timeout', async () => {
            await basePage.wait(1000);
            expect(mockPage.waitForTimeout).toHaveBeenCalledWith(1000);
        });
    });

    describe('safeFill', () => {
        it('should dismiss overlays and fill input', async () => {
            const mockLocatorObj = {
                fill: vi.fn(),
                focus: vi.fn().mockResolvedValue(undefined),
                clear: vi.fn().mockResolvedValue(undefined),
                click: vi.fn(),
            };

            await basePage.safeFill(mockLocatorObj as unknown as Locator, 'test-value');

            expect(mockLocatorObj.focus).toHaveBeenCalled();
            expect(mockLocatorObj.clear).toHaveBeenCalled();
            expect(mockLocatorObj.fill).toHaveBeenCalledWith('test-value', expect.objectContaining({ force: true }));
        });

        it('should suppress errors during focus and clear', async () => {
            const mockLocatorObj = {
                fill: vi.fn(),
                focus: vi.fn().mockRejectedValue(new Error('Focus failed')),
                clear: vi.fn().mockRejectedValue(new Error('Clear failed')),
                click: vi.fn(),
            };

            await basePage.safeFill(mockLocatorObj as unknown as Locator, 'test-value');

            expect(mockLocatorObj.focus).toHaveBeenCalled();
            expect(mockLocatorObj.clear).toHaveBeenCalled();
            expect(mockLocatorObj.fill).toHaveBeenCalled();
        });
    });

    describe('safeClick', () => {
        it('should dismiss overlays and click', async () => {
            const mockLocatorObj = {
                click: vi.fn(),
            };

            await basePage.safeClick(mockLocatorObj as unknown as Locator);

            expect(mockLocatorObj.click).toHaveBeenCalled();
        });
    });

    describe('safeVerifyURL', () => {
        it('should dismiss overlays and verify URL', async () => {
            const regex = /example\.com/;
            await basePage.safeVerifyURL(regex);

            expect(mockSiteHandler.dismissOverlays).toHaveBeenCalled();
            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('load', expect.anything());
        });
    });

    describe('findFirstElement', () => {
        it('should construct a combined selector and wait', async () => {
            const mockCombinedLocator = {
                waitFor: vi.fn(),
            };

            vi.mocked(mockPage.locator!).mockReturnValue({
                first: () => mockCombinedLocator,
            } as unknown as Locator);

            const selectors = ['.one', '#two'];
            await basePage.findFirstElement(selectors, { state: 'visible' });

            // Should join with comma
            expect(mockPage.locator).toHaveBeenCalledWith('.one,#two');
            expect(mockCombinedLocator.waitFor).toHaveBeenCalledWith({ state: 'visible' });
        });

        it('should return locator without waiting if no options provided', async () => {
            const mockCombinedLocator = {
                waitFor: vi.fn(),
            };

            vi.mocked(mockPage.locator!).mockReturnValue({
                first: () => mockCombinedLocator,
            } as unknown as Locator);

            const selectors = ['.one', '#two'];
            await basePage.findFirstElement(selectors);

            expect(mockPage.locator).toHaveBeenCalledWith('.one,#two');
            expect(mockCombinedLocator.waitFor).not.toHaveBeenCalled();
        });
    });

    describe('expectValue', () => {
        it('should verify input value', async () => {
            const mockLocatorObj = {};
            await basePage.expectValue(mockLocatorObj as unknown as Locator, 'test-val');

            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('load', expect.anything());
            // expect() is mocked globally in test-setup.ts
        });
    });

    describe('waitForPageLoad', () => {
        it('should wait for domcontentloaded and load but not networkidle when networking is omitted', async () => {
            await basePage.waitForPageLoad();

            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', undefined);
            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('load', undefined);
            expect(mockPage.waitForLoadState).not.toHaveBeenCalledWith('networkidle', expect.anything());
        });

        it('should wait for domcontentloaded, load and networkidle when networking is true', async () => {
            await basePage.waitForPageLoad({ networking: true });

            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', undefined);
            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('load', undefined);
            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle', {
                timeout: config.test.timeouts.short,
            });
        });

        it('should pass timeout option through and not call networkidle when networking is false', async () => {
            await basePage.waitForPageLoad({ timeout: 5000 });

            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 5000 });
            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('load', { timeout: 5000 });
            expect(mockPage.waitForLoadState).not.toHaveBeenCalledWith('networkidle', expect.anything());
        });

        it('should not reject when networkidle times out', async () => {
            const timeoutError = Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' });
            vi.mocked(mockPage.waitForLoadState!).mockImplementation((state?: string) => {
                if (state === 'networkidle') return Promise.reject(timeoutError);
                return Promise.resolve();
            });

            await expect(basePage.waitForPageLoad({ networking: true })).resolves.toBeUndefined();
        });

        it('should rethrow non-timeout errors from networkidle', async () => {
            const crashError = new Error('Page crashed');
            vi.mocked(mockPage.waitForLoadState!).mockImplementation((state?: string) => {
                if (state === 'networkidle') return Promise.reject(crashError);
                return Promise.resolve();
            });

            await expect(basePage.waitForPageLoad({ networking: true })).rejects.toThrow('Page crashed');
        });
    });
});
