import { describe, it, expect } from 'vitest';
import { scoreSelector } from './SelectorScorer.js';
import { parseAICandidates } from './ResponseParser.js';

/**
 * Fingerprint-aware scoring and multi-candidate parsing.
 *
 * The property under test is that `confidenceThreshold` can now actually reject
 * something. Under the fingerprint-free formula the minimum score for a unique
 * selector is 0.8 — above the 0.7 default — so no unique selector was ever
 * rejected, however wrong the element it pointed at.
 */

const THRESHOLD = 0.7;

describe('scoreSelector — without a fingerprint', () => {
    it('preserves the historical score for a unique id selector', () => {
        expect(scoreSelector('#place-order', 1).confidence).toBe(1);
    });

    it('preserves the historical score for an ambiguous class selector', () => {
        expect(scoreSelector('.product_pod', 12).confidence).toBe(0.6);
    });

    it('cannot reject any unique selector, whatever it points at', () => {
        // Documents the ceiling this change exists to lift: bare XPath is the
        // weakest strategy, and even it clears the default threshold.
        expect(scoreSelector('//div[3]/button', 1).confidence).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it('says plainly that identity was not verified', () => {
        expect(scoreSelector('#place-order', 1).reasoning).toMatch(/identity was not verified/);
    });
});

describe('scoreSelector — with a fingerprint', () => {
    it('accepts a unique selector that matches the remembered element', () => {
        expect(scoreSelector('#place-order-btn', 1, 0.95).confidence).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it('REJECTS a unique selector pointing at an unrelated element', () => {
        // The headline improvement. Identical input scores 1.0 without a
        // fingerprint and 0.6 with one, because the element is wrong.
        const withoutFingerprint = scoreSelector('#unrelated', 1).confidence;
        const withFingerprint = scoreSelector('#unrelated', 1, 0).confidence;

        expect(withoutFingerprint).toBeGreaterThanOrEqual(THRESHOLD);
        expect(withFingerprint).toBeLessThan(THRESHOLD);
    });

    it('ranks the similar candidate above the decoy', () => {
        const correct = scoreSelector('#publish-btn', 1, 0.92).confidence;
        const decoy = scoreSelector('#save-draft-btn', 1, 0.35).confidence;

        expect(correct).toBeGreaterThan(decoy);
    });

    it('still rejects a selector that resolves to nothing', () => {
        expect(scoreSelector('#gone', 0, 1).confidence).toBe(0);
    });

    it('penalises ambiguity even when similarity is perfect', () => {
        expect(scoreSelector('button.add', 4, 1).confidence).toBeLessThan(scoreSelector('button.add', 1, 1).confidence);
    });

    it('clamps an out-of-range similarity', () => {
        expect(scoreSelector('#x', 1, 5).confidence).toBeLessThanOrEqual(1);
        expect(scoreSelector('#x', 1, -3).confidence).toBeGreaterThanOrEqual(0);
    });

    it('reports the similarity it used', () => {
        expect(scoreSelector('#x', 1, 0.83).reasoning).toMatch(/83% similarity/);
    });
});

describe('parseAICandidates', () => {
    it('returns a ranked list, best guess first', () => {
        const raw = ['#place-order-btn', 'button.confirm', '[data-testid="submit"]'].join('\n');

        expect(parseAICandidates(raw)).toEqual(['#place-order-btn', 'button.confirm', '[data-testid="submit"]']);
    });

    it('collapses duplicates, keeping the earliest occurrence', () => {
        expect(parseAICandidates('#a\n#b\n#a')).toEqual(['#a', '#b']);
    });

    it('honours the limit', () => {
        expect(parseAICandidates('#a\n#b\n#c\n#d\n#e\n#f', 3)).toEqual(['#a', '#b', '#c']);
    });

    it('drops prose while keeping the selectors around it', () => {
        const raw = [
            'Here are my best guesses:',
            '#place-order-btn',
            'The second is less certain.',
            'button.confirm',
        ].join('\n');

        expect(parseAICandidates(raw)).toEqual(['#place-order-btn', 'button.confirm']);
    });

    it('reads candidates out of a fenced block', () => {
        expect(parseAICandidates('```css\n#first\n#second\n```')).toEqual(['#first', '#second']);
    });

    it('returns nothing for a refusal', () => {
        expect(parseAICandidates('FAIL')).toEqual([]);
    });

    it('returns nothing for empty input', () => {
        expect(parseAICandidates('')).toEqual([]);
        expect(parseAICandidates(undefined)).toEqual([]);
    });

    it('falls back to the single-answer parser when no line looks like a selector', () => {
        // Preserves the existing contract: hand something to validation to
        // reject rather than silently dropping the reply.
        expect(parseAICandidates('I could not find a match.\nPlease check manually.')).toEqual([
            'Please check manually.',
        ]);
    });

    it('strips surrounding quotes from each candidate', () => {
        expect(parseAICandidates('"#first"\n\'#second\'')).toEqual(['#first', '#second']);
    });
});
