import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config/index.js';
import { logger } from '../utils/Logger.js';
import type { AIProvider } from '../types.js';

export interface AICallResult {
    raw: string;
    tokensUsed?: { prompt: number; completion: number; total: number };
}

/**
 * System instruction that constrains the model to emit a bare selector.
 *
 * Providers weight a dedicated system instruction above user-prompt text, so
 * stating the output contract here — rather than only inline in the healing
 * prompt — is what stops the model from replying with a chain-of-thought essay
 * ("Task: find a replacement selector…") that the {@link parseAIResponse}
 * cleaner cannot reduce to a usable selector.
 */
const SELECTOR_SYSTEM_INSTRUCTION =
    'You are a selector-healing engine. Reply with exactly one CSS or Playwright ' +
    'selector string and nothing else — no explanation, no reasoning, no markdown, ' +
    'no code fences, no backticks, no surrounding quotes. If no element in the ' +
    'provided HTML fits, reply with exactly: FAIL';

/**
 * Deterministic decoding temperature for selector healing.
 *
 * The default provider temperature (~1.0) samples a fresh continuation on every
 * call, so an identical prompt intermittently produces a clean selector and
 * intermittently a verbose refusal — the exact source of the "flaky" self-healing
 * E2E tests. Pinning temperature to 0 removes that variance so healing is
 * reproducible. Output length is intentionally left uncapped: some models spend
 * part of their token budget on internal reasoning, and a tight cap can truncate
 * the response before the selector is emitted.
 */
const SELECTOR_TEMPERATURE = 0;

/**
 * Manages AI provider clients (OpenAI and Google Gemini), handles API key
 * rotation when keys are exhausted, and supports automatic provider failover.
 *
 * Each instance owns a single active client. Calling `rotateKey()` or
 * `switchProvider()` reinitialises the underlying client in-place so that
 * `makeRequest()` callers do not need to be aware of the switch.
 */
export class AIClientManager {
    private openai?: OpenAI;
    private gemini?: GoogleGenerativeAI;
    private provider: AIProvider;
    private modelName: string;
    private apiKeys: string[];
    private currentKeyIndex: number;
    private debug: boolean;

    constructor(apiKeys: string | string[], provider: AIProvider, modelName: string, debug = false) {
        this.apiKeys = Array.isArray(apiKeys) ? apiKeys : [apiKeys];
        this.provider = provider;
        this.modelName = modelName;
        this.currentKeyIndex = 0;
        this.debug = debug;
        this.initializeClient();
    }

    getProvider(): AIProvider {
        return this.provider;
    }

    getModelName(): string {
        return this.modelName;
    }

    getKeyCount(): number {
        return this.apiKeys.length;
    }

    getCurrentKeyIndex(): number {
        return this.currentKeyIndex;
    }

    /**
     * Advances to the next API key and reinitialises the client.
     * @returns true if a new key was available, false if all keys are exhausted
     */
    rotateKey(): boolean {
        if (this.currentKeyIndex < this.apiKeys.length - 1) {
            this.currentKeyIndex++;
            if (this.debug) logger.info(`[AIClientManager] 🔄 Rotating to API Key #${this.currentKeyIndex + 1}`);
            this.initializeClient();
            return true;
        }
        return false;
    }

    /**
     * Switches to the alternate AI provider (Gemini ↔ OpenAI) and reinitialises
     * the client using the fallback provider's configured keys.
     * @returns true if a fallback provider was available and the switch succeeded
     */
    switchProvider(): boolean {
        if (this.provider === 'gemini') {
            const openaiKeys = config.ai.openai.apiKeys;
            if (openaiKeys && openaiKeys.length > 0) {
                logger.info('[AIClientManager] 🔀 Switching from Gemini to OpenAI due to 4xx error.');
                this.provider = 'openai';
                this.apiKeys = typeof openaiKeys === 'string' ? [openaiKeys] : openaiKeys;
                this.currentKeyIndex = 0;
                this.modelName = config.ai.openai.modelName;
                this.initializeClient();
                return true;
            }
        } else if (this.provider === 'openai') {
            const geminiKey = config.ai.gemini.apiKey;
            if (geminiKey) {
                logger.info('[AIClientManager] 🔀 Switching from OpenAI to Gemini due to 4xx error.');
                this.provider = 'gemini';
                this.apiKeys = [geminiKey];
                this.currentKeyIndex = 0;
                this.modelName = config.ai.gemini.modelName;
                this.initializeClient();
                return true;
            }
        }
        return false;
    }

    /**
     * Sends a single prompt to the active provider and returns the raw response.
     * Throws the underlying API error for the caller to classify and handle.
     *
     * @param promptText - The prompt to send
     * @param timeout - Maximum milliseconds to wait for a response
     */
    async makeRequest(promptText: string, timeout: number): Promise<AICallResult> {
        if (this.provider === 'openai' && this.openai) {
            return this.callOpenAI(promptText, timeout);
        } else if (this.provider === 'gemini' && this.gemini) {
            return this.callGemini(promptText, timeout);
        } else {
            logger.error(
                `[AIClientManager] ❌ No AI client initialised! provider=${this.provider}, openai=${!!this.openai}, gemini=${!!this.gemini}`
            );
            throw new Error(
                `[AIClientManager] No AI client initialised for provider "${this.provider}". Check API key configuration.`
            );
        }
    }

    private async callOpenAI(promptText: string, timeout: number): Promise<AICallResult> {
        logger.info(`[AIClientManager] 📤 Sending request to OpenAI (model: ${this.modelName})...`);
        const completion = await this.withTimeout(
            signal =>
                this.openai!.chat.completions.create(
                    {
                        messages: [
                            { role: 'system', content: SELECTOR_SYSTEM_INSTRUCTION },
                            { role: 'user', content: promptText },
                        ],
                        model: this.modelName,
                        temperature: SELECTOR_TEMPERATURE,
                    },
                    { signal }
                ),
            timeout,
            'OpenAI'
        );
        const raw = completion.choices[0]?.message.content?.trim() ?? '';
        const usage = completion.usage;
        const tokensUsed = usage
            ? {
                  prompt: usage.prompt_tokens ?? 0,
                  completion: usage.completion_tokens ?? 0,
                  total: usage.total_tokens ?? 0,
              }
            : undefined;
        logger.info(`[AIClientManager] 📥 OpenAI response received. Result: "${raw}"`);
        logger.info(
            `[AIClientManager] 📊 OpenAI Metadata - ID: ${completion.id}, Model: ${completion.model}, Tokens (Prompt/Completion/Total): ${usage?.prompt_tokens}/${usage?.completion_tokens}/${usage?.total_tokens}`
        );
        logger.debug(`[AIClientManager] Full completion choices: ${JSON.stringify(completion.choices)}`);
        return { raw, ...(tokensUsed ? { tokensUsed } : {}) };
    }

    private async callGemini(promptText: string, timeout: number): Promise<AICallResult> {
        logger.info(`[AIClientManager] 📤 Sending request to Gemini (model: ${this.modelName})...`);
        const model = this.gemini!.getGenerativeModel({
            model: this.modelName,
            systemInstruction: SELECTOR_SYSTEM_INSTRUCTION,
            generationConfig: { temperature: SELECTOR_TEMPERATURE },
        });
        // Forward the AbortSignal to the SDK via SingleRequestOptions so a timeout
        // actually cancels the in-flight request client-side instead of leaking it
        // in the background.
        const response = await this.withTimeout(
            signal => model.generateContent(promptText, { signal }),
            timeout,
            'Gemini'
        );
        const raw = response.response.text().trim();
        const usageMetadata = response.response.usageMetadata;
        const tokensUsed = usageMetadata
            ? {
                  prompt: usageMetadata.promptTokenCount ?? 0,
                  completion: usageMetadata.candidatesTokenCount ?? 0,
                  total: usageMetadata.totalTokenCount ?? 0,
              }
            : undefined;
        logger.info(`[AIClientManager] 📥 Gemini response received. Result: "${raw}"`);
        logger.info(
            `[AIClientManager] 📊 Gemini Metadata - Tokens (Prompt/Candidates/Total): ${usageMetadata?.promptTokenCount}/${usageMetadata?.candidatesTokenCount}/${usageMetadata?.totalTokenCount}`
        );
        logger.debug(
            `[AIClientManager] Gemini full response details: ${JSON.stringify({
                candidates: response.response.candidates,
                promptFeedback: response.response.promptFeedback,
            })}`
        );
        return { raw, ...(tokensUsed ? { tokensUsed } : {}) };
    }

    private initializeClient(): void {
        const apiKey = this.apiKeys[this.currentKeyIndex];
        if (!apiKey) return;

        if (this.provider === 'openai') {
            this.openai = new OpenAI({ apiKey });
        } else {
            this.gemini = new GoogleGenerativeAI(apiKey);
        }
    }

    private async withTimeout<T>(factory: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
        const controller = new AbortController();
        // Start the request first so the factory promise is in-flight before the
        // timeout race is set up. This preserves correct error-priority ordering
        // even in test environments where setTimeout is stubbed to fire synchronously.
        const requestPromise = factory(controller.signal);
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                controller.abort();
                reject(new Error(`[AutoHealer] ${label} API request timed out after ${ms / 1000}s`));
            }, ms);
        });
        try {
            return await Promise.race([requestPromise, timeoutPromise]);
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
    }
}
