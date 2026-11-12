import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        pool: 'forks',
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        setupFiles: ['./src/test-setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.test.ts',
                'src/types.ts',
                'src/**/*.spec.ts',
                'src/ai/index.ts',
                'src/config/index.ts',
                'src/pages/CategoryMenuPage.ts',
            ],
            thresholds: {
                lines: 80,
                branches: 70,
                functions: 80,
                statements: 80,
            },
        },
    },
});
