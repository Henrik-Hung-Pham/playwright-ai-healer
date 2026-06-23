// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { Page } from '@playwright/test';
import { getSimplifiedDOM } from './DOMSerializer.js';

/**
 * The real DOMSerializer runs its logic inside `page.evaluate(fn)`. Under jsdom
 * we can execute that same callback against the live `document`, so this fake
 * Page simply invokes the callback — exercising the real serialization code.
 */
function pageFromHtml(html: string): Page {
    document.body.innerHTML = html;
    return {
        evaluate: (fn: () => string) => Promise.resolve(fn()),
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
