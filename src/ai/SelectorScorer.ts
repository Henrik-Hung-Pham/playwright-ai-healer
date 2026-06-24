import type { SelectorStrategy } from '../types.js';

/**
 * The outcome of scoring an AI-suggested selector against the live DOM.
 */
export interface SelectorScore {
    /** Confidence in the range 0–1. Compared against `config.ai.healing.confidenceThreshold`. */
    confidence: number;
    /** The selector strategy detected from the selector string. */
    strategy: SelectorStrategy;
    /** Human-readable explanation of how the confidence was derived. */
    reasoning: string;
}

/**
 * Per-strategy stability bonus added on top of the base uniqueness score.
 *
 * Semantic, intent-revealing locators (id, data-testid, role) are far less
 * brittle than positional CSS or XPath, so they earn a higher bonus.
 */
const STRATEGY_STABILITY_BONUS: Record<SelectorStrategy, number> = {
    id: 0.2,
    'data-testid': 0.2,
    role: 0.2,
    text: 0.1,
    css: 0.1,
    xpath: 0.0,
};

/**
 * Infer the selector strategy from the raw selector string.
 *
 * This is a best-effort classification used purely for confidence scoring and
 * reporting — it does not change how the selector is executed.
 *
 * @param selector - The selector string returned by the AI provider.
 * @returns The detected {@link SelectorStrategy}.
 */
export function detectStrategy(selector: string): SelectorStrategy {
    const s = selector.trim();

    if (s.startsWith('//') || s.startsWith('./') || s.startsWith('(//')) return 'xpath';
    if (/^role=/i.test(s)) return 'role';
    if (/^(text|label|placeholder|alt|title)=/i.test(s)) return 'text';
    if (/data-testid|data-test|data-cy|^testid=/i.test(s)) return 'data-testid';
    // An id token (#foo) anywhere that is not part of an attribute value.
    if (/(^|[\s>+~(,])#[\w-]/.test(s)) return 'id';

    return 'css';
}

/**
 * Compute a meaningful confidence score for an AI-suggested selector.
 *
 * The score combines two measurable signals:
 *
 * 1. **Uniqueness** — a selector that resolves to exactly one element is far
 *    more trustworthy than one that matches several (which would be ambiguous,
 *    or fail Playwright strict-mode at action time) or none (a miss).
 * 2. **Strategy stability** — semantic locators (id, data-testid, role) are
 *    weighted higher than positional CSS or XPath.
 *
 * Replaces the previous binary `elementCount > 0 ? 1.0 : 0.0` heuristic, which
 * made the configurable `confidenceThreshold`, `reasoning`, and `strategy`
 * fields effectively cosmetic.
 *
 * @param selector - The AI-suggested selector.
 * @param matchCount - Number of elements the selector resolves to in the live DOM.
 * @returns A {@link SelectorScore} with confidence, detected strategy, and reasoning.
 */
export function scoreSelector(selector: string, matchCount: number): SelectorScore {
    const strategy = detectStrategy(selector);

    if (matchCount <= 0) {
        return {
            confidence: 0,
            strategy,
            reasoning: 'Selector resolved to 0 elements in the live DOM.',
        };
    }

    // A single match is strong; multiple matches are ambiguous and risk a
    // strict-mode violation when the action is retried.
    const uniquenessScore = matchCount === 1 ? 0.8 : 0.5;
    const stabilityBonus = STRATEGY_STABILITY_BONUS[strategy];
    const confidence = Math.min(1, Number((uniquenessScore + stabilityBonus).toFixed(2)));

    return {
        confidence,
        strategy,
        reasoning:
            `Resolved to ${matchCount} element(s) via a ${strategy} selector ` +
            `(uniqueness=${uniquenessScore}, stability bonus=${stabilityBonus}).`,
    };
}
