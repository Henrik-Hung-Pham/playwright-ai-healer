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
