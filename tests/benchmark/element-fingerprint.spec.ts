import { test, expect } from '../fixtures/base.js';
import { captureFingerprint, compareFingerprints } from '../../src/ai/ElementFingerprint.js';

/**
 * `captureFingerprint` against a real browser.
 *
 * The extraction runs inside `page.evaluate`, so its correctness depends on real
 * DOM APIs — `CSS.escape`, `document.baseURI`, `element.classList`, implicit
 * label association. A jsdom unit test would not exercise the same code paths,
 * so the capture half of the module is verified here while the comparison half
 * is unit-tested in `src/ai/ElementFingerprint.test.ts`.
 *
 * No AI provider is involved — these are pure DOM assertions and cost nothing to
 * run, unlike the healing-accuracy cases they sit beside.
 */

const asDocument = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

test.describe('captureFingerprint', () => {
    test('captures the identity signals of a button', async ({ page }) => {
        await page.setContent(
            asDocument(`
                <form id="checkout">
                    <button type="button" id="place-order" class="btn btn-primary Button-module__x7f2a"
                            data-testid="submit-order" aria-label="Place your order">Place Order</button>
                </form>`)
        );

        const fingerprint = await captureFingerprint(page, '#place-order');

        expect(fingerprint).not.toBeNull();
        expect(fingerprint).toMatchObject({
            selector: '#place-order',
            tag: 'button',
            id: 'place-order',
            inputType: 'button',
            accessibleName: 'Place your order',
            text: 'Place Order',
            testAttributes: { 'data-testid': 'submit-order' },
        });
        // Build-hashed tokens are dropped; human-authored ones are kept.
        expect(fingerprint!.classes).toEqual(['btn', 'btn-primary']);
        expect(fingerprint!.domPath).toBe('body>form>button');
    });

    test('resolves the accessible name from an associated label', async ({ page }) => {
        await page.setContent(
            asDocument(`
                <label for="quantity">Quantity ordered</label>
                <input id="quantity" name="quantity" type="number" />`)
        );

        const fingerprint = await captureFingerprint(page, '#quantity');

        // No aria-label and no own text — the <label for> is the only source.
        expect(fingerprint?.accessibleName).toBe('Quantity ordered');
        expect(fingerprint?.name).toBe('quantity');
        expect(fingerprint?.inputType).toBe('number');
    });

    test('resolves the accessible name from aria-labelledby', async ({ page }) => {
        await page.setContent(
            asDocument(`
                <span id="lbl">Delete invoice</span>
                <button type="button" id="del" aria-labelledby="lbl">✕</button>`)
        );

        expect((await captureFingerprint(page, '#del'))?.accessibleName).toBe('Delete invoice');
    });

    test('strips query and fragment from an href', async ({ page }) => {
        await page.setContent(asDocument(`<a id="cart" href="/cart?ref=nav&utm=x#top">Cart</a>`));

        const fingerprint = await captureFingerprint(page, '#cart');

        // Tracking parameters churn constantly; the path is the stable part.
        expect(fingerprint?.hrefPath?.endsWith('/cart')).toBe(true);
        expect(fingerprint?.hrefPath).not.toContain('utm');
    });

    test('records the index among same-tag siblings', async ({ page }) => {
        await page.setContent(
            asDocument(`
                <ul>
                    <li><button type="button" class="add">Add</button></li>
                    <li><button type="button" class="add" id="third">Add</button></li>
                </ul>`)
        );

        expect((await captureFingerprint(page, '#third'))?.siblingIndex).toBe(0);
    });

    test('returns null rather than throwing when the selector matches nothing', async ({ page }) => {
        await page.setContent(asDocument('<div>nothing here</div>'));

        // A capture is best-effort telemetry: it must never fail an interaction.
        expect(await captureFingerprint(page, '#does-not-exist')).toBeNull();
    });

    test('recognises the same element across a realistic redesign', async ({ page }) => {
        // Before: semantic classes and a descriptive id.
        await page.setContent(
            asDocument(`
                <form id="checkout">
                    <button type="button" id="submit-order-btn" class="btn btn-primary">Place Order</button>
                </form>`)
        );
        const before = await captureFingerprint(page, '#submit-order-btn');

        // After: id renamed, classes replaced by a CSS-module build hash, and an
        // extra wrapper introduced. Only the accessible name survived.
        await page.setContent(
            asDocument(`
                <form id="checkout">
                    <div class="Toolbar-module__root--a91c">
                        <button type="button" id="place-order-btn"
                                class="Button-module__primary--x7f2a">Place Order</button>
                    </div>
                </form>`)
        );
        const after = await captureFingerprint(page, '#place-order-btn');

        expect(before).not.toBeNull();
        expect(after).not.toBeNull();
        // This is the signal healing did not previously have: nothing about the
        // selector survived, yet the element is recognisably the same one.
        expect(compareFingerprints(before!, after!)).toBeGreaterThan(0.7);
    });

    test('distinguishes a near-miss decoy from the remembered element', async ({ page }) => {
        await page.setContent(
            asDocument(`
                <form id="editor">
                    <button type="button" id="save-draft-btn">Save draft</button>
                    <button type="button" id="publish-btn">Save and publish</button>
                </form>`)
        );

        const remembered = await captureFingerprint(page, '#publish-btn');
        const decoy = await captureFingerprint(page, '#save-draft-btn');

        expect(compareFingerprints(remembered!, remembered!)).toBe(1);
        expect(compareFingerprints(remembered!, decoy!)).toBeLessThan(0.7);
    });
});
