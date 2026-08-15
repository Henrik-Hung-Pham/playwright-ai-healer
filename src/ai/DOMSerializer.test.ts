// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { Page } from '@playwright/test';
import { getSimplifiedDOM } from './DOMSerializer.js';

/**
 * The real DOMSerializer runs its logic inside `page.evaluate(fn, arg)`. Under
 * jsdom we can execute that same callback against the live `document`, so this
 * fake Page simply invokes the callback — exercising the real serialization
 * code. The serialized argument (the char budget) is forwarded just as
 * Playwright would.
 */
function pageFromHtml(html: string): Page {
    document.body.innerHTML = html;
    return {
        evaluate: (fn: (arg: number) => string, arg: number) => Promise.resolve(fn(arg)),
    } as unknown as Page;
}

describe('getSimplifiedDOM', () => {
    it('includes interactive elements and excludes script/style/svg', async () => {
        const page = pageFromHtml(`
            <div id="wrapper">
                <button id="go" class="primary">Submit</button>
                <script>console.log('nope')</script>
                <style>.x { color: red }</style>
                <svg><path d="M0 0"></path></svg>
            </div>
        `);

        const dom = await getSimplifiedDOM(page);

        expect(dom).toContain('<button');
        expect(dom).toContain('id="go"');
        expect(dom).toContain('Submit');
        expect(dom).not.toContain('console.log');
        expect(dom).not.toContain('color: red');
        expect(dom).not.toContain('<path');
    });

    it('gives interactive elements full attributes but ancestors only structural ones', async () => {
        const page = pageFromHtml(`
            <section id="sect" class="decorative-section">
                <input id="email" name="email" placeholder="Email" aria-label="Email field" />
            </section>
        `);

        const dom = await getSimplifiedDOM(page);

        // Interactive input keeps rich attributes.
        expect(dom).toContain('placeholder="Email"');
        expect(dom).toContain('aria-label="Email field"');
        // Ancestor <section> keeps its id but not its decorative class.
        expect(dom).toContain('id="sect"');
        expect(dom).not.toContain('decorative-section');
    });

    it('does not leak input value attributes', async () => {
        const page = pageFromHtml('<input id="secret-field" value="hunter2" />');

        const dom = await getSimplifiedDOM(page);

        expect(dom).toContain('id="secret-field"');
        expect(dom).not.toContain('hunter2');
    });

    it('scrubs PII (email and phone) from interactive text', async () => {
        const page = pageFromHtml('<button id="contact">Email me at jane.doe@example.com or 555-123-4567</button>');

        const dom = await getSimplifiedDOM(page);

        expect(dom).toContain('[EMAIL]');
        expect(dom).toContain('[PHONE]');
        expect(dom).not.toContain('jane.doe@example.com');
        expect(dom).not.toContain('555-123-4567');
    });

    it('collapses runs of 3+ similar siblings', async () => {
        const items = Array.from({ length: 5 }, (_, i) => `<button class="row">Item ${i}</button>`).join('');
        const page = pageFromHtml(`<div id="list">${items}</div>`);

        const dom = await getSimplifiedDOM(page);

        // First two are rendered, the rest collapsed into a summary comment.
        expect(dom).toMatch(/<!-- \.\.\.\d+ more <button> -->/);
    });

    it('truncates very long class attribute values', async () => {
        const longClass = 'c'.repeat(120);
        const page = pageFromHtml(`<button id="b" class="${longClass}">Hi</button>`);

        const dom = await getSimplifiedDOM(page);

        expect(dom).toContain('...');
        expect(dom).not.toContain('c'.repeat(120));
    });

    it('falls back to a cleaned snapshot when there are no interactive elements', async () => {
        const page = pageFromHtml(`
            <div class="ignored">
                <p>Contact jane.doe@example.com today</p>
                <script>bad()</script>
            </div>
        `);

        const dom = await getSimplifiedDOM(page);

        // PII scrubbed, scripts removed, even on the fallback path.
        expect(dom).toContain('[EMAIL]');
        expect(dom).not.toContain('jane.doe@example.com');
        expect(dom).not.toContain('bad()');
    });
});

describe('getSimplifiedDOM character budget', () => {
    /**
     * Build `count` interactive elements nested `depth` levels deep.
     *
     * Every wrapper gets a distinct class so the serializer's repeated-sibling
     * collapsing does not fire — that feature is what we want held constant
     * while depth varies, so the budget itself is what is under test.
     */
    function nestedDom(count: number, depth: number): string {
        let html = '';
        for (let i = 0; i < count; i++) {
            const open = `<div class="wrap-${i}-lvl">`.repeat(depth);
            html += `${open}<button id="btn-${i}" class="action-${i}" type="button">Action ${i}</button>${'</div>'.repeat(depth)}`;
        }
        return html;
    }

    it('spends the budget on real output regardless of DOM depth', async () => {
        const limit = 8000;

        // Regression guard. The budget used to be charged the fully-composed
        // subtree at every ancestor level, so each descendant was counted once
        // per level of nesting and the usable allowance collapsed as depth grew
        // (~8 400 chars emitted at depth 1 vs ~2 600 at depth 8 against the same
        // cap). Real applications nest far deeper than fixtures, so the deepest
        // pages — the ones healing needs most context for — got the least.
        const sizes: number[] = [];
        for (const depth of [1, 2, 4, 8]) {
            const dom = await getSimplifiedDOM(pageFromHtml(nestedDom(400, depth)), limit);
            expect(dom.length).toBeLessThanOrEqual(limit + 100); // + truncation notice
            sizes.push(dom.length);
        }

        // Every depth must use most of the allowance, and the deepest must not
        // fall off a cliff relative to the shallowest.
        for (const size of sizes) {
            expect(size).toBeGreaterThan(limit * 0.8);
        }
        const deepest = sizes[sizes.length - 1]!;
        const shallowest = sizes[0]!;
        expect(deepest).toBeGreaterThan(shallowest * 0.85);
    });

    it('marks the snapshot when the budget cut it short', async () => {
        const dom = await getSimplifiedDOM(pageFromHtml(nestedDom(400, 4)), 3000);

        // Without this notice the model cannot distinguish a complete page from
        // a clipped one, and neither can anyone reading the healing logs.
        expect(dom).toContain('DOM truncated at budget limit');
    });

    it('leaves a page that fits well within budget unmarked', async () => {
        const dom = await getSimplifiedDOM(pageFromHtml('<button id="only">Go</button>'), 8000);

        expect(dom).toContain('id="only"');
        expect(dom).not.toContain('DOM truncated');
    });

    it('honours a budget larger than the former hard-coded 15 000 ceiling', async () => {
        // `DOM_SNAPSHOT_CHAR_LIMIT` used to be applied *after* a 15 000-char cap
        // baked into the page.evaluate closure, so raising it above 15 000 had no
        // effect and the env var could only ever shrink the window.
        const dom = await getSimplifiedDOM(pageFromHtml(nestedDom(2000, 2)), 24000);

        expect(dom.length).toBeGreaterThan(15000);
    });
});
