import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockGeminiGenerateContent, mockOpenaiCreate } from '../test-setup.js';
import { AIClientManager } from './AIClientManager.js';

describe('AIClientManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with a single API key string', () => {
            const manager = new AIClientManager('key1', 'gemini', 'gemini-flash');
            expect(manager.getKeyCount()).toBe(1);
            expect(manager.getCurrentKeyIndex()).toBe(0);
        });

        it('should initialize with an array of API keys', () => {
            const manager = new AIClientManager(['key1', 'key2'], 'gemini', 'gemini-flash');
            expect(manager.getKeyCount()).toBe(2);
        });

        it('should store the correct provider', () => {
            const manager = new AIClientManager('key1', 'openai', 'gpt-4o');
            expect(manager.getProvider()).toBe('openai');
        });

        it('should store the correct model name', () => {
            const manager = new AIClientManager('key1', 'gemini', 'gemini-pro');
            expect(manager.getModelName()).toBe('gemini-pro');
        });
    });

    describe('rotateKey()', () => {
        it('should advance to next key and return true', () => {
            const manager = new AIClientManager(['key1', 'key2'], 'gemini', 'gemini-flash');
            expect(manager.rotateKey()).toBe(true);
            expect(manager.getCurrentKeyIndex()).toBe(1);
        });

        it('should return false when all keys are exhausted', () => {
            const manager = new AIClientManager('only-key', 'gemini', 'gemini-flash');
            expect(manager.rotateKey()).toBe(false);
            expect(manager.getCurrentKeyIndex()).toBe(0);
        });

        it('should log when in debug mode', () => {
            const manager = new AIClientManager(['key1', 'key2'], 'gemini', 'gemini-flash', true);
            manager.rotateKey();
            expect(manager.getCurrentKeyIndex()).toBe(1);
        });
    });

    describe('switchProvider()', () => {
        it('should switch from gemini to openai when openai keys are available', async () => {
            const { config } = await import('../config/index.js');
            const originalKeys = config.ai.openai.apiKeys;
            config.ai.openai.apiKeys = ['openai-key'];

            const manager = new AIClientManager('gemini-key', 'gemini', 'gemini-flash');
            const result = manager.switchProvider();

            expect(result).toBe(true);
            expect(manager.getProvider()).toBe('openai');
            expect(manager.getModelName()).toBe('gpt-4o');

            config.ai.openai.apiKeys = originalKeys;
        });

        it('should return false when switching from gemini but no openai keys', async () => {
            const { config } = await import('../config/index.js');
            const originalKeys = config.ai.openai.apiKeys;
            config.ai.openai.apiKeys = [];

            const manager = new AIClientManager('gemini-key', 'gemini', 'gemini-flash');
            const result = manager.switchProvider();

            expect(result).toBe(false);
            expect(manager.getProvider()).toBe('gemini');

            config.ai.openai.apiKeys = originalKeys;
        });

        it('should switch from openai to gemini when gemini key is available', async () => {
            const { config } = await import('../config/index.js');
            const originalKey = config.ai.gemini.apiKey;
            config.ai.gemini.apiKey = 'gemini-key';

            const manager = new AIClientManager('openai-key', 'openai', 'gpt-4o');
            const result = manager.switchProvider();

            expect(result).toBe(true);
            expect(manager.getProvider()).toBe('gemini');
            expect(manager.getModelName()).toBe('gemini-flash-latest');

            config.ai.gemini.apiKey = originalKey;
        });

        it('should return false when switching from openai but no gemini key', async () => {
            const { config } = await import('../config/index.js');
            const originalKey = config.ai.gemini.apiKey;
            config.ai.gemini.apiKey = undefined;

            const manager = new AIClientManager('openai-key', 'openai', 'gpt-4o');
            const result = manager.switchProvider();

            expect(result).toBe(false);
            expect(manager.getProvider()).toBe('openai');

            config.ai.gemini.apiKey = originalKey;
        });
    });

    describe('makeRequest()', () => {
        it('should make a request with Gemini provider', async () => {
            mockGeminiGenerateContent.mockResolvedValue({
                response: {
                    text: () => '#healed',
                    usageMetadata: {
                        promptTokenCount: 10,
                        candidatesTokenCount: 5,
                        totalTokenCount: 15,
                    },
                },
            });

            const manager = new AIClientManager('gemini-key', 'gemini', 'gemini-flash');
            const result = await manager.makeRequest('test prompt', 30000);

            expect(result.raw).toBe('#healed');
            expect(result.tokensUsed).toEqual({
                prompt: 10,
                completion: 5,
                total: 15,
            });
        });

        it('should make a request with OpenAI provider', async () => {
            mockOpenaiCreate.mockResolvedValue({
                id: 'mock-id',
                model: 'gpt-4o',
                choices: [{ message: { content: '#healed' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });

            const manager = new AIClientManager('openai-key', 'openai', 'gpt-4o');
            const result = await manager.makeRequest('test prompt', 30000);

            expect(result.raw).toBe('#healed');
            expect(result.tokensUsed).toEqual({
                prompt: 10,
                completion: 5,
                total: 15,
            });
        });

        it('should throw when no client is initialized', async () => {
            // Create manager with empty key to prevent client initialization
            const manager = new AIClientManager([], 'gemini', 'gemini-flash');
            await expect(manager.makeRequest('test', 30000)).rejects.toThrow('No AI client initialised');
        });

        it('should handle Gemini response without usageMetadata', async () => {
            mockGeminiGenerateContent.mockResolvedValue({
                response: {
                    text: () => '#healed',
                },
            });

            const manager = new AIClientManager('gemini-key', 'gemini', 'gemini-flash');
            const result = await manager.makeRequest('test prompt', 30000);

            expect(result.raw).toBe('#healed');
            expect(result.tokensUsed).toBeUndefined();
        });

        it('should handle OpenAI response without usage', async () => {
            mockOpenaiCreate.mockResolvedValue({
                id: 'mock-id',
                model: 'gpt-4o',
                choices: [{ message: { content: '#healed' } }],
            });

            const manager = new AIClientManager('openai-key', 'openai', 'gpt-4o');
            const result = await manager.makeRequest('test prompt', 30000);

            expect(result.raw).toBe('#healed');
            expect(result.tokensUsed).toBeUndefined();
        });
    });
});
