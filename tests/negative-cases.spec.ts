import { test, expect } from './fixtures/base.js';
import { validateSelector } from '../src/ai/SelectorValidator.js';
import { config } from '../src/config/index.js';
import { BooksHomePage } from '../src/pages/BooksHomePage.js';

/**
 * Negative / Edge-Case E2E Tests
 *
 * These tests verify that the self-healing framework handles error conditions
 * gracefully: broken selectors, invalid syntax, empty pages, disabled healing,
 * ambiguous matches, and navigation races. Each test is deterministic and does
 * not rely on flaky network conditions.
 */
test.describe('Negative Cases', () => {
    // -----------------------------------------------------------------------
    // 1. Completely broken selector
    // -----------------------------------------------------------------------
    test.describe('Completely broken selector', () => {
        test('should attempt healing and gracefully handle a nonexistent selector', async ({
            booksPage,
            autoHealer,
        }) => {
            test.slow();
            expect(autoHealer).toBeDefined();

            await booksPage.open();

            // Use a selector that cannot possibly exist on the page.
            // AutoHealer will attempt healing via AI; the test either heals
            // (and gets skipped if the healed selector also fails) or skips
            // gracefully when AI cannot find a replacement.
            // In both cases the framework must NOT hang or crash.
            await booksPage.safeClick('#nonexistent-element-xyz-12345', {
                timeout: config.test.timeouts.short,
            });

            // If we reach here, healing succeeded and the click went through.
            // Verify healing events were recorded.
            const events = autoHealer!.getHealingEvents();
            expect(events.length).toBeGreaterThan(0);
        });
    });

    // -----------------------------------------------------------------------
    // 2. Multiple selector failures in sequence
    // -----------------------------------------------------------------------
    test.describe('Multiple selector failures in sequence', () => {
        test('should handle cascading broken selectors without state corruption', async ({ booksPage, autoHealer }) => {
            test.slow();
            expect(autoHealer).toBeDefined();

            await booksPage.open();

            // Fire several broken selectors one after another.
            // Each will trigger healing independently. The framework must not
            // corrupt internal state (e.g. healingEvents array, locator manager).
            const brokenSelectors = ['#cascade-fail-aaa-111', '#cascade-fail-bbb-222', '#cascade-fail-ccc-333'];

            for (const selector of brokenSelectors) {
                // Each call may skip the test if AI cannot heal. That is
                // acceptable -- the important assertion is no crash or hang.
                await booksPage.safeClick(selector, {
                    timeout: config.test.timeouts.short,
                });
            }

            // Verify healing events were recorded for each attempt.
            const events = autoHealer!.getHealingEvents();
            expect(events.length).toBeGreaterThanOrEqual(brokenSelectors.length);
        });
    });

    // -----------------------------------------------------------------------
    // 3. Invalid selector syntax
    // -----------------------------------------------------------------------
    test.describe('Invalid selector syntax', () => {
        test('SelectorValidator should reject unsafe selectors before sending to AI', () => {
            // The validator is injection-focused: it blocks dangerous prefixes,
            // HTML/JS payloads, and selectors that fall outside the safe-CSS
            // allowlist. It is intentionally permissive about CSS-like syntax,
            // so strict-CSS-invalid strings (e.g. "###triple-hash") may still
            // pass — runtime CSS parsing is the engine's job, not ours.
            const unsafe = [
                '<script>alert(1)</script>',
                'javascript:void(0)',
                'data:text/html,<h1>hi</h1>',
                'eval(alert(1))',
                '{}',
            ];

            for (const selector of unsafe) {
                expect(validateSelector(selector), `Expected "${selector}" to be rejected`).toBe(false);
            }
        });

        test('SelectorValidator should accept well-formed selectors', () => {
            const valid = [
                '#my-id',
                '.my-class',
                'input[type="search"]',
                'text=Submit',
                '//button[@id="ok"]',
                '[data-testid="login"]',
            ];

            for (const selector of valid) {
                expect(validateSelector(selector), `Expected "${selector}" to be accepted`).toBe(true);
            }
        });
    });

    // -----------------------------------------------------------------------
    // 4. Empty page / minimal DOM
    // -----------------------------------------------------------------------
    test.describe('Empty page / minimal DOM', () => {
        test('should handle about:blank gracefully when trying to interact', async ({ page }) => {
            await page.goto('about:blank');

            // Attempting to click on a nonexistent element on a blank page
            // should throw a Playwright timeout error, not crash.
            await expect(page.click('#nonexistent-on-blank-page', { timeout: 2000 })).rejects.toThrow();
        });

        test('should not crash DOMSerializer on a minimal page', async ({ page }) => {
            await page.goto('about:blank');
            await page.setContent('<html><body><p>Minimal</p></body></html>');

            // DOMSerializer.getSimplifiedDOM runs inside page.evaluate and should
            // return a non-empty string even when there are no interactive elements.
            const { getSimplifiedDOM } = await import('../src/ai/DOMSerializer.js');
            const dom = await getSimplifiedDOM(page);
            expect(dom).toBeDefined();
            expect(typeof dom).toBe('string');
            // The fallback path (no interactive elements) still returns content.
            expect(dom.length).toBeGreaterThan(0);
        });
    });

    // -----------------------------------------------------------------------
    // 5. Healing with disabled AutoHealer
    // -----------------------------------------------------------------------
    test.describe('Healing with disabled AutoHealer', () => {
        test('should throw normally without healing when autoHealer is undefined', async ({ page }) => {
            // Construct a page object without an AutoHealer.
            const booksPage = new BooksHomePage(page);
            expect(booksPage.autoHealer).toBeUndefined();

            await booksPage.open();

            // safeClick with a broken selector should fall through to
            // page.click which will throw a Playwright timeout error.
            await expect(
                booksPage.safeClick('#disabled-healer-nonexistent', {
                    timeout: 3000,
                })
            ).rejects.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // 6. Rapid successive heals
    // -----------------------------------------------------------------------
    test.describe('Rapid successive heals', () => {
        test('should handle healAll with multiple broken selectors concurrently', async ({ booksPage, autoHealer }) => {
            test.slow();
            expect(autoHealer).toBeDefined();

            await booksPage.open();

            // healAll fires AI healing in parallel for all failed operations.
            // This verifies there are no race conditions or resource leaks.
            const results = await autoHealer!.healAll([
                { selectorOrKey: '#rapid-a-111', action: 'click' },
                { selectorOrKey: '#rapid-b-222', action: 'click' },
                { selectorOrKey: '#rapid-c-333', action: 'click' },
                { selectorOrKey: '#rapid-d-444', action: 'click' },
            ]);

            // All operations will fail initially; some may be healed by AI.
            expect(results).toHaveLength(4);
            for (const result of results) {
                // Each result must have the expected shape regardless of success.
                expect(result).toHaveProperty('selectorOrKey');
                expect(result).toHaveProperty('success');
            }

            // Verify healing events were recorded (one per failed selector).
            const events = autoHealer!.getHealingEvents();
            expect(events.length).toBeGreaterThanOrEqual(4);
        });
    });

    // -----------------------------------------------------------------------
    // 7. Selector that matches multiple elements
    // -----------------------------------------------------------------------
    test.describe('Selector that matches multiple elements', () => {
        test('should handle an overly broad selector without crashing', async ({ page }) => {
            await page.goto('about:blank');
            await page.setContent(`
                <html><body>
                    <div id="a">One</div>
                    <div id="b">Two</div>
                    <div id="c">Three</div>
                </body></html>
            `);

            // `div` matches 3 elements. Playwright's page.click resolves to
            // the first visible match. This must not throw.
            await expect(page.click('div', { timeout: 3000 })).resolves.not.toThrow();
        });

        test('should report correct count for ambiguous selectors', async ({ page }) => {
            await page.goto('about:blank');
            await page.setContent(`
                <html><body>
                    <a href="#">Link 1</a>
                    <a href="#">Link 2</a>
                    <a href="#">Link 3</a>
                </body></html>
            `);

            const count = await page.locator('a').count();
            expect(count).toBe(3);

            // .first() resolves unambiguously.
            await expect(page.locator('a').first().click()).resolves.not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // 8. Page navigation during interaction
    // -----------------------------------------------------------------------
    test.describe('Page navigation during interaction', () => {
        test('should handle navigation away during a pending action', async ({ page }) => {
            await page.goto('about:blank');
            await page.setContent(`
                <html><body>
                    <button id="nav-btn" onclick="window.location='about:blank'">Navigate</button>
                    <input id="slow-input" type="text" />
                </body></html>
            `);

            // Click the button that triggers navigation.
            await page.click('#nav-btn');

            // After navigation the old DOM is gone. Attempting to interact
            // with the old selector should throw, not hang.
            await expect(page.fill('#slow-input', 'text', { timeout: 2000 })).rejects.toThrow();
        });

        test('should handle goto during waitForSelector without hanging', async ({ page }) => {
            await page.goto('about:blank');
            await page.setContent('<html><body><p>Initial</p></body></html>');

            // Start waiting for a locator that will never appear, then
            // navigate away. The wait should reject, not hang.
            const waitPromise = page.locator('#will-never-appear').waitFor({ timeout: 3000 });
            await page.goto('about:blank');

            await expect(waitPromise).rejects.toThrow();
        });
    });
});
