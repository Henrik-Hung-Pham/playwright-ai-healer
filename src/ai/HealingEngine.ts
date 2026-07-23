import type { Page } from '@playwright/test';
import { config } from '../config/index.js';
import { logger } from '../utils/Logger.js';
import type { AIClientManager } from './AIClientManager.js';
import { getSimplifiedDOM } from './DOMSerializer.js';
import { parseAIResponse } from './ResponseParser.js';
import { validateSelector } from './SelectorValidator.js';
import { scoreSelector } from './SelectorScorer.js';
import { RetryOrchestrator } from './RetryOrchestrator.js';
import type { HealingResult, HealingEvent } from '../types.js';
import { CircuitBreaker } from '../utils/CircuitBreaker.js';
import { HealingMetrics } from '../utils/HealingMetrics.js';

/**
 * Does the selector already pin itself to a specific element, so appending
 * `>> nth=0` would be redundant or wrong? Covers Playwright engine suffixes
 * (`>> nth=`, `>> first`, `>> last`) and positional CSS pseudo-classes.
 */
export function hasPositionalSuffix(selector: string): boolean {
    return /(>>\s*nth=|>>\s*(?:first|last)\b|:nth-child|:nth-of-type|:first-child|:last-child|:first-of-type|:last-of-type)/i.test(
        selector
    );
}

/**
 * Encapsulates the AI-powered selector healing logic.
 *
 * Given a failed selector and an error, `HealingEngine` captures a DOM snapshot,
 * asks the configured AI provider for a replacement selector, validates the result,
 * and records a `HealingEvent` for reporting.
 *
 * @example
 * ```typescript
 * const engine = new HealingEngine(clientManager);
 * const result = await engine.heal(page, '#broken-selector', error);
 * if (result) {
 *     await page.click(result.selector);
 * }
 * ```
 */
export class HealingEngine {
    /** Maximum number of healing events retained in memory. Older entries are evicted. */
    private static readonly MAX_HEALING_EVENTS = 500;

    private clientManager: AIClientManager;
    private healingEvents: HealingEvent[] = [];
    private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();

    private getCircuitBreaker(provider: string): CircuitBreaker {
        if (!this.circuitBreakers.has(provider)) {
            this.circuitBreakers.set(provider, new CircuitBreaker());
        }
        return this.circuitBreakers.get(provider)!;
    }

    /**
     * Creates a HealingEngine instance.
     *
     * @param clientManager - AI client manager that handles provider communication,
     *                        key rotation, and provider failover
     */
    constructor(clientManager: AIClientManager) {
        this.clientManager = clientManager;
    }

    /**
     * Returns all healing events recorded during this engine's lifetime.
     */
    getHealingEvents(): readonly HealingEvent[] {
        return this.healingEvents;
    }

    /**
     * Pin an ambiguous selector to its first match so it clears the uniqueness gate.
     *
     * When the AI returns a selector that resolves to several elements and carries
     * no positional suffix, append Playwright's `>> nth=0` and keep the pinned form
     * only if it now resolves to exactly one element. Selectors that already match
     * a single element, already carry a positional suffix, or fail to narrow to one
     * are returned unchanged so the downstream confidence gate still applies.
     *
     * @param page - Playwright page to evaluate match counts against.
     * @param selector - The validated, AI-suggested selector.
     * @returns The original selector, or its `>> nth=0`-pinned form when that disambiguates it.
     * @private
     */
    private async disambiguateIfAmbiguous(page: Page, selector: string): Promise<string> {
        if (hasPositionalSuffix(selector)) return selector;

        const matchCount = await page.locator(selector).count();
        if (matchCount <= 1) return selector;

        const pinned = `${selector} >> nth=0`;
        const pinnedCount = await page.locator(pinned).count();
        if (pinnedCount !== 1) return selector;

        logger.info(
            `[HealingEngine:heal] 🎯 Disambiguated ambiguous selector "${selector}" ` +
                `(${matchCount} matches) → "${pinned}".`
        );
        return pinned;
    }

    /**
     * Core healing logic -- attempts to find a new selector using AI.
     *
     * Captures a simplified DOM snapshot from the page, constructs a prompt for
     * the AI provider, handles retries / key rotation / provider failover, and
     * validates the returned selector before accepting it.
     *
     * @param page - Playwright page instance to capture the DOM from
     * @param originalSelector - The selector that failed
     * @param error - The error that occurred during the failed interaction
     * @returns A `HealingResult` if a valid replacement selector was found, `null` otherwise
     */
    async heal(page: Page, originalSelector: string, error: Error): Promise<HealingResult | null> {
        const startTime = Date.now();
        logger.info(`[HealingEngine:heal] 🏥 ========== HEALING START ==========`);
        logger.info(`[HealingEngine:heal] 🎯 Original selector: "${originalSelector}"`);
        logger.info(`[HealingEngine:heal] 💥 Error: ${error.message}`);
        logger.info(
            `[HealingEngine:heal] 🤖 Provider: ${this.clientManager.getProvider()}, Model: ${this.clientManager.getModelName()}`
        );
        logger.info(
            `[HealingEngine:heal] 🔑 Available API keys: ${this.clientManager.getKeyCount()}, Current key index: ${this.clientManager.getCurrentKeyIndex()}`
        );

        // 1. Capture simplified DOM — ONCE, before the retry loop.
        // The DOM state is static within a single heal() call (the page hasn't
        // navigated or been mutated between retries), so we cache the snapshot
        // and reuse it across all retry / key-rotation / provider-failover attempts.
        // This avoids redundant page.evaluate() calls on each retry.
        logger.info(`[HealingEngine:heal] 📸 Step 1: Capturing simplified DOM (cached for all retries)...`);
        const rawSnapshot = await getSimplifiedDOM(page);
        const htmlSnapshot = rawSnapshot.substring(0, config.ai.healing.domSnapshotCharLimit);
        logger.info(
            `[HealingEngine:heal] 📊 DOM snapshot length: ${htmlSnapshot.length}/${rawSnapshot.length} chars (limit: ${config.ai.healing.domSnapshotCharLimit})`
        );
        logger.debug(`[HealingEngine:heal] DOM snapshot preview (first 500 chars): ${htmlSnapshot.substring(0, 500)}`);

        // 2. Construct Prompt
        logger.info(`[HealingEngine:heal] ✍️ Step 2: Constructing prompt...`);
        const promptText = config.ai.prompts.healingPrompt(originalSelector, error.message, htmlSnapshot);
        logger.info(`[HealingEngine:heal] 📏 Prompt length: ${promptText.length} chars`);
        logger.debug(`[HealingEngine:heal] Prompt preview (first 300 chars): ${promptText.substring(0, 300)}`);

        let healingSuccess = false;
        let healingResult: HealingResult | null = null;
        let tokensUsed: { prompt: number; completion: number; total: number } | undefined;

        try {
            // 3. Execute AI request with automatic retry / key rotation / provider failover
            logger.info(`[HealingEngine:heal] 🔁 Step 3: Starting AI request via RetryOrchestrator`);
            const orchestrator = new RetryOrchestrator(this.clientManager);

            const provider = this.clientManager.getProvider();

            // Fast-fail if the current provider's circuit breaker is open
            const breaker = this.getCircuitBreaker(provider);
            if (breaker.isOpen()) {
                logger.warn(
                    `[HealingEngine:heal] ⚡ Circuit breaker OPEN for provider "${provider}" ` +
                        `(${breaker.getConsecutiveFailures()} consecutive failures). Fast-failing healing.`
                );
                return null;
            }

            let rawResult: string | undefined;
            try {
                const { result: aiResult } = await orchestrator.execute(() =>
                    this.clientManager.makeRequest(promptText, config.test.timeouts.default)
                );
                rawResult = aiResult.raw;
                tokensUsed = aiResult.tokensUsed;
                logger.info(`[HealingEngine:heal] ✅ AI request succeeded.`);
                this.getCircuitBreaker(this.clientManager.getProvider()).onSuccess();
            } catch {
                logger.error(`[HealingEngine:heal] ❌ All retry strategies exhausted.`);
                this.getCircuitBreaker(this.clientManager.getProvider()).onFailure();
                return null;
            }

            // 4. Parse and validate AI result
            logger.info(`[HealingEngine:heal] 🔬 Step 4: Processing AI result. Raw result: "${rawResult}"`);
            const parsed = parseAIResponse(rawResult);

            if (parsed) {
                // Validate selector safety before using it
                if (!validateSelector(parsed)) {
                    logger.warn(
                        `[HealingEngine:heal] 🛡️ HEALING REJECTED. AI-returned selector failed validation: "${parsed}"`
                    );
                } else {
                    // The model frequently returns a semantically-correct but ambiguous
                    // selector for a repeated element (e.g. `article` matching every book
                    // card). The prompt asks it to disambiguate with `>> nth=0`, but models
                    // comply unreliably — and at temperature 0 the same ambiguous answer
                    // repeats on every retry, so it can never self-correct. Apply the same
                    // disambiguation strategy deterministically here: when the selector
                    // matches several elements and carries no positional suffix, pin it to
                    // the first match and re-check before scoring.
                    const selector = await this.disambiguateIfAmbiguous(page, parsed);

                    // Score the healed selector against the live DOM. Confidence is
                    // derived from real signal — match uniqueness and selector-strategy
                    // stability — not a binary "matched something" flag.
                    const elementCount = await page.locator(selector).count();
                    const { confidence, strategy, reasoning } = scoreSelector(selector, elementCount);
                    if (confidence < config.ai.healing.confidenceThreshold) {
                        logger.warn(
                            `[HealingEngine:heal] 🛡️ HEALING REJECTED. Healed selector "${selector}" scored too low ` +
                                `(confidence=${confidence} < threshold=${config.ai.healing.confidenceThreshold}). ${reasoning}`
                        );
                    } else {
                        healingSuccess = true;
                        healingResult = {
                            selector,
                            confidence,
                            reasoning,
                            strategy,
                        };
                        logger.info(
                            `[HealingEngine:heal] ✨ HEALING SUCCEEDED! New selector: "${selector}" (confidence=${confidence}, strategy=${strategy})`
                        );
                    }
                }
            } else {
                logger.warn(`[HealingEngine:heal] 💔 HEALING FAILED. Result was: "${rawResult}" (FAIL or empty)`);
            }
        } catch (aiError) {
            const aiErrorTyped = aiError as Error;
            logger.error(
                `[HealingEngine:heal] ❌ AI Healing failed (${this.clientManager.getProvider()}): ${aiErrorTyped.message || String(aiErrorTyped)}`
            );
        } finally {
            const durationMs = Date.now() - startTime;
            logger.info(`[HealingEngine:heal] 🏁 ========== HEALING END (${durationMs}ms) ==========`);
            logger.info(
                `[HealingEngine:heal] 📋 Success: ${healingSuccess}, Result: ${healingResult ? healingResult.selector : 'null'}`
            );
            // Record the healing event, evicting the oldest entry when the cap is reached.
            const healingEvent: HealingEvent = {
                timestamp: new Date().toISOString(),
                originalSelector,
                result: healingResult,
                ...(healingSuccess ? {} : { error: error.message }),
                success: healingSuccess,
                provider: this.clientManager.getProvider(),
                durationMs,
                ...(tokensUsed ? { tokensUsed } : {}),
                domSnapshotLength: htmlSnapshot.length,
            };
            this.healingEvents.push(healingEvent);
            if (this.healingEvents.length > HealingEngine.MAX_HEALING_EVENTS) {
                this.healingEvents.shift();
            }
            HealingMetrics.getInstance().recordEvent(healingEvent);
        }

        return healingResult;
    }
}
