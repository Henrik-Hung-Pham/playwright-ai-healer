import { test, expect } from '../fixtures/base.js';
import { getSimplifiedDOM } from '../../src/ai/DOMSerializer.js';

/**
 * Healing accuracy benchmark.
 *
 * The rest of the E2E suite can only tell us that healing *returned something
 * usable* — `HealingEvent.success` is true when the AI's selector parses,
 * validates, and resolves to exactly one element. None of that establishes that
 * it resolved to the **right** element: a model that replies with any unique
 * node on the page scores a perfect success rate.
 *
 * These tests supply the missing oracle. Each case renders a fixture DOM in
 * which exactly one element is the correct answer, marked with
 * `data-benchmark-target="true"`, then asks the healer to repair a selector
 * that no longer matches. The assertion is on *identity*: the healed selector
 * must resolve to the marked element.
 *
 * The marker is invisible to the model. `DOMSerializer` only forwards
 * attributes in its `FULL_ATTRS` allowlist plus `data-test*` / `data-cy*`
 * prefixes; `data-benchmark-target` matches neither and is stripped from the
 * snapshot. The first test in this file asserts that property directly, so the
 * benchmark fails loudly if a future serializer change starts leaking the
 * answer.
 *
 * Fixtures are rendered with `page.setContent()` rather than fetched from
 * books.toscrape.com — the live site never changes, so it cannot produce the
 * selector drift this benchmark exists to measure.
 */

/** One benchmark scenario: a mutated DOM plus the selector that used to match. */
interface BenchmarkCase {
    /** Test name and report label. */
    name: string;
    /** What changed about the page, quoted in the failure message. */
    mutation: string;
    /** Fixture DOM. Exactly one element carries `data-benchmark-target="true"`. */
    html: string;
    /** The selector the suite "remembers" — it matches nothing in `html`. */
    brokenSelector: string;
}

const CASES: BenchmarkCase[] = [
    {
        name: 'renamed id on the submit button',
        mutation: '#submit-order-btn was renamed to #place-order-btn',
        brokenSelector: '#submit-order-btn',
        html: `
            <nav>
                <a href="/" id="home-link">Home</a>
                <a href="/cart" id="cart-link">Cart</a>
            </nav>
            <form id="checkout-form">
                <input id="email" name="email" type="email" placeholder="Email address" />
                <input id="card" name="card" type="text" placeholder="Card number" />
                <button type="button" id="cancel-order-btn">Cancel</button>
                <button type="button" id="place-order-btn" data-benchmark-target="true">Place Order</button>
            </form>`,
    },
    {
        name: 'renamed class on the quantity input',
        mutation: '.qty-input was renamed to .product-quantity',
        brokenSelector: '.qty-input',
        html: `
            <div class="product">
                <h1>Wireless Mouse</h1>
                <label for="quantity">Quantity</label>
                <input id="quantity" name="quantity" class="form-control product-quantity"
                       type="number" data-benchmark-target="true" />
                <label for="coupon">Coupon code</label>
                <input id="coupon" name="coupon" class="form-control" type="text" />
                <button type="button" id="add-to-cart">Add to cart</button>
            </div>`,
    },
    {
        name: 'renamed data-testid on the discount field',
        mutation: 'data-testid="promo-code" was renamed to data-testid="discount-code"',
        brokenSelector: '[data-testid="promo-code"]',
        html: `
            <section>
                <input data-testid="search-field" type="text" placeholder="Search products" />
                <input data-testid="discount-code" type="text" placeholder="Discount code"
                       data-benchmark-target="true" />
                <button type="button" data-testid="apply-discount">Apply</button>
            </section>`,
    },
    {
        name: 'confirm button moved deeper in the DOM',
        mutation: 'the button is no longer a direct child of #checkout-form > .actions',
        brokenSelector: '#checkout-form > .actions button.confirm',
        html: `
            <div id="checkout-form">
                <div class="panel">
                    <div class="actions-group">
                        <div class="actions">
                            <button type="button" class="btn cancel">Back</button>
                            <button type="button" class="btn confirm" data-benchmark-target="true">
                                Confirm purchase
                            </button>
                        </div>
                    </div>
                </div>
            </div>`,
    },
];

/** Wrap fixture markup in a minimal document. */
const asDocument = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

test.describe('Healing accuracy benchmark', () => {
    test('the benchmark marker is stripped from the AI-facing DOM snapshot', async ({ page }) => {
        // If this fails, every accuracy result below is void — the model could
        // simply read the answer out of the prompt.
        for (const testCase of CASES) {
            await page.setContent(asDocument(testCase.html));
            const snapshot = await getSimplifiedDOM(page);
            expect(
                snapshot,
                `"${testCase.name}" leaks the oracle marker into the AI prompt — ` +
                    `the accuracy assertions below would be measuring nothing.`
            ).not.toContain('benchmark-target');
        }
    });

    for (const testCase of CASES) {
        test(`heals to the correct element — ${testCase.name}`, async ({ page, autoHealer }) => {
            test.slow(); // one live AI round-trip per case
            expect(autoHealer).toBeDefined();
            const healer = autoHealer!;

            await page.setContent(asDocument(testCase.html));

            // Sanity-check the premise: the remembered selector really is broken,
            // and the fixture really does define exactly one correct answer.
            await expect(page.locator(testCase.brokenSelector)).toHaveCount(0);
            await expect(page.locator('[data-benchmark-target="true"]')).toHaveCount(1);

            // `waitForSelector` heals without acting on the result, so the oracle
            // observes the repair without navigation or click side effects.
            let healError: Error | undefined;
            try {
                await healer.waitForSelector(testCase.brokenSelector, { state: 'attached', timeout: 2_000 });
            } catch (error) {
                healError = error as Error;
            }

            const lastEvent = healer.getHealingEvents().at(-1);
            expect(lastEvent, 'the healer recorded no healing attempt').toBeDefined();

            expect(
                lastEvent!.success,
                `No usable replacement selector was produced (${testCase.mutation}). ` +
                    `Healer error: ${healError?.message ?? 'none'}`
            ).toBe(true);

            const healed = lastEvent!.result!.selector;
            await test.info().attach('healed-selector', { body: healed, contentType: 'text/plain' });

            // The accuracy assertion: identity, not mere resolvability.
            await expect(
                page.locator(healed).first(),
                `Healed to "${healed}", which is not the correct element (${testCase.mutation}). ` +
                    `A selector that resolves cleanly but points at the wrong node is a silent ` +
                    `false pass — exactly what this benchmark exists to catch.`
            ).toHaveAttribute('data-benchmark-target', 'true');
        });
    }
});
