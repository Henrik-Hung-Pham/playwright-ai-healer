import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';

export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unsafe-assignment': 'error',
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        files: ['tests/**/*.spec.ts'],
        plugins: {
            playwright,
        },
        rules: {
            ...playwright.configs.recommended.rules,
            'playwright/expect-expect': ['warn', { assertFunctionNames: ['expect'], assertFunctionPatterns: ['^verify'] }],
        },
    },
    {
        // `.claude/` and `.gitnexus/` are git-ignored tool scratch directories — generated
        // CommonJS and agent worktrees that are not part of this project's source.
        ignores: [
            'node_modules/',
            'dist/',
            '*.js',
            'playwright-report/',
            'test-results/',
            'coverage/',
            '.claude/',
            '.gitnexus/',
        ],
    }
);
