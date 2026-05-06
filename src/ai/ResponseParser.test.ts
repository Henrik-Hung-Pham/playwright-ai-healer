import { describe, it, expect } from 'vitest';
import { parseAIResponse } from './ResponseParser.js';

describe('ResponseParser', () => {
    describe('parseAIResponse()', () => {
        it('should return null for undefined input', () => {
            expect(parseAIResponse(undefined)).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(parseAIResponse('')).toBeNull();
        });

        it('should return null for FAIL response', () => {
            expect(parseAIResponse('FAIL')).toBeNull();
        });

        it('should strip triple backtick code fences', () => {
            expect(parseAIResponse('```\n#selector\n```')).toBe('#selector');
        });

        it('should extract last backtick-quoted span', () => {
            expect(parseAIResponse('The selector is `#first` or `#second`')).toBe('#second');
        });

        it('should strip surrounding double quotes', () => {
            expect(parseAIResponse('"#quoted-selector"')).toBe('#quoted-selector');
        });

        it('should strip surrounding single quotes', () => {
            expect(parseAIResponse("'#quoted-selector'")).toBe('#quoted-selector');
        });

        it('should trim whitespace', () => {
            expect(parseAIResponse('  #selector  ')).toBe('#selector');
        });

        it('should return plain selector as-is', () => {
            expect(parseAIResponse('#submit-btn')).toBe('#submit-btn');
        });

        it('should return null for whitespace-only input after trimming', () => {
            expect(parseAIResponse('   ')).toBeNull();
        });

        it('should handle triple backticks without inner backtick spans', () => {
            expect(parseAIResponse('```css\n.my-class\n```')).toBe('css\n.my-class');
        });

        it('should handle single backtick wrapping', () => {
            expect(parseAIResponse('`#selector`')).toBe('#selector');
        });
    });
});
