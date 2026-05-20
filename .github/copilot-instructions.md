# Copilot Instructions for playwright-ai-healer

## Repository Overview

This is a **Self-Healing Playwright Test Automation Framework** that uses Generative AI (OpenAI or Google Gemini) to automatically fix broken selectors at runtime. The framework wraps Playwright page interactions and attempts to heal broken selectors using AI when interactions fail.

**Key Technologies:**

- TypeScript (ES Modules)
- Playwright for browser automation
- Vitest for unit testing
- OpenAI GPT and Google Gemini for AI healing
- Winston for structured logging
- ESLint and Prettier for code quality

**Repository Size:** Small to medium (~20 TypeScript files)
**Type:** Test automation framework library
**Target Runtime:** Node.js 18+ with ES Modules

## Build and Validation Instructions

### Prerequisites

- Node.js 24.x (as specified in `.nvmrc` and `engines.node` in `package.json`)
- npm for package management
- **ALWAYS run `npm install` after cloning or when dependencies change**

### Installation Steps

```bash
# Install dependencies (REQUIRED before any other commands)
npm install

# Install Playwright browsers (required for E2E tests)
npx playwright install --with-deps
```

### Build and Validation Commands

**Type Checking:** (Runs first in validation pipeline)

```bash
npm run typecheck
```

- Validates TypeScript compilation without emitting files
- Must pass with no errors

**Linting:** (Runs second in validation pipeline)

```bash
npm run lint          # Check for issues
npm run lint:fix      # Auto-fix issues
```

- Some existing warnings about `any` types and unsafe assignments are acceptable
- There are 2 existing errors that should not be introduced in new code
- Focus on fixing errors, not warnings, unless they're in your changes

**Formatting:** (Runs third in validation pipeline)

```bash
npm run format:check  # Check formatting
npm run format        # Auto-format code
```

- Uses Prettier for consistent code style
- Should always pass before committing

**Unit Tests:** (Runs fourth in validation pipeline)

```bash
npm run test:unit              # Run once
npm run test:unit:watch        # Watch mode for development
npm run test:coverage          # With coverage report
```

- Expected: All tests pass
- Takes ~1 second to run
- Must pass before committing

**Complete Validation:** (Run before creating PR)

```bash
npm run validate
```

- Runs typecheck → lint → format:check → test:unit in sequence
- This is the recommended pre-commit check
- All steps must pass

**Playwright E2E Tests:**

```bash
# Development (visible browser)
npm run test:dev

# Production (headless, all 9 browser configurations)
npm run test:prod:all-browsers

# Specific browsers
npm run test:chromium
npm run test:firefox
npm run test:webkit
```

- Requires `GEMINI_API_KEY` or `OPENAI_API_KEY` environment variable
- E2E tests may take several minutes to complete
- Expect some flakiness with E2E tests (retries configured in CI)

### CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/playwright.yml`) runs on:

- Push to `main`
- Pull requests to `main`
- Scheduled daily runs (06:00 UTC)
- Manual trigger

**Workflow steps:**

1. Install dependencies with `npm ci` (not `npm install`)
2. Run `npm audit --audit-level=high` and `npm run lint`
3. Run unit tests with coverage
4. Install Playwright browsers (cached per engine)
5. Run Playwright E2E tests on all 9 browser configurations, including Self-Healing tests on every browser
6. Upload test reports as artifacts

**Environment Requirements for CI:**

- `GEMINI_API_KEY` secret must be configured in GitHub repository settings

## Project Layout and Architecture

### Root Directory Files

```
.env.example           # Template for environment configuration
.env.dev              # Development environment config
.env.staging          # Staging environment config
.env.prod             # Production environment config
.gitignore            # Excludes node_modules, test results, logs
.prettierignore       # Files to skip formatting
.prettierrc.json      # Prettier configuration
eslint.config.js      # ESLint configuration (modern flat config)
playwright.config.ts  # Playwright test configuration
tsconfig.json         # TypeScript configuration (ES Modules, strict mode)
vitest.config.ts      # Vitest unit test configuration
package.json          # Dependencies and scripts
README.md             # User-facing documentation
CONTRIBUTING.md       # Contributor guidelines
SECURITY.md           # Security guidelines
```

### Source Code Structure (`src/`)

**Core File:**

- `src/AutoHealer.ts` - Main self-healing logic, wraps Playwright interactions with AI fallback
    - Exports `AutoHealer` class with methods: `click()`, `fill()`, `hover()`, `type()`, `check()`, `uncheck()`, `selectOption()`, `waitForSelector()`, `healAll()`
    - Delegates AI healing to `HealingEngine`; delegates selector persistence to `LocatorManager`

**AI Sub-package (`src/ai/`):**

- `src/ai/AIClientManager.ts` - AI client lifecycle, API key rotation, provider failover, `makeRequest()` with timeout
- `src/ai/HealingEngine.ts` - Orchestrates the full heal cycle: DOM capture → AI request → response parsing → selector validation → confidence check
- `src/ai/RetryOrchestrator.ts` - Exponential backoff with jitter for AI retry loops
- `src/ai/DOMSerializer.ts` - `getSimplifiedDOM(page)` — focused interactive-element snapshot for the AI prompt
- `src/ai/ResponseParser.ts` - `parseAIResponse()` — strips markdown fences, backticks, and quotes from raw AI output
- `src/ai/SelectorValidator.ts` - Denylist/allowlist guard that validates AI-returned selectors before use
- `src/ai/index.ts` - Barrel re-export for the `ai/` sub-package

**Configuration:**

- `src/config/index.ts` - Centralized configuration object validated with Zod
    - Exports `config` with app settings, AI provider settings, selectors
    - Loads environment-specific config via `loadEnvironment()`
- `src/config/locators.json` - Persistent storage for healed selectors
- `src/config/metrics.json` - Per-key selector failure/heal metrics

**Page Objects:** (Page Object Model pattern)

- `src/pages/BasePage.ts` - Abstract base page with common functionality
- `src/pages/BooksHomePage.ts` - Books to Scrape home page
- `src/pages/BookDetailPage.ts` - Book detail page

**Utilities:**

- `src/utils/Environment.ts` - Multi-environment loader (.env.dev, .env.staging, .env.prod)
- `src/utils/Logger.ts` - Winston logger wrapper with console + file output
- `src/utils/LocatorManager.ts` - Singleton facade over a pluggable `LocatorAdapter`; dot-path key access; tracks selector stability metrics
- `src/utils/LocatorAdapter.ts` - `LocatorAdapter` interface with `FileAdapter` (JSON + lockfile) and `SQLiteAdapter` (ACID SQLite) implementations
- `src/utils/CircuitBreaker.ts` - Per-provider circuit breaker; opens after 5 consecutive failures, resets after 60 s
- `src/utils/HealingMetrics.ts` - Tracks per-key selector failure and heal event counts
- `src/utils/SiteHandler.ts` - Strategy pattern for site-specific overlay dismissal (`BooksToScrapeHandler`, `NoOpHandler`)

**Testing:**

- `src/AutoHealer.test.ts` - Unit tests for AutoHealer
- `src/pages/BasePage.test.ts` - Unit tests for BasePage
- `src/utils/*.test.ts` - Unit tests for utilities
- `src/test-setup.ts` - Vitest setup and mocks
- `tests/fixtures/base.ts` - Playwright test fixtures
- `tests/books-to-scrape.spec.ts` - E2E test examples
- `tests/unit/` - Additional unit tests (autohealer-core, autohealer-error-handling)

**Type Definitions:**

- `src/types.ts` - Shared TypeScript types and interfaces

### Configuration Files

**TypeScript (`tsconfig.json`):**

- `"type": "module"` in package.json - ES Modules only
- `"module": "ESNext"` - Use latest ES module syntax
- Import paths must include `.js` extension (TypeScript convention for ES Modules)
- Strict mode enabled
- Target: ES2020

**ESLint (`eslint.config.js`):**

- Modern flat config format (not legacy .eslintrc)
- TypeScript ESLint parser and rules
- Playwright plugin for test files
- Some `any` type warnings are acceptable in test mocks

**Prettier (`.prettierrc.json`):**

- 4 spaces indentation
- Single quotes
- No trailing commas in objects
- Tab width: 4

## Key Conventions and Best Practices

### TypeScript Style

- **Strict types:** Avoid `any` where possible
- **Import extensions:** Always include `.js` extension in imports (e.g., `from './AutoHealer.js'`)
- **Type exports:** Use `type` keyword for type-only imports (e.g., `import type { Page } from '@playwright/test'`)
- **Interfaces over types:** Prefer interfaces for object shapes
- **JSDoc comments:** Required for all public APIs with `@param`, `@returns`, `@throws`, `@example` tags

### Naming Conventions

- **Classes:** PascalCase (e.g., `AutoHealer`, `LocatorManager`)
- **Functions/Methods:** camelCase (e.g., `getLocator`, `updateSelector`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `MAX_RETRIES`)
- **Files:** PascalCase for classes, camelCase for utilities
- **Test files:** `*.test.ts` suffix

### Environment Variables

- Use `process.env['VARIABLE_NAME']` (bracket notation, not dot notation)
- Never commit API keys or secrets
- All sensitive config goes in `.env.{env}` files (gitignored)
- `.env.example` contains template with all options

### Logging

- Import logger: `import { logger } from './utils/Logger.js'`
- Use appropriate levels: `logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug()`
- Log levels: debug < info < warn < error
- Default log level: `info` (configurable via `LOG_LEVEL` env var)

### Testing Guidelines

- Unit tests use Vitest with `describe`, `it`, `expect`
- Mock external dependencies (Playwright page, AI clients)
- E2E tests use Playwright with custom fixtures
- Follow AAA pattern: Arrange, Act, Assert
- Test files co-located with source: `*.test.ts` next to `*.ts`

### Error Handling

- AutoHealer catches interaction failures and attempts healing
- If the AI cannot return a usable selector (FAIL response, rate limit with no fallback, validation/confidence rejection), `AutoHealer` calls `test.skip()` rather than re-throwing
- Failed healings are logged at `warn` level
- Successful healings logged at `info` level

### AI Integration

- Supports both OpenAI (GPT-4) and Gemini (Flash/Pro)
- Provider configured via `AI_PROVIDER` env var (default: `gemini`)
- API keys support rotation (comma-separated for OpenAI)
- Healing prompt in `src/config/index.ts` → `config.ai.prompts.healingPrompt()`

## Dependencies and Architecture Notes

### Important Dependencies

- `@playwright/test` - Browser automation and testing
- `@google/generative-ai` - Gemini AI SDK
- `openai` - OpenAI SDK (GPT models)
- `winston` - Logging framework
- `dotenv` - Environment variable loading
- `vitest` - Unit testing framework
- `cross-env` - Cross-platform environment variables in scripts

### Key Architectural Patterns

- **Page Object Model (POM):** All page interactions encapsulated in page classes
- **Dependency Injection:** AutoHealer and page classes receive dependencies via constructor
- **Environment-based Configuration:** Different configs for dev/staging/prod
- **Retry with Healing:** Failed interactions trigger AI healing, then retry with new selector
- **Persistent Learning:** Healed selectors saved to `locators.json` for reuse

### Common Pitfalls to Avoid

1. **Don't use `npm install` in CI** - Use `npm ci` for reproducible builds
2. **Don't forget `.js` extensions in imports** - Required for ES Modules
3. **Don't skip `npm install`** - Required after cloning or dependency changes
4. **Don't commit secrets** - Use `.env` files (gitignored)
5. **Don't remove existing test assertions** - Some tests intentionally have no assertions for smoke testing
6. **Don't run E2E tests without API key** - They will fail without `GEMINI_API_KEY` or `OPENAI_API_KEY`

### File Locations Quick Reference

- Main entry point: `src/AutoHealer.ts`
- Configuration: `src/config/index.ts`
- Environment loader: `src/utils/Environment.ts`
- Test fixtures: `tests/fixtures/base.ts`
- CI workflow: `.github/workflows/playwright.yml`
- Linter config: `eslint.config.js`
- TypeScript config: `tsconfig.json`
