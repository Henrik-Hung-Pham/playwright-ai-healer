import { describe, it, expect } from 'vitest';
import { parseAIResponse } from './ResponseParser.js';

describe('ResponseParser', () => {
    describe('parseAIResponse()', () => {
        it('should return null for undefined input', () => {
            expect(parseAIResponse(undefined)).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(parseAIResponse('')).toBeNull();
        });

        it('should return null for FAIL response', () => {
            expect(parseAIResponse('FAIL')).toBeNull();
        });

        it('should strip triple backtick code fences', () => {
            expect(parseAIResponse('```\n#selector\n```')).toBe('#selector');
        });

        it('should extract last backtick-quoted span', () => {
            expect(parseAIResponse('The selector is `#first` or `#second`')).toBe('#second');
        });

        it('should strip surrounding double quotes', () => {
            expect(parseAIResponse('"#quoted-selector"')).toBe('#quoted-selector');
        });

        it('should strip surrounding single quotes', () => {
            expect(parseAIResponse("'#quoted-selector'")).toBe('#quoted-selector');
        });

        it('should trim whitespace', () => {
            expect(parseAIResponse('  #selector  ')).toBe('#selector');
        });

        it('should return plain selector as-is', () => {
            expect(parseAIResponse('#submit-btn')).toBe('#submit-btn');
        });

        it('should return null for whitespace-only input after trimming', () => {
            expect(parseAIResponse('   ')).toBeNull();
        });

        it('should reduce a fenced multi-line block to the selector line', () => {
            expect(parseAIResponse('```css\n.my-class\n```')).toBe('.my-class');
        });

        it('should handle single backtick wrapping', () => {
            expect(parseAIResponse('`#selector`')).toBe('#selector');
        });

        it('should salvage the selector from a chain-of-thought bullet list', () => {
            const verbose = [
                '*   Task: Find a replacement selector for a failed Playwright test.',
                '*   Error: Timeout (element not found).',
                '*   Constraint: Return "FAIL" if no match found.',
                'article.product_pod h3 a',
            ].join('\n');
            expect(parseAIResponse(verbose)).toBe('article.product_pod h3 a');
        });

        it('should pick the last selector-like line when reasoning precedes the answer', () => {
            const verbose = 'The intended element is the first book card.\n#nonexistent\narticle.product_pod >> nth=0';
            expect(parseAIResponse(verbose)).toBe('article.product_pod >> nth=0');
        });

        it('should return null when a verbose reply resolves to FAIL', () => {
            const verbose = '*   Analysis: no element matches the intended purpose.\nFAIL';
            expect(parseAIResponse(verbose)).toBeNull();
        });

        it('should return the last non-empty line when no line looks like a selector', () => {
            // Pure prose with no salvageable selector — downstream validation rejects it.
            const prose = 'I could not find a good match.\nPlease check the page manually.';
            expect(parseAIResponse(prose)).toBe('Please check the page manually.');
        });
    });
});
