import type { Page } from '@playwright/test';
import { logger } from '../utils/Logger.js';

/**
 * A structural and semantic snapshot of an element, taken while it still worked.
 *
 * ## Why this exists
 *
 * Healing previously had almost nothing to go on. At repair time the model
 * received the broken selector *string*, an error message, and a DOM snapshot,
 * and the prompt asked it to treat the selector as "a semantic clue about the
 * element's purpose". A string like `.btn-primary.btn-block` carries essentially
 * no intent, so the model was guessing what the test had meant to click.
 *
 * Nothing was ever recorded about the element itself while the selector was
 * working — the one moment at which the framework had the answer in hand.
 *
 * A fingerprint captures that moment: what the element was, what it was called,
 * and where it sat. It turns healing from "ask a model to guess the intent" into
 * "find the node most similar to a known-good record", which is how established
 * self-healing tools (Healenium, Testim, mabl) approach the problem.
 *
 * ## Privacy
 *
 * Fingerprints are stored locally in `metrics.json` and are **not** transmitted
 * to any AI provider by this module. Text is truncated for size, not redacted —
 * do not add fields here without re-reading the Data Privacy section of
 * SECURITY.md, since a future change could route them into a prompt.
 */
export interface ElementFingerprint {
    /** The selector that resolved to this element when the capture was taken. */
    selector: string;
    /** Lower-case tag name, e.g. `'button'`. */
    tag: string;
    /** `id` attribute, when present. */
    id?: string;
    /** `name` attribute, when present. */
    name?: string;
    /** Explicit or implicit ARIA role. */
    role?: string;
    /**
     * Accessible name — `aria-label`, else the associated `<label>`, else the
     * element's own trimmed text. The single most stable identity signal for an
     * interactive control, and the one that survives class and id churn.
     */
    accessibleName?: string;
    /** Trimmed visible text, capped at 120 chars. */
    text?: string;
    /** Class tokens, minus build-hashed ones (see {@link isHashedClass}). */
    classes: string[];
    /** `data-test*` / `data-cy*` attributes, which exist precisely to be stable. */
    testAttributes: Record<string, string>;
    /** `type` attribute for inputs, e.g. `'email'`. */
    inputType?: string;
    /** `href` origin+pathname for links; query and fragment are dropped. */
    hrefPath?: string;
    /** Structural path of tag names from `body`, e.g. `'body>div>form>button'`. */
    domPath: string;
    /** Zero-based index among siblings sharing the same tag. */
    siblingIndex: number;
    /** ISO 8601 capture time. */
    capturedAt: string;
}

/** Maximum characters retained for the `text` field. */
const MAX_TEXT = 120;

/**
 * Time budget for a single capture.
 *
 * `locator.evaluate` auto-waits for the element, so without an explicit timeout
 * a selector that matches nothing blocks for Playwright's default (30s, or the
 * whole test timeout). A capture runs on the *success* path of an interaction
 * whose element was just proven present, so it should resolve immediately;
 * anything slower means the page moved on and the snapshot is not worth having.
 */
const CAPTURE_TIMEOUT_MS = 1_000;

/**
 * Weight each field contributes to the similarity score. They sum to 1.
 *
 * Ordered by how well the signal survives a redesign. `accessibleName` and test
 * attributes dominate because they encode *intent* and are the last things a
 * refactor changes; `classes` is weighted low because CSS-module and utility
 * frameworks rewrite class names on every build; `domPath` is low for the same
 * reason a positional selector is brittle.
 */
export const FINGERPRINT_WEIGHTS = {
    accessibleName: 0.3,
    testAttributes: 0.2,
    role: 0.12,
    tag: 0.1,
    text: 0.1,
    id: 0.06,
    name: 0.04,
    inputType: 0.03,
    hrefPath: 0.03,
    domPath: 0.01,
    classes: 0.01,
} as const;

/**
 * Does a class token look machine-generated?
 *
 * CSS Modules, styled-components, and Tailwind's JIT emit names carrying a build
 * hash (`Button-module__primary--x7f2a`, `sc-bdVaJa`). Those change on every
 * build, so treating them as identity would make a fingerprint go stale for
 * reasons that have nothing to do with the element.
 */
export function isHashedClass(token: string): boolean {
    // A `--` or `__` suffix alone is not evidence of a hash: those are exactly
    // BEM's modifier and element separators, so `btn--primary` and
    // `card__content` are hand-written names that must be kept. What separates a
    // build hash from a BEM part is that the hash mixes letters *and digits*.
    if (/(--|__)(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{4,}$/i.test(token)) return true;

    // styled-components (`sc-bdVaJa`). The mixed-case lookaheads keep ordinary
    // two-letter-prefixed modifiers like `is-active` or `js-visible` out — a
    // generated hash mixes cases, a hand-written modifier does not.
    return /^[a-z]{2}-(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]{6,}$/.test(token);
}

/**
 * Capture a fingerprint of the element a selector currently resolves to.
 *
 * Intended to be called on a **successful** interaction — the point at which the
 * element is known to be the right one.
 *
 * @param page - Page to evaluate against.
 * @param selector - Selector that currently resolves to the element.
 * @returns The fingerprint, or `null` when the selector matches nothing or the
 *   evaluation fails. Never throws: a capture is best-effort telemetry and must
 *   not turn a passing interaction into a failure.
 */
export async function captureFingerprint(page: Page, selector: string): Promise<ElementFingerprint | null> {
    try {
        const captured = await page
            .locator(selector)
            .first()
            .evaluate(
                (el: Element, maxText: number) => {
                    const element = el as HTMLElement;

                    const attr = (nameOfAttr: string): string | undefined =>
                        element.getAttribute(nameOfAttr) ?? undefined;

                    // Accessible name, in the order assistive technology resolves it.
                    const labelledBy = attr('aria-labelledby');
                    const labelledByText = labelledBy
                        ? labelledBy
                              .split(/\s+/)
                              .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
                              .filter(Boolean)
                              .join(' ')
                        : '';
                    const explicitLabel = element.id
                        ? (document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() ?? '')
                        : '';
                    const ownText = element.textContent?.trim() ?? '';
                    const accessibleName =
                        attr('aria-label') ||
                        labelledByText ||
                        explicitLabel ||
                        attr('placeholder') ||
                        attr('alt') ||
                        ownText;

                    const testAttributes: Record<string, string> = {};
                    for (const a of Array.from(element.attributes)) {
                        if (a.name.startsWith('data-test') || a.name.startsWith('data-cy'))
                            testAttributes[a.name] = a.value;
                    }

                    // Structural path of tag names, capped so a deep tree does not
                    // produce an unbounded string.
                    const path: string[] = [];
                    let node: Element | null = element;
                    while (node && node !== document.body && path.length < 12) {
                        path.unshift(node.tagName.toLowerCase());
                        node = node.parentElement;
                    }
                    path.unshift('body');

                    const siblings = element.parentElement
                        ? Array.from(element.parentElement.children).filter(c => c.tagName === element.tagName)
                        : [];

                    let hrefPath: string | undefined;
                    const href = attr('href');
                    if (href) {
                        try {
                            const url = new URL(href, document.baseURI);
                            hrefPath = url.origin + url.pathname;
                        } catch {
                            // `new URL` throws when the document has no usable base — most
                            // notably under `page.setContent`, where baseURI is
                            // `about:blank`. Strip the volatile parts by hand rather than
                            // falling back to the raw href: tracking parameters churn
                            // constantly and would otherwise make the fingerprint look
                            // different on every visit.
                            hrefPath = href.split(/[?#]/)[0];
                        }
                    }

                    return {
                        tag: element.tagName.toLowerCase(),
                        id: element.id || undefined,
                        name: attr('name'),
                        role: attr('role'),
                        accessibleName: accessibleName ? accessibleName.slice(0, maxText) : undefined,
                        text: ownText ? ownText.slice(0, maxText) : undefined,
                        classes: Array.from(element.classList),
                        testAttributes,
                        inputType: attr('type'),
                        hrefPath,
                        domPath: path.join('>'),
                        siblingIndex: Math.max(0, siblings.indexOf(element)),
                    };
                },
                MAX_TEXT,
                { timeout: CAPTURE_TIMEOUT_MS }
            );

        // Optional fields are omitted rather than set to `undefined`:
        // `exactOptionalPropertyTypes` is enabled, and an explicit `undefined`
        // would also serialise into metrics.json as noise.
        return {
            selector,
            tag: captured.tag,
            // Hashed tokens are dropped here rather than in the browser so the
            // rule lives in one place and stays unit-testable.
            classes: captured.classes.filter(token => !isHashedClass(token)),
            testAttributes: captured.testAttributes,
            domPath: captured.domPath,
            siblingIndex: captured.siblingIndex,
            capturedAt: new Date().toISOString(),
            ...(captured.id ? { id: captured.id } : {}),
            ...(captured.name ? { name: captured.name } : {}),
            ...(captured.role ? { role: captured.role } : {}),
            ...(captured.accessibleName ? { accessibleName: captured.accessibleName } : {}),
            ...(captured.text ? { text: captured.text } : {}),
            ...(captured.inputType ? { inputType: captured.inputType } : {}),
            ...(captured.hrefPath ? { hrefPath: captured.hrefPath } : {}),
        };
    } catch (error) {
        logger.debug(`[ElementFingerprint] Could not capture fingerprint for "${selector}": ${String(error)}`);
        return null;
    }
}

/** Normalise text for comparison: lower-case, collapse whitespace. */
function normalise(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Similarity of two strings in 0–1: exact match, containment, or token overlap.
 *
 * Containment scores highly because label text is routinely extended rather than
 * replaced ("Save" → "Save and publish"), and a rename of that kind should not
 * look like a different element.
 */
function textSimilarity(a: string | undefined, b: string | undefined): number {
    if (!a || !b) return 0;
    const left = normalise(a);
    const right = normalise(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.8;

    const leftTokens = new Set(left.split(' '));
    const rightTokens = new Set(right.split(' '));
    const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
    if (shared === 0) return 0;
    return shared / Math.max(leftTokens.size, rightTokens.size);
}

/** Jaccard overlap of two string sets. */
function setSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0;
    const left = new Set(a);
    const right = new Set(b);
    const intersection = [...left].filter(token => right.has(token)).length;
    const union = new Set([...left, ...right]).size;
    return union === 0 ? 0 : intersection / union;
}

/** Overlap of `data-test*` maps, requiring both name and value to agree. */
function attributeSimilarity(a: Record<string, string>, b: Record<string, string>): number {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size === 0) return 0;
    let matched = 0;
    for (const key of keys) if (a[key] !== undefined && a[key] === b[key]) matched++;
    return matched / keys.size;
}

/**
 * Score how likely two fingerprints describe the same element, in 0–1.
 *
 * Only fields present in **both** fingerprints contribute, and the result is
 * renormalised over the weight actually available. Without that, an element with
 * no `data-testid` would be permanently capped below any threshold simply for
 * lacking an attribute the other also lacks — absence of a signal is not
 * evidence of difference.
 *
 * @returns 0 when the two share no comparable field.
 */
export function compareFingerprints(a: ElementFingerprint, b: ElementFingerprint): number {
    let score = 0;
    let available = 0;

    const consider = (weight: number, present: boolean, similarity: number): void => {
        if (!present) return;
        available += weight;
        score += weight * similarity;
    };

    consider(FINGERPRINT_WEIGHTS.tag, true, a.tag === b.tag ? 1 : 0);
    consider(
        FINGERPRINT_WEIGHTS.accessibleName,
        Boolean(a.accessibleName && b.accessibleName),
        textSimilarity(a.accessibleName, b.accessibleName)
    );
    consider(
        FINGERPRINT_WEIGHTS.testAttributes,
        Object.keys(a.testAttributes).length > 0 && Object.keys(b.testAttributes).length > 0,
        attributeSimilarity(a.testAttributes, b.testAttributes)
    );
    consider(FINGERPRINT_WEIGHTS.role, Boolean(a.role && b.role), a.role === b.role ? 1 : 0);
    consider(FINGERPRINT_WEIGHTS.text, Boolean(a.text && b.text), textSimilarity(a.text, b.text));
    consider(FINGERPRINT_WEIGHTS.id, Boolean(a.id && b.id), textSimilarity(a.id, b.id));
    consider(FINGERPRINT_WEIGHTS.name, Boolean(a.name && b.name), a.name === b.name ? 1 : 0);
    consider(FINGERPRINT_WEIGHTS.inputType, Boolean(a.inputType && b.inputType), a.inputType === b.inputType ? 1 : 0);
    consider(FINGERPRINT_WEIGHTS.hrefPath, Boolean(a.hrefPath && b.hrefPath), a.hrefPath === b.hrefPath ? 1 : 0);
    consider(
        FINGERPRINT_WEIGHTS.classes,
        a.classes.length > 0 && b.classes.length > 0,
        setSimilarity(a.classes, b.classes)
    );
    consider(FINGERPRINT_WEIGHTS.domPath, true, a.domPath === b.domPath ? 1 : 0);

    if (available === 0) return 0;
    return Number((score / available).toFixed(4));
}
