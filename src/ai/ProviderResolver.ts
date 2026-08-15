import type { AIProvider } from '../types.js';

/**
 * The subset of `config.ai` needed to pick a provider and its credentials.
 *
 * Declared structurally rather than importing the full `AppConfig` so this
 * module stays free of the config singleton — it can be unit-tested against
 * plain objects without triggering Zod validation or needing API keys in env.
 */
export interface AICredentialsConfig {
    /** The provider selected by the `AI_PROVIDER` env var. */
    provider: AIProvider;
    gemini: { apiKey: string | undefined; modelName: string };
    openai: { apiKeys: string[]; modelName: string };
}

/** A provider selection paired with the credentials and model to use for it. */
export interface ResolvedAIProvider {
    provider: AIProvider;
    /** A single key, or several for rotation (OpenAI supports `OPENAI_API_KEYS`). */
    apiKeys: string | string[];
    modelName: string;
}

/**
 * Resolve which AI provider to use, along with its keys and model.
 *
 * `AI_PROVIDER` is the single authority. This exists because the choice used to
 * be made by *key presence* instead: the Playwright fixture ran
 * `if (ai.gemini.apiKey) { … } else if (ai.openai.apiKeys.length) { … }`, and
 * `AutoHealer`'s constructor defaulted `provider` to the literal `'gemini'`.
 * Nothing anywhere read `config.ai.provider`. Setting `AI_PROVIDER=openai` with
 * a `GEMINI_API_KEY` also present therefore ran Gemini while the README and
 * CLAUDE.md documented the variable as the provider switch — configuration that
 * silently disagrees with its own documentation costs more debugging time than
 * configuration that is simply absent.
 *
 * @param ai - The `config.ai` slice holding the selected provider and credentials.
 * @returns The provider to use with its credentials and model name.
 * @throws When the selected provider has no API key configured. `config`
 *   validates this at startup too; this guard keeps the function honest for
 *   direct callers and turns a missing key into a named error rather than an
 *   authentication failure on the first heal.
 */
export function resolveAIProvider(ai: AICredentialsConfig): ResolvedAIProvider {
    if (ai.provider === 'openai') {
        if (ai.openai.apiKeys.length === 0) {
            throw new Error(
                'AI_PROVIDER is "openai" but no OpenAI key is configured. ' +
                    'Set OPENAI_API_KEY (or OPENAI_API_KEYS for rotation), or set AI_PROVIDER=gemini.'
            );
        }
        return {
            provider: 'openai',
            apiKeys: ai.openai.apiKeys,
            modelName: ai.openai.modelName,
        };
    }

    if (!ai.gemini.apiKey) {
        throw new Error(
            'AI_PROVIDER is "gemini" but GEMINI_API_KEY is not set. ' +
                'Set GEMINI_API_KEY, or set AI_PROVIDER=openai with an OpenAI key.'
        );
    }
    return {
        provider: 'gemini',
        apiKeys: ai.gemini.apiKey,
        modelName: ai.gemini.modelName,
    };
}
