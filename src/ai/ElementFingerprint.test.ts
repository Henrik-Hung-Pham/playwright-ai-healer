import { describe, it, expect } from 'vitest';
import { compareFingerprints, isHashedClass, type ElementFingerprint } from './ElementFingerprint.js';

/**
 * Fingerprint comparison.
 *
 * These pin the property that makes fingerprints useful for healing: a selector
 * can change completely while the element stays the same, and the score must
 * follow the *element*, not the selector.
 */

/** A fingerprint with sensible defaults, overridable per test. */
const fp = (overrides: Partial<ElementFingerprint> = {}): ElementFingerprint => ({
    selector: '#place-order',
    tag: 'button',
    classes: ['btn', 'btn-primary'],
    testAttributes: {},
    domPath: 'body>form>button',
    siblingIndex: 0,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

describe('isHashedClass', () => {
    it.each([
        ['CSS Modules', 'Button-module__primary--x7f2a'],
        ['styled-components', 'sc-bdVaJa'],
        ['hashed suffix', 'card--a91c3f'],
        ['double-underscore hash', 'wrapper__3f8b9c'],
    ])('treats a build-hashed token as unstable — %s', (_label, token) => {
        expect(isHashedClass(token)).toBe(true);
    });

    it.each([['btn'], ['btn-primary'], ['product_pod'], ['is-active'], ['col-md-6'], ['js-visible']])(
        'keeps a human-authored token — %s',
        token => {
            expect(isHashedClass(token)).toBe(false);
        }
    );

    // BEM uses `--` and `__` as separators, so keying off those alone would
    // discard hand-written names that are among the *most* stable signals
    // available. What distinguishes a build hash is that it mixes letters and
    // digits; a BEM part does not.
    it.each([
        ['BEM modifier', 'btn--primary'],
        ['BEM element', 'card__content'],
        ['BEM element with modifier', 'menu__item--active'],
    ])('keeps BEM syntax — %s', (_label, token) => {
        expect(isHashedClass(token)).toBe(false);
    });
});

describe('compareFingerprints', () => {
    it('scores an identical element at 1', () => {
        expect(compareFingerprints(fp(), fp())).toBe(1);
    });

    it('stays high when only the selector and id changed', () => {
        // The exact scenario healing exists for: an id rename. The element is
        // the same button; only its handle moved.
        const before = fp({ id: 'submit-order-btn', accessibleName: 'Place Order' });
        const after = fp({ selector: '#place-order-btn', id: 'place-order-btn', accessibleName: 'Place Order' });

        expect(compareFingerprints(before, after)).toBeGreaterThan(0.8);
    });

    it('stays high when a build rewrote every class', () => {
        const before = fp({ accessibleName: 'Continue to payment', classes: ['btn', 'btn-primary'] });
        // Hashed classes are stripped at capture, so the list arrives empty.
        const after = fp({ accessibleName: 'Continue to payment', classes: [] });

        expect(compareFingerprints(before, after)).toBeGreaterThan(0.8);
    });

    it('scores a different control low even when the tag matches', () => {
        const target = fp({ accessibleName: 'Place Order', id: 'place-order' });
        const decoy = fp({ accessibleName: 'Cancel', id: 'cancel-order' });

        expect(compareFingerprints(target, decoy)).toBeLessThan(0.5);
    });

    it('separates a near-miss decoy from the real target', () => {
        // "Save draft" vs "Save and publish" — the adversarial benchmark case.
        const remembered = fp({ accessibleName: 'Save and publish', id: 'save-publish-btn' });
        const correct = fp({ accessibleName: 'Save and publish', id: 'publish-btn' });
        const decoy = fp({ accessibleName: 'Save draft', id: 'save-draft-btn' });

        expect(compareFingerprints(remembered, correct)).toBeGreaterThan(compareFingerprints(remembered, decoy));
    });

    it('treats an extended label as the same element', () => {
        // Labels get extended far more often than replaced.
        const before = fp({ accessibleName: 'Save' });
        const after = fp({ accessibleName: 'Save and publish' });

        expect(compareFingerprints(before, after)).toBeGreaterThan(0.7);
    });

    it('weights a matching test attribute heavily', () => {
        const before = fp({ testAttributes: { 'data-testid': 'checkout-submit' } });
        const after = fp({
            selector: '.totally-different',
            classes: [],
            domPath: 'body>div>section>button',
            testAttributes: { 'data-testid': 'checkout-submit' },
        });

        expect(compareFingerprints(before, after)).toBeGreaterThan(0.8);
    });

    it('does not penalise a field that neither element has', () => {
        // Absence of a signal is not evidence of difference. Two elements with no
        // data-testid must not be capped below threshold for lacking one.
        const a = fp({ accessibleName: 'Submit', testAttributes: {} });
        const b = fp({ accessibleName: 'Submit', testAttributes: {} });

        expect(compareFingerprints(a, b)).toBe(1);
    });

    it('returns 0 when nothing is comparable', () => {
        const a = fp({ tag: 'button', domPath: 'body>form>button', classes: [], testAttributes: {} });
        const b = fp({ tag: 'input', domPath: 'body>div>input', classes: [], testAttributes: {} });

        expect(compareFingerprints(a, b)).toBe(0);
    });

    it('is symmetric', () => {
        const a = fp({ accessibleName: 'Place Order', id: 'a' });
        const b = fp({ accessibleName: 'Place order now', id: 'b' });

        expect(compareFingerprints(a, b)).toBe(compareFingerprints(b, a));
    });
});
