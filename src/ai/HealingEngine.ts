import type { Page } from '@playwright/test';
import { config } from '../config/index.js';
import { logger } from '../utils/Logger.js';
import type { AIClientManager } from './AIClientManager.js';
import { getSimplifiedDOM } from './DOMSerializer.js';
import { parseAIResponse } from './ResponseParser.js';
import { validateSelector } from './SelectorValidator.js';
import type { AIError, HealingResult, HealingEvent } from '../types.js';
import { CircuitBreaker } from '../utils/CircuitBreaker.js';

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

        // 1. Capture simplified DOM
        logger.info(`[HealingEngine:heal] 📸 Step 1: Capturing simplified DOM...`);
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
        let hasSwitchedProvider = false;
        let tokensUsed: { prompt: number; completion: number; total: number } | undefined;

        try {
            let rawResult: string | undefined;

            let maxKeyRotations = this.clientManager.getKeyCount();
            logger.info(
                `[HealingEngine:heal] 🔁 Step 3: Starting AI request loop (maxKeyRotations=${maxKeyRotations})`
            );

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

            // Outer loop for key rotation
            keyLoop: for (let k = 0; k < maxKeyRotations; k++) {
                let retryCount = 0;
                const maxRetries = config.ai.healing.maxRetries;
                logger.info(
                    `[HealingEngine:heal] 🔑 Key rotation iteration k=${k}, using key index ${this.clientManager.getCurrentKeyIndex()}`
                );

                while (retryCount <= maxRetries) {
                    logger.info(
                        `[HealingEngine:heal] 🎲 Attempt: keyIteration=${k}, retryCount=${retryCount}/${maxRetries}`
                    );
                    try {
                        const aiResult = await this.clientManager.makeRequest(promptText, config.test.timeouts.default);
                        rawResult = aiResult.raw;
                        tokensUsed = aiResult.tokensUsed;
                        logger.info(`[HealingEngine:heal] ✅ AI request succeeded, breaking out of retry loop.`);
                        this.getCircuitBreaker(this.clientManager.getProvider()).onSuccess();
                        break keyLoop;
                    } catch (reqError) {
                        const reqErrorTyped = reqError as AIError;
                        const errorMessage = reqErrorTyped.message?.toLowerCase() || '';
                        logger.error(
                            `[HealingEngine:heal] ❌ AI request FAILED. Status: ${reqErrorTyped.status}, Message: "${reqErrorTyped.message}"`
                        );
                        logger.debug(
                            `[HealingEngine:heal] Error details: ${JSON.stringify({ message: reqErrorTyped.message, status: reqErrorTyped.status, code: reqErrorTyped.code })}`
                        );

                        // Handle 503 Service Unavailable / 5xx Server Errors / Timeouts
                        const isServerError =
                            (reqErrorTyped.status && reqErrorTyped.status >= 500) ||
                            /\b503\b/.test(errorMessage) ||
                            /\b500\b/.test(errorMessage) ||
                            errorMessage.includes('service unavailable') ||
                            errorMessage.includes('overloaded') ||
                            errorMessage.includes('internal server error') ||
                            errorMessage.includes('bad gateway') ||
                            errorMessage.includes('timed out');

                        logger.info(`[HealingEngine:heal] 🔍 Error classification: isServerError=${isServerError}`);

                        if (isServerError) {
                            if (retryCount < maxRetries) {
                                retryCount++;
                                // Exponential backoff with full jitter: avoids retry storms
                                // under load against rate-limited or overloaded AI endpoints.
                                const base = Math.pow(2, retryCount) * config.ai.healing.retryDelay;
                                const jitter = Math.floor(Math.random() * base * 0.5);
                                const delay = base + jitter;
                                logger.warn(
                                    `[HealingEngine:heal] ⏳ AI Server Error (${reqErrorTyped.status}). Retrying in ${(delay / 1000).toFixed(1)}s (base=${base / 1000}s + jitter=${jitter}ms)... (Attempt ${retryCount}/${maxRetries})`
                                );
                                await new Promise(resolve => setTimeout(resolve, delay));
                                continue;
                            } else {
                                logger.error(
                                    `[HealingEngine:heal] ❌ AI Server Error after ${maxRetries} retries. Giving up.`
                                );
                                this.getCircuitBreaker(this.clientManager.getProvider()).onFailure();
                                throw reqErrorTyped;
                            }
                        }

                        // Handle 401 Auth Errors specifically for key rotation
                        const isAuthError =
                            reqErrorTyped.status === 401 ||
                            /\b401\b/.test(errorMessage) ||
                            errorMessage.includes('unauthorized');

                        logger.info(`[HealingEngine:heal] 🔍 Error classification: isAuthError=${isAuthError}`);

                        if (isAuthError) {
                            logger.warn(`[HealingEngine:heal] 🔑 Auth Error (401). Attempting key rotation...`);
                            const rotated = this.clientManager.rotateKey();
                            if (rotated) {
                                logger.info(
                                    `[HealingEngine:heal] 🔄 Key rotation result: ${rotated} (new index: ${this.clientManager.getCurrentKeyIndex()})`
                                );
                                continue keyLoop;
                            }
                            logger.info(
                                `[HealingEngine:heal] ⚠️ Key rotation exhausted. Falling through to provider switch.`
                            );
                        }

                        // Handle 4xx Client Errors (Rate limit, Auth fallback, Quota, etc)
                        const is4xxError =
                            (reqErrorTyped.status && reqErrorTyped.status >= 400 && reqErrorTyped.status < 500) ||
                            /\b429\b/.test(errorMessage) ||
                            errorMessage.includes('rate limit') ||
                            errorMessage.includes('resource exhausted') ||
                            errorMessage.includes('insufficient quota') ||
                            isAuthError;

                        logger.info(`[HealingEngine:heal] 🔍 Error classification: is4xxError=${is4xxError}`);

                        if (is4xxError) {
                            logger.warn(
                                `[HealingEngine:heal] ⚠️ Client Error (4xx) detected: ${reqErrorTyped.status}. Attempting to switch AI provider...`
                            );
                            if (!hasSwitchedProvider && this.clientManager.switchProvider()) {
                                hasSwitchedProvider = true;
                                maxKeyRotations = this.clientManager.getKeyCount();
                                k = -1; // Reset loop to restart with the new provider
                                continue keyLoop;
                            } else {
                                logger.error(
                                    `[HealingEngine:heal] ❌ No alternate provider configured or provider already switched. Healing aborted.`
                                );
                                return null;
                            }
                        }

                        logger.error(`[HealingEngine:heal] 🚨 Unhandled error type. Re-throwing.`);
                        throw reqErrorTyped;
                    }
                }
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
                    // Verify the healed selector actually matches an element on the page
                    const elementCount = await page.locator(parsed).count();
                    const confidence = elementCount > 0 ? 1.0 : 0.0;
                    if (confidence < config.ai.healing.confidenceThreshold) {
                        logger.warn(
                            `[HealingEngine:heal] 🛡️ HEALING REJECTED. Healed selector "${parsed}" matched 0 elements (confidence=${confidence} < threshold=${config.ai.healing.confidenceThreshold})`
                        );
                    } else {
                        healingSuccess = true;
                        healingResult = {
                            selector: parsed,
                            confidence,
                            reasoning: 'AI found replacement selector.',
                            strategy: 'css',
                        };
                        logger.info(`[HealingEngine:heal] ✨ HEALING SUCCEEDED! New selector: "${parsed}"`);
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
            this.healingEvents.push({
                timestamp: new Date().toISOString(),
                originalSelector,
                result: healingResult,
                ...(healingSuccess ? {} : { error: error.message }),
                success: healingSuccess,
                provider: this.clientManager.getProvider(),
                durationMs,
                ...(tokensUsed ? { tokensUsed } : {}),
                domSnapshotLength: htmlSnapshot.length,
            });
            if (this.healingEvents.length > HealingEngine.MAX_HEALING_EVENTS) {
                this.healingEvents.shift();
            }
        }

        return healingResult;
    }
}
