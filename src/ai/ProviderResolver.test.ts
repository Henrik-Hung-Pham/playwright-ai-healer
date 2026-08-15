import { describe, it, expect } from 'vitest';
import { resolveAIProvider, type AICredentialsConfig } from './ProviderResolver.js';

/** A config slice with credentials for *both* providers present. */
function bothKeysConfigured(provider: AICredentialsConfig['provider']): AICredentialsConfig {
    return {
        provider,
        gemini: { apiKey: 'gemini-key', modelName: 'gemma-4-31b-it' },
        openai: { apiKeys: ['sk-one', 'sk-two'], modelName: 'gpt-4o' },
    };
}

describe('resolveAIProvider', () => {
    describe('AI_PROVIDER is the authority', () => {
        it('resolves to OpenAI when AI_PROVIDER=openai even though a Gemini key is present', () => {
            // The regression this function exists for. Provider used to be chosen by
            // key presence (`if (ai.gemini.apiKey) …`), so this exact configuration
            // silently ran Gemini while the docs advertised AI_PROVIDER as the switch.
            const resolved = resolveAIProvider(bothKeysConfigured('openai'));

            expect(resolved.provider).toBe('openai');
            expect(resolved.apiKeys).toEqual(['sk-one', 'sk-two']);
            expect(resolved.modelName).toBe('gpt-4o');
        });

        it('resolves to Gemini when AI_PROVIDER=gemini even though OpenAI keys are present', () => {
            const resolved = resolveAIProvider(bothKeysConfigured('gemini'));

            expect(resolved.provider).toBe('gemini');
            expect(resolved.apiKeys).toBe('gemini-key');
            expect(resolved.modelName).toBe('gemma-4-31b-it');
        });

        it('pairs each provider with its own model, never the other model', () => {
            expect(resolveAIProvider(bothKeysConfigured('openai')).modelName).not.toBe('gemma-4-31b-it');
            expect(resolveAIProvider(bothKeysConfigured('gemini')).modelName).not.toBe('gpt-4o');
        });
    });

    describe('credential handling', () => {
        it('passes every OpenAI key through so rotation stays available', () => {
            const resolved = resolveAIProvider({
                provider: 'openai',
                gemini: { apiKey: undefined, modelName: 'gemma-4-31b-it' },
                openai: { apiKeys: ['sk-a', 'sk-b', 'sk-c'], modelName: 'gpt-4o' },
            });

            expect(resolved.apiKeys).toHaveLength(3);
        });

        it('resolves Gemini with only a Gemini key configured', () => {
            const resolved = resolveAIProvider({
                provider: 'gemini',
                gemini: { apiKey: 'only-gemini', modelName: 'gemma-4-31b-it' },
                openai: { apiKeys: [], modelName: 'gpt-4o' },
            });

            expect(resolved.provider).toBe('gemini');
            expect(resolved.apiKeys).toBe('only-gemini');
        });
    });

    describe('missing credentials', () => {
        it('throws an actionable error when OpenAI is selected with no OpenAI key', () => {
            expect(
                () =>
                    resolveAIProvider({
                        provider: 'openai',
                        gemini: { apiKey: 'gemini-key', modelName: 'gemma-4-31b-it' },
                        openai: { apiKeys: [], modelName: 'gpt-4o' },
                    })
                // Explicitly does NOT silently fall back to the Gemini key that is
                // sitting right there — that substitution is the original bug.
            ).toThrow(/AI_PROVIDER is "openai" but no OpenAI key is configured/);
        });

        it('throws an actionable error when Gemini is selected with no Gemini key', () => {
            expect(() =>
                resolveAIProvider({
                    provider: 'gemini',
                    gemini: { apiKey: undefined, modelName: 'gemma-4-31b-it' },
                    openai: { apiKeys: ['sk-one'], modelName: 'gpt-4o' },
                })
            ).toThrow(/AI_PROVIDER is "gemini" but GEMINI_API_KEY is not set/);
        });

        it('names the remedy in the error so the fix does not require reading source', () => {
            expect(() =>
                resolveAIProvider({
                    provider: 'openai',
                    gemini: { apiKey: undefined, modelName: 'gemma-4-31b-it' },
                    openai: { apiKeys: [], modelName: 'gpt-4o' },
                })
            ).toThrow(/OPENAI_API_KEY/);
        });
    });
});
