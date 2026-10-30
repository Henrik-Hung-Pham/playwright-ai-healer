/**
 * Public entry point for the self-healing Playwright framework.
 *
 * This barrel is the surface that `npm run docs` (TypeDoc) documents and the
 * single import path consumers should depend on:
 *
 * ```typescript
 * import { AutoHealer, LocatorManager, type HealingEvent } from 'self-healing-agent';
 * ```
 *
 * Anything re-exported here is public API — changing its signature is a breaking
 * change. Anything not re-exported is an internal detail and may change freely.
 * Site-specific page objects (`BooksHomePage`, `BookDetailPage`) are deliberately
 * excluded: they are fixtures for the demo target, not part of the library.
 */

// ── Healing API ───────────────────────────────────────────────────────────────

export { AutoHealer } from './AutoHealer.js';

export {
    AIClientManager,
    HealingEngine,
    getSimplifiedDOM,
    parseAIResponse,
    resolveAIProvider,
    validateSelector,
} from './ai/index.js';
export type { AICallResult, AICredentialsConfig, ResolvedAIProvider } from './ai/index.js';

export { DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT } from './ai/DOMSerializer.js';
export { buildHealingPrompt, HTML_BLOCK_START, HTML_BLOCK_END } from './ai/HealingPrompt.js';
export { detectStrategy, scoreSelector } from './ai/SelectorScorer.js';
export type { SelectorScore } from './ai/SelectorScorer.js';
export { RetryOrchestrator } from './ai/RetryOrchestrator.js';
export type { ErrorAction, RetryOptions, OrchestratorResult } from './ai/RetryOrchestrator.js';

// ── Locator storage ───────────────────────────────────────────────────────────

export { LocatorManager } from './utils/LocatorManager.js';
export { FileAdapter, SQLiteAdapter, createLocatorAdapter } from './utils/LocatorAdapter.js';
export type { LocatorAdapter } from './utils/LocatorAdapter.js';

// ── Page objects ──────────────────────────────────────────────────────────────

export { BasePage } from './pages/BasePage.js';

// ── Observability ─────────────────────────────────────────────────────────────

export { HealingMetrics } from './utils/HealingMetrics.js';
export { default as HealingReporter, HEALING_SHARD_DIR, HEALING_REPORT_PATH } from './reporters/HealingReporter.js';
export { CircuitBreaker } from './utils/CircuitBreaker.js';
export type { CircuitState, CircuitBreakerOptions } from './utils/CircuitBreaker.js';
export { logger, Logger } from './utils/Logger.js';

// ── Configuration ─────────────────────────────────────────────────────────────

export { config, categoriesData } from './config/index.js';
export type { AppConfig, CategoryKey } from './config/index.js';
export { loadEnvironment, getEnvironment, isDev, isProd } from './utils/Environment.js';
export type { Environment } from './utils/Environment.js';
export { BooksToScrapeHandler, NoOpHandler } from './utils/SiteHandler.js';
export type { SiteHandler } from './utils/SiteHandler.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type {
    AIProvider,
    SelectorStrategy,
    HealingResult,
    HealingEvent,
    AIError,
    ClickOptions,
    FillOptions,
    HoverOptions,
    TypeOptions,
    SelectOptionOptions,
    SelectOptionValues,
    CheckOptions,
    WaitForSelectorOptions,
    TimeoutConfig,
    AIConfig,
    LocatorStore,
    LocatorMap,
    SelectorMetrics,
    MetricsStore,
    HealOperation,
    HealAllResult,
    ProviderStats,
    HealedSelectorEntry,
    HealingReport,
} from './types.js';
