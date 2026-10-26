import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base.js';
import { getSimplifiedDOM } from '../../src/ai/DOMSerializer.js';
import type { AutoHealer } from '../../src/AutoHealer.js';

/**
 * Healing accuracy benchmark.
 *
 * The rest of the E2E suite can only tell us that healing *returned something
 * usable* — `HealingEvent.success` is true when the AI's selector parses,
 * validates, and resolves to exactly one element. None of that establishes that
 * it resolved to the **right** element: a model that replies with any unique
 * node on the page scores a perfect success rate.
 *
 * These tests supply the missing oracle, along two independent axes:
 *
 * 1. **Accuracy** (`heals-to-target`) — the page still contains the element the
 *    test meant to reach, and the healed selector must resolve to *that* element,
 *    identified by an invisible `data-benchmark-target="true"` marker.
 *
 * 2. **Refusal** (`must-refuse`) — the element is genuinely gone and no
 *    reasonable substitute exists. The only correct answer is to heal nothing.
 *    A model that invents a plausible-looking replacement here produces a
 *    **silent false pass**: the suite goes green while the feature under test
 *    was never exercised. This axis was previously unmeasured — every case in
 *    the original benchmark had a correct answer available, so the false-positive
 *    rate, which is the dangerous one for self-healing, was invisible.
 *
 * The marker is invisible to the model. `DOMSerializer` only forwards attributes
 * in its `FULL_ATTRS` allowlist plus `data-test*` / `data-cy*` prefixes;
 * `data-benchmark-target` matches neither and is stripped from the snapshot. The
 * first test in this file asserts that property directly, so the benchmark fails
 * loudly if a future serializer change starts leaking the answer.
 *
 * Fixtures are rendered with `page.setContent()` rather than fetched from
 * books.toscrape.com — the live site never changes, so it cannot produce the
 * selector drift this benchmark exists to measure.
 *
 * Every case costs one live AI round-trip, so the suite is deliberately sized to
 * cover distinct *failure shapes* rather than to maximise case count.
 */

/** What the healer is expected to do with a case. */
type Expectation =
    /** The target element exists; the healed selector must resolve to it. */
    | { kind: 'heals-to-target' }
    /** No acceptable element exists; healing must not report success. */
    | { kind: 'must-refuse' };

/** One benchmark scenario: a mutated DOM plus the selector that used to match. */
interface BenchmarkCase {
    /** Test name and report label. */
    name: string;
    /** What changed about the page, quoted in the failure message. */
    mutation: string;
    /** Fixture DOM. For `heals-to-target`, exactly one element carries `data-benchmark-target="true"`. */
    html: string;
    /** The selector the suite "remembers" — it matches nothing in `html`. */
    brokenSelector: string;
    /** The oracle for this case. */
    expect: Expectation;
}

const HEALS: Expectation = { kind: 'heals-to-target' };
const REFUSES: Expectation = { kind: 'must-refuse' };

const CASES: BenchmarkCase[] = [
    // ── Axis 1: accuracy — a correct answer exists ────────────────────────────
    {
        name: 'renamed id on the submit button',
        mutation: '#submit-order-btn was renamed to #place-order-btn',
        brokenSelector: '#submit-order-btn',
        expect: HEALS,
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
        expect: HEALS,
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
        expect: HEALS,
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
        expect: HEALS,
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

    // ── Axis 1b: accuracy under adversarial pressure ──────────────────────────
    // A near-miss decoy is present. Uniqueness alone cannot distinguish it from
    // the real target, so these separate "found a unique element" from
    // "understood which element was meant".
    {
        name: 'decoy sibling with a near-identical label',
        mutation: '#save-publish-btn was renamed to #publish-btn; a "Save draft" decoy remains',
        brokenSelector: '#save-publish-btn',
        expect: HEALS,
        html: `
            <form id="editor">
                <textarea id="body" name="body" placeholder="Write your post"></textarea>
                <button type="button" id="save-draft-btn">Save draft</button>
                <button type="button" id="publish-btn" data-benchmark-target="true">Save and publish</button>
            </form>`,
    },
    {
        name: 'hashed CSS-module class replaces a semantic one',
        mutation: 'button.btn-primary became a build-hashed module class and gained a wrapper',
        brokenSelector: 'button.btn-primary',
        expect: HEALS,
        html: `
            <div role="group" class="Toolbar-module__root--a91c">
                <span class="Button-module__wrap--3f8b">
                    <button type="button" class="Button-module__secondary--5d21">Cancel</button>
                </span>
                <span class="Button-module__wrap--3f8b">
                    <button type="button" class="Button-module__primary--x7f2a"
                            data-benchmark-target="true">Continue to payment</button>
                </span>
            </div>`,
    },
    {
        name: 'icon-only button identified solely by aria-label',
        mutation: '#delete-row-3 was removed; the control is now an icon button with no text',
        brokenSelector: '#delete-row-3',
        expect: HEALS,
        html: `
            <table>
                <tbody>
                    <tr><td>Invoice 001</td>
                        <td><button type="button" aria-label="Delete invoice 001">✕</button></td></tr>
                    <tr><td>Invoice 002</td>
                        <td><button type="button" aria-label="Delete invoice 002">✕</button></td></tr>
                    <tr><td>Invoice 003</td>
                        <td><button type="button" aria-label="Delete invoice 003"
                                    data-benchmark-target="true">✕</button></td></tr>
                </tbody>
            </table>`,
    },
    {
        name: 'target is one of several identical repeated rows',
        mutation: 'the per-row Add button lost its id; only position distinguishes the rows',
        brokenSelector: '#add-item-1',
        expect: HEALS,
        html: `
            <ul class="results">
                <li class="row"><span>First result</span>
                    <button type="button" class="add" data-benchmark-target="true">Add</button></li>
                <li class="row"><span>Second result</span>
                    <button type="button" class="add">Add</button></li>
                <li class="row"><span>Third result</span>
                    <button type="button" class="add">Add</button></li>
            </ul>`,
    },

    // ── Axis 2: refusal — no correct answer exists ────────────────────────────
    // The element is gone and nothing on the page serves its purpose. Healing to
    // *anything* here is a false positive that turns a real regression green.
    {
        name: 'refuses when the invoice download button is gone entirely',
        mutation: 'the entire billing panel was removed; the page is now a newsletter signup',
        brokenSelector: '#download-invoice-btn',
        expect: REFUSES,
        html: `
            <section class="newsletter">
                <h1>Subscribe to our newsletter</h1>
                <label for="nl-email">Email</label>
                <input id="nl-email" name="email" type="email" placeholder="you@example.com" />
                <button type="button" id="nl-subscribe">Subscribe</button>
            </section>`,
    },
    {
        name: 'refuses when the destructive account action is gone',
        mutation: 'account settings were removed; only an unauthenticated login form remains',
        brokenSelector: '[data-testid="delete-account"]',
        expect: REFUSES,
        html: `
            <form id="login">
                <label for="user">Username</label>
                <input id="user" name="username" type="text" />
                <label for="pass">Password</label>
                <input id="pass" name="password" type="password" />
                <button type="button" data-testid="login-submit">Sign in</button>
            </form>`,
    },
    {
        name: 'refuses when a feature-flagged control is switched off',
        mutation: 'the export-to-CSV control is behind a disabled feature flag and is not rendered',
        brokenSelector: 'button.export-csv',
        expect: REFUSES,
        html: `
            <div class="report">
                <h1>Monthly report</h1>
                <label for="from">From</label>
                <input id="from" name="from" type="date" />
                <label for="to">To</label>
                <input id="to" name="to" type="date" />
                <button type="button" id="apply-range">Apply</button>
            </div>`,
    },
    {
        name: 'refuses on an error page that replaced the real content',
        mutation: 'the app returned a 500 page, so the search box does not exist',
        brokenSelector: '#site-search',
        expect: REFUSES,
        html: `
            <main class="error-page">
                <h1>Something went wrong</h1>
                <p>We are working on it. Please try again later.</p>
                <button type="button" id="retry">Retry</button>
            </main>`,
    },
];

/** Wrap fixture markup in a minimal document. */
const asDocument = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

const ACCURACY_CASES = CASES.filter(c => c.expect.kind === 'heals-to-target');
const REFUSAL_CASES = CASES.filter(c => c.expect.kind === 'must-refuse');

/**
 * Per-case outcome, accumulated so the run ends with a headline number rather
 * than only a pass/fail per test.
 *
 * The `healing-benchmark` project sets `fullyParallel: false`, so every test in
 * this file runs serially in one worker and this module-level array observes all
 * of them.
 */
interface CaseOutcome {
    name: string;
    axis: Expectation['kind'];
    correct: boolean;
    detail: string;
}
const outcomes: CaseOutcome[] = [];

/**
 * Drive one heal attempt and report what the healer decided.
 *
 * `waitForSelector` heals without acting on the result, so the oracle observes
 * the repair without navigation or click side effects. The thrown error is
 * captured rather than propagated because for a refusal case throwing is the
 * *correct* outcome.
 */
async function attemptHeal(
    page: Page,
    healer: AutoHealer,
    testCase: BenchmarkCase
): Promise<{ succeeded: boolean; healed: string | undefined; error: Error | undefined }> {
    await page.setContent(asDocument(testCase.html));

    let error: Error | undefined;
    try {
        await healer.waitForSelector(testCase.brokenSelector, { state: 'attached', timeout: 2_000 });
    } catch (caught) {
        error = caught as Error;
    }

    const lastEvent = healer.getHealingEvents().at(-1);
    expect(lastEvent, 'the healer recorded no healing attempt').toBeDefined();

    return { succeeded: lastEvent!.success === true, healed: lastEvent!.result?.selector, error };
}

test.describe('Healing accuracy benchmark', () => {
    test.afterAll(() => {
        if (outcomes.length === 0) return;

        const summarise = (axis: Expectation['kind']) => {
            const rows = outcomes.filter(o => o.axis === axis);
            return { hits: rows.filter(o => o.correct).length, total: rows.length };
        };
        const pct = (hits: number, total: number) => (total === 0 ? 'n/a' : `${Math.round((hits / total) * 100)}%`);

        const accuracy = summarise('heals-to-target');
        const refusal = summarise('must-refuse');

        // eslint-disable-next-line no-console
        console.log(
            [
                '',
                '── Healing benchmark ────────────────────────────────────────',
                `Accuracy (healed to the right element): ${accuracy.hits}/${accuracy.total} (${pct(accuracy.hits, accuracy.total)})`,
                `Refusal  (declined when none existed):  ${refusal.hits}/${refusal.total} (${pct(refusal.hits, refusal.total)})`,
                '',
                ...outcomes.map(o => `${o.correct ? 'PASS' : 'FAIL'}  [${o.axis}] ${o.name} — ${o.detail}`),
                '',
            ].join('\n')
        );
    });

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

    test('every fixture states a well-formed oracle', async ({ page }) => {
        // Guards the premise of both axes: the remembered selector really is
        // broken, an accuracy case really does define exactly one right answer,
        // and a refusal case really does define none.
        for (const testCase of CASES) {
            await page.setContent(asDocument(testCase.html));

            await expect(
                page.locator(testCase.brokenSelector),
                `"${testCase.name}" — the "broken" selector still matches, so nothing would heal.`
            ).toHaveCount(0);

            await expect(
                page.locator('[data-benchmark-target="true"]'),
                `"${testCase.name}" — a ${testCase.expect.kind} case must mark the right number of targets.`
            ).toHaveCount(testCase.expect.kind === 'heals-to-target' ? 1 : 0);
        }
    });

    // ── Axis 1: accuracy ──────────────────────────────────────────────────────
    for (const testCase of ACCURACY_CASES) {
        test(`heals to the correct element — ${testCase.name}`, async ({ page, autoHealer }) => {
            test.slow(); // one live AI round-trip per case
            expect(autoHealer).toBeDefined();

            const { succeeded, healed, error } = await attemptHeal(page, autoHealer!, testCase);
            await test.info().attach('healed-selector', { body: healed ?? '<none>', contentType: 'text/plain' });

            const onTarget =
                succeeded && healed
                    ? (await page.locator(healed).first().getAttribute('data-benchmark-target')) === 'true'
                    : false;
            outcomes.push({
                name: testCase.name,
                axis: 'heals-to-target',
                correct: onTarget,
                detail: !succeeded
                    ? 'no usable selector'
                    : onTarget
                      ? `healed to "${healed}"`
                      : `wrong element "${healed}"`,
            });

            expect(
                succeeded,
                `No usable replacement selector was produced (${testCase.mutation}). ` +
                    `Healer error: ${error?.message ?? 'none'}`
            ).toBe(true);

            // The accuracy assertion: identity, not mere resolvability.
            await expect(
                page.locator(healed!).first(),
                `Healed to "${healed}", which is not the correct element (${testCase.mutation}). ` +
                    `A selector that resolves cleanly but points at the wrong node is a silent ` +
                    `false pass — exactly what this benchmark exists to catch.`
            ).toHaveAttribute('data-benchmark-target', 'true');
        });
    }

    // ── Axis 2: refusal ───────────────────────────────────────────────────────
    for (const testCase of REFUSAL_CASES) {
        test(`refuses to heal — ${testCase.name}`, async ({ page, autoHealer }) => {
            test.slow(); // one live AI round-trip per case
            expect(autoHealer).toBeDefined();

            const { succeeded, healed } = await attemptHeal(page, autoHealer!, testCase);
            await test.info().attach('healed-selector', { body: healed ?? '<none>', contentType: 'text/plain' });

            outcomes.push({
                name: testCase.name,
                axis: 'must-refuse',
                correct: !succeeded,
                detail: succeeded ? `invented "${healed}"` : 'refused',
            });

            expect(
                succeeded,
                `Healed to "${healed}" when the correct answer was to heal nothing (${testCase.mutation}). ` +
                    `Substituting an unrelated element for one that no longer exists is a silent false pass: ` +
                    `the suite reports green while the feature under test was never exercised.`
            ).toBe(false);
        });
    }
});
