import { describe, it, expect } from 'vitest';
import { detectStrategy, scoreSelector } from './SelectorScorer.js';

describe('detectStrategy', () => {
    it('detects xpath selectors', () => {
        expect(detectStrategy('//button[@id="go"]')).toBe('xpath');
        expect(detectStrategy('./div/span')).toBe('xpath');
        expect(detectStrategy('(//a)[1]')).toBe('xpath');
    });

    it('detects role selectors', () => {
        expect(detectStrategy('role=button')).toBe('role');
        expect(detectStrategy('ROLE=textbox')).toBe('role');
    });

    it('detects playwright text-engine selectors', () => {
        expect(detectStrategy('text=Submit')).toBe('text');
        expect(detectStrategy('placeholder=Search')).toBe('text');
        expect(detectStrategy('label=Email')).toBe('text');
    });

    it('detects data-testid selectors', () => {
        expect(detectStrategy('[data-testid="login"]')).toBe('data-testid');
        expect(detectStrategy('[data-cy=submit]')).toBe('data-testid');
    });

    it('detects id selectors', () => {
        expect(detectStrategy('#search')).toBe('id');
        expect(detectStrategy('form > #submit')).toBe('id');
        expect(detectStrategy('div #nested')).toBe('id');
    });

    it('falls back to css for class/tag/attribute selectors', () => {
        expect(detectStrategy('.price_color')).toBe('css');
        expect(detectStrategy('button.primary')).toBe('css');
        expect(detectStrategy('[name="q"]')).toBe('css');
    });
});

describe('scoreSelector', () => {
    it('returns 0 confidence when the selector matches no elements', () => {
        const score = scoreSelector('#missing', 0);
        expect(score.confidence).toBe(0);
        expect(score.reasoning).toMatch(/0 elements/);
    });

    it('scores a unique id selector at full confidence', () => {
        const score = scoreSelector('#search', 1);
        expect(score.strategy).toBe('id');
        expect(score.confidence).toBe(1);
    });

    it('scores a unique css selector above the default threshold', () => {
        const score = scoreSelector('.price_color', 1);
        expect(score.strategy).toBe('css');
        // 0.8 uniqueness + 0.1 stability
        expect(score.confidence).toBeCloseTo(0.9, 5);
    });

    it('scores a unique xpath selector at the uniqueness floor', () => {
        const score = scoreSelector('//div[@class="x"]', 1);
        expect(score.strategy).toBe('xpath');
        expect(score.confidence).toBeCloseTo(0.8, 5);
    });

    it('penalises ambiguous (multi-match) css selectors below the default threshold', () => {
        const score = scoreSelector('.product_pod', 12);
        // 0.5 uniqueness + 0.1 stability = 0.6 < 0.7 default threshold
        expect(score.confidence).toBeCloseTo(0.6, 5);
        expect(score.confidence).toBeLessThan(0.7);
    });

    it('keeps an ambiguous but stable id selector at the threshold boundary', () => {
        const score = scoreSelector('#dup', 2);
        // 0.5 uniqueness + 0.2 stability = 0.7
        expect(score.confidence).toBeCloseTo(0.7, 5);
    });

    it('never exceeds a confidence of 1', () => {
        const score = scoreSelector('#unique', 1);
        expect(score.confidence).toBeLessThanOrEqual(1);
    });
});
