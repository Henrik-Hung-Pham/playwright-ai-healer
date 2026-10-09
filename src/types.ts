/**
 * Core types for the Self-Healing Playwright Agent framework
 */

/**
 * Supported AI providers
 */
export type AIProvider = 'openai' | 'gemini';

/**
 * Selector strategy used by the AI during healing
 */
export type SelectorStrategy = 'id' | 'css' | 'xpath' | 'text' | 'role' | 'data-testid';

/**
 * Structured result from an AI healing attempt
 */
export interface HealingResult {
    /** The replacement CSS/XPath/role selector returned by the AI. */
    selector: string;
    /** Confidence score in the range 0–1. Values below `config.ai.healing.confidenceThreshold` are rejected. */
    confidence: number;
    /** Human-readable explanation of why the AI chose this selector. */
    reasoning: string;
    /** Selector strategy the AI applied to locate the element. */
    strategy: SelectorStrategy;
}

/**
 * A recorded healing event for reporting
 */
export interface HealingEvent {
    /** ISO 8601 timestamp of when the healing attempt started. */
    timestamp: string;
    /** The selector that failed and triggered the healing attempt. */
    originalSelector: string;
    /** The healing result if the AI succeeded, or `null` if healing failed. */
    result: HealingResult | null;
    /** Error message from the failed AI request, if any. */
    error?: string;
    /** Whether the healing attempt ultimately succeeded. */
    success: boolean;
    /** AI provider that was used for this healing attempt. */
    provider: AIProvider;
    /** Total duration of the healing attempt in milliseconds. */
    durationMs: number;
    /** Token usage from the AI provider (if available) */
    tokensUsed?: {
        /** Number of tokens in the prompt sent to the AI. */
        prompt: number;
        /** Number of tokens in the AI's response. */
        completion: number;
        /** Total tokens consumed (prompt + completion). */
        total: number;
    };
    /** Character length of the DOM snapshot sent to the AI */
    domSnapshotLength?: number;
    /**
     * `true` when no provider returned an answer and at least one attempt was
     * rejected with a rate-limit / quota error (HTTP 429) — even if failover
     * then ended on a different error. Absent otherwise.
     */
    rateLimited?: boolean;
}

/**
 * AI error with optional status code
 */
export interface AIError extends Error {
    /** HTTP status code from the AI provider response, if available. */
    status?: number;
    /** Provider-specific error code string, if available. */
    code?: string;
}

/**
 * Click options extending Playwright's native options
 */
export interface ClickOptions {
    /** Maximum time in milliseconds to wait for the element to be actionable. */
    timeout?: number;
    /** Bypass actionability checks and force the click. */
    force?: boolean;
    /** Do not wait for initiated navigations to finish after the click. */
    noWaitAfter?: boolean;
    /** Perform a trial run — check actionability without actually clicking. */
    trial?: boolean;
    /** Click at this position relative to the element's top-left corner. */
    position?: { x: number; y: number };
}

/**
 * Fill options extending Playwright's native options
 */
export interface FillOptions {
    /** Maximum time in milliseconds to wait for the element to be actionable. */
    timeout?: number;
    /** Do not wait for initiated navigations to finish after filling. */
    noWaitAfter?: boolean;
    /** Bypass actionability checks and force the fill. */
    force?: boolean;
}

/**
 * Hover options extending Playwright's native options
 */
export interface HoverOptions {
    /** Maximum time in milliseconds to wait for the element to be actionable. */
    timeout?: number;
    /** Bypass actionability checks and force the hover. */
    force?: boolean;
    /** Hover at this position relative to the element's top-left corner. */
    position?: { x: number; y: number };
}

/**
 * Type (pressSequentially) options
 */
export interface TypeOptions {
    /** Delay in milliseconds between consecutive key presses. */
    delay?: number;
    /** Maximum time in milliseconds to wait for the element to be actionable. */
    timeout?: number;
}

/**
 * SelectOption options extending Playwright's native options
 */
export interface SelectOptionOptions {
    /** Maximum time in milliseconds to wait for the element to be actionable. */
    timeout?: number;
    /** Bypass actionability checks and force the selection. */
    force?: boolean;
}

/**
 * SelectOption value argument — mirrors Playwright's overload
 */
export type SelectOptionValues = string | string[] | { value?: string; label?: string; index?: number };

/**
 * Check/uncheck options extending Playwright's native options
 */
export interface CheckOptions {
    /** Maximum time in milliseconds to wait for the element to be actionable. */
    timeout?: number;
    /** Bypass actionability checks and force the check/uncheck. */
    force?: boolean;
    /** Click at this position relative to the element's top-left corner. */
    position?: { x: number; y: number };
}

/**
 * WaitForSelector options extending Playwright's native options
 */
export interface WaitForSelectorOptions {
    /** Expected element state to wait for. Defaults to `'visible'`. */
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
    /** Maximum time in milliseconds to wait for the selector to satisfy the `state` condition. */
    timeout?: number;
}

/**
 * Timeout configuration used across the test framework (all values in milliseconds)
 */
export interface TimeoutConfig {
    /** Default timeout for most page interactions. */
    default: number;
    /** Timeout for waiting on cookie/consent banners to appear. */
    cookie: number;
    /** Timeout for URL pattern verification after navigation. */
    urlVerify: number;
    /** Timeout for waiting on product visibility assertions. */
    productVisibility: number;
    /** Timeout for click and hover actions. */
    click: number;
    /** Timeout for fill and type actions. */
    fill: number;
}

/**
 * AI provider configuration used by `AutoHealer`
 */
export interface AIConfig {
    /** Active AI provider. */
    provider: AIProvider;
    gemini: {
        /** Gemini API key. Required when `provider` is `'gemini'`. */
        apiKey?: string;
        /** Gemini model name (e.g. `'gemini-flash-latest'`). */
        modelName: string;
    };
    openai: {
        /** Ordered list of OpenAI API keys used for key rotation. */
        apiKeys: string[];
        /** OpenAI model name (e.g. `'gpt-4o'`). */
        modelName: string;
        /** Primary OpenAI API key (first entry in `apiKeys`). */
        apiKey?: string;
    };
    healing: {
        /** Maximum number of AI retry attempts per healing event. */
        maxRetries: number;
        /** Delay in milliseconds between retry attempts. */
        retryDelay: number;
        /** Minimum confidence score (0–1) required to accept an AI-suggested selector. */
        confidenceThreshold: number;
        /** Maximum character length of the DOM snapshot sent to the AI provider. */
        domSnapshotCharLimit: number;
    };
    prompts: {
        /** Function that builds the healing prompt sent to the AI. */
        healingPrompt: (selector: string, error: string, html: string) => string;
    };
}

/**
 * Locator storage structure - supports nested locator objects
 */
export interface LocatorStore {
    [key: string]: string | LocatorStore;
}

/**
 * Stability metrics for a single healed selector.
 *
 * Tracks how many times a healed selector later failed again, enabling
 * users to identify selectors that are fragile even after healing.
 */
export interface SelectorMetrics {
    /** Number of times this selector failed after being healed. */
    failureCount: number;
    /** ISO 8601 timestamp of the most recent post-healing failure. */
    lastFailedAt?: string;
    /** ISO 8601 timestamp of the most recent healing event. */
    healedAt?: string;
    /**
     * Snapshot of the element this key resolved to the last time it worked.
     *
     * Recorded on a *successful* interaction — the one moment the framework
     * knows the selector is pointing at the right thing. Healing had no such
     * record before, so a repair could only be judged on whether the replacement
     * resolved uniquely, never on whether it resolved to the same element.
     *
     * Typed as `ElementFingerprint` in `src/ai/ElementFingerprint.ts`; declared
     * structurally here to keep `types.ts` free of a module-level import cycle.
     */
    fingerprint?: import('./ai/ElementFingerprint.js').ElementFingerprint;
    /**
     * The selector that was in the store immediately before the most recent heal.
     *
     * This is the revert target: without it a healed selector that turns out to be
     * wrong is permanent, because the value it replaced is gone.
     */
    previousSelector?: string;
    /** The healed selector that was rolled back after repeated failures. */
    quarantinedSelector?: string;
    /** ISO 8601 timestamp of the most recent quarantine. */
    quarantinedAt?: string;
    /** How many times a healed selector for this key has been quarantined. */
    quarantineCount?: number;
    /**
     * Heals applied to this key, oldest first, capped at
     * {@link MAX_PROVENANCE_ENTRIES}.
     *
     * Without this the locator store is a destructive overwrite: `updateLocator`
     * replaces a human-authored selector with a model-authored one and the
     * original is gone. Nothing records what it was, which model proposed the
     * replacement, or how confident the scorer was — so a bad heal cannot be
     * reviewed after the fact and cannot be undone. This is a manual audit trail,
     * independent of the automatic quarantine rollback above (which still governs
     * `previousSelector` / `quarantinedSelector` and fires on
     * `SELECTOR_QUARANTINE_THRESHOLD`).
     */
    history?: HealProvenance[];
}

/**
 * How many heals are retained per key before the oldest is evicted.
 *
 * Deep history has no consumer — a revert only ever needs the most recent
 * entry — while an unbounded array would grow `metrics.json` without limit
 * across long-lived branches.
 */
export const MAX_PROVENANCE_ENTRIES = 10;

/**
 * A single recorded heal: what was replaced, with what, by whom, and on what evidence.
 *
 * This is the audit trail that makes an AI-authored selector reviewable. Every
 * field is something a human needs in order to decide whether to keep the heal:
 * the previous value to compare against, the model to attribute it to, and the
 * score to judge how much the framework trusted it.
 */
export interface HealProvenance {
    /** The selector that was replaced — the value `revertLocator` restores. */
    previousSelector: string;
    /** The selector that replaced it. */
    healedSelector: string;
    /** ISO 8601 timestamp of the heal. */
    healedAt: string;
    /** Provider that produced the replacement (`'gemini'` / `'openai'`). */
    provider: string;
    /** Model name that produced the replacement. */
    model: string;
    /** Confidence the scorer assigned (0–1). */
    confidence: number;
    /** Selector strategy detected in the replacement. */
    strategy: SelectorStrategy;
}

/**
 * What `LocatorManager.recordSelectorFailure()` did in response to a failure.
 *
 * Returned rather than only logged so callers can surface a rollback in their own
 * reporting — a silent revert would be as opaque as the silent non-revert it replaces.
 */
export interface SelectorFailureOutcome {
    /** Whether a metrics update was written (false when the key was never healed). */
    recorded: boolean;
    /** Post-increment consecutive failure count since the last heal. */
    failureCount: number;
    /** Whether this failure crossed the threshold and triggered a rollback. */
    quarantined: boolean;
    /** The selector restored into the locator store, when a rollback occurred. */
    revertedTo?: string;
    /** The healed selector that was rolled back, when a rollback occurred. */
    quarantinedSelector?: string;
}

/**
 * Flat map of dot-path locator keys → their stability metrics.
 *
 * @example { "booksToScrape.searchInput": { failureCount: 2, lastFailedAt: "2026-03-02T…" } }
 */
export interface MetricsStore {
    [key: string]: SelectorMetrics;
}

/**
 * Recursive type for nested locator storage (e.g., { booksToScrape: { searchInput: "#id" } })
 */
export interface LocatorMap {
    [key: string]: string | LocatorMap;
}

/**
 * A single operation descriptor for `AutoHealer.healAll()`.
 *
 * Describes a Playwright action that should be attempted concurrently with
 * other operations; any that fail will have their selectors healed in parallel
 * via AI before being retried.
 */
export interface HealOperation {
    /** CSS selector or locator key (dot-path into locators.json). */
    selectorOrKey: string;
    /**
     * Playwright action to perform.
     * Note: `selectOption` is intentionally excluded — its complex value signature
     * (`string | string[] | { value?; label?; index? }`) does not map cleanly to
     * the single optional `value` field. Use `AutoHealer.selectOption()` directly
     * for that case.
     */
    action: 'click' | 'fill' | 'hover' | 'type' | 'check' | 'uncheck' | 'waitForSelector';
    /** Value to use for `fill` / `type` actions. */
    value?: string;
}

/**
 * Per-operation result from `AutoHealer.healAll()`.
 */
export interface HealAllResult {
    /** The original selector/key passed in. */
    selectorOrKey: string;
    /** Whether the operation ultimately succeeded (after healing if needed). */
    success: boolean;
    /** The new selector returned by AI healing, if healing was performed. */
    healedSelector?: string;
    /** Error message if the operation failed even after healing. */
    error?: string;
}

/**
 * Per-provider statistics in a healing report.
 */
export interface ProviderStats {
    /** Total healing attempts made with this provider. */
    attempts: number;
    /** Number of successful healing attempts. */
    successes: number;
}

/**
 * A single entry in the top-healed-selectors list.
 */
export interface HealedSelectorEntry {
    /** The original selector that failed. */
    original: string;
    /** The replacement selector returned by AI. */
    healed: string;
    /** Number of times this original selector was healed. */
    count: number;
}

/**
 * Aggregate healing metrics report generated by {@link HealingMetrics}.
 *
 * Contains success rates, timing data, provider breakdowns, and token usage
 * for all healing events recorded during a test session.
 *
 * @example
 * ```typescript
 * const report = HealingMetrics.getInstance().generateReport();
 * console.log(`Success rate: ${report.successRate}%`);
 * ```
 */
export interface HealingReport {
    /** Total number of healing events recorded. */
    totalEvents: number;
    /** Number of successful healing events. */
    successCount: number;
    /** Number of failed healing events. */
    failureCount: number;
    /** Success rate as a percentage (0-100). */
    successRate: number;
    /** Average healing duration in milliseconds. */
    averageHealTimeMs: number;
    /** Total tokens consumed across all healing events. */
    totalTokensUsed: number;
    /** Per-provider healing statistics. */
    providerStats: Record<string, ProviderStats>;
    /** Selectors most frequently healed, sorted by count descending. */
    topHealedSelectors: HealedSelectorEntry[];
    /** Token usage breakdown by provider. */
    tokenUsage: {
        /** Total tokens consumed across all providers. */
        total: number;
        /** Tokens consumed per provider. */
        byProvider: Record<string, number>;
    };
    /** ISO 8601 timestamp of when this report was generated. */
    generatedAt: string;
}
