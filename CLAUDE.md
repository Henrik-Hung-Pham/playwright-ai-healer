# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (required after cloning)
npm install                           # also runs `prepare`, which sets core.hooksPath to .githooks
npx playwright install --with-deps   # For E2E tests

# Validation pipeline (run before every PR)
npm run validate                      # typecheck → lint → format:check → test:unit

# Individual checks
npm run typecheck                     # TypeScript type checking (no emit)
npm run lint                          # ESLint check
npm run lint:fix                      # ESLint auto-fix
npm run format:check                  # Prettier check
npm run format                        # Prettier auto-format
git commit -am "style: apply lint and format fixes"

# Unit tests (Vitest, ~1s)
npm run test:unit                     # Run once
npm run test:unit:watch               # Watch mode
npm run test:coverage                 # With coverage report

# Run a single unit test file
npx vitest run src/utils/LocatorManager.test.ts

# E2E tests (require GEMINI_API_KEY or OPENAI_API_KEY)
npm run test:prod                     # Headless, Desktop Chrome
npm run test:dev                      # Headed, debug logging
npm run test:healing-demo             # Self-healing demo
npm run test:prod:all-browsers        # All 9 browser configs
npm run test:debug                    # Headed with debug logs (Chromium)

# View Playwright HTML report
npx playwright show-report playwright-report
```

## Architecture

This is a **self-healing Playwright test automation framework**. When a selector-based interaction fails, `AutoHealer` intercepts the error, captures a simplified DOM snapshot, asks an AI provider (Gemini or OpenAI) for a replacement selector, and retries the action. Successfully healed selectors are persisted to `src/config/locators.json` for future runs.

### Core Data Flow

```
Test → BasePage.safeClick/safeFill
     → AutoHealer.click/fill
     → page.click(selector)  ← if fails →
     → DOMSerializer.getSimplifiedDOM() → AIClientManager.makeRequest() → AI provider (Gemini/OpenAI)
     → ResponseParser.parseAIResponse() cleans raw output
     → retry action with new selector
     → LocatorManager.updateLocator() persists new selector
```

### Key Files

| File                          | Role                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/AutoHealer.ts`           | Public healing API (`click`, `fill`, `hover`…) + `heal()` orchestration; records `HealingEvent[]`                                               |
| `src/ai/AIClientManager.ts`   | Owns AI client lifecycle (OpenAI/Gemini), API key rotation, provider failover, and raw `makeRequest()` with timeout                             |
| `src/ai/DOMSerializer.ts`     | `getSimplifiedDOM(page)` — focused snapshot of interactive elements for the AI prompt                                                           |
| `src/ai/ResponseParser.ts`    | `parseAIResponse()` — strips markdown fences, backticks, and quotes from raw AI output                                                          |
| `src/config/index.ts`         | Centralized config validated with Zod; exports `config` object; loads `.env.{TEST_ENV}` via `Environment.ts`                                    |
| `src/config/locators.json`    | Persistent selector store; updated at runtime by `LocatorManager` when healing succeeds                                                         |
| `src/utils/LocatorManager.ts` | Singleton; reads/writes `locators.json` with file locking (`proper-lockfile`); dot-path key access (e.g., `booksToScrape.bookTitle`)            |
| `src/utils/SiteHandler.ts`    | Strategy pattern for site-specific overlay dismissal; `BooksToScrapeHandler` and `NoOpHandler`                                                  |
| `src/pages/BasePage.ts`       | Abstract base for all page objects; wraps interactions with overlay dismissal, `AutoHealer` delegation, and Vercel security challenge detection |
| `src/pages/BooksHomePage.ts`  | Home page entry point; `navigateToCategory()`, `clickBook()`, `getBookCount()`, pagination support                                              |
| `src/pages/BookDetailPage.ts` | Book detail page; `getTitle()`, `getPrice()`, `getBreadcrumbs()`                                                                                |
| `tests/fixtures/base.ts`      | Playwright fixtures providing `autoHealer` and `booksPage` to E2E tests                                                                         |

### Environment Configuration

Environment is selected by `TEST_ENV` variable (`dev`/`staging`/`prod`). The config loads `.env.{TEST_ENV}` first, then `.env` overrides. Required env vars are validated with Zod at startup:

- `AI_PROVIDER=gemini|openai` (default: `gemini`)
- `GEMINI_API_KEY` — required if provider is `gemini`
- `OPENAI_API_KEY` / `OPENAI_API_KEYS` (comma-separated for rotation) — required if provider is `openai`
- `BASE_URL`, `LOG_LEVEL`, `HEADLESS`, `TEST_TIMEOUT`

### TypeScript Conventions

- **ES Modules**: `"type": "module"` in `package.json`; all imports must include `.js` extension (e.g., `from './AutoHealer.js'`)
- **Bracket notation** for env access: `process.env['VAR_NAME']`
- **Strict mode** enabled; avoid `any` in non-test code
- **Prettier**: 4-space indent, single quotes, no trailing commas

### Test Layout

- **Unit tests** (`src/**/*.test.ts`, `tests/unit/**`) — Vitest, co-located with source
- **E2E tests** (`tests/*.spec.ts`) — Playwright, excluded from Vitest via `vitest.config.ts`
- Unit tests use `src/test-setup.ts` for global mocks (e.g., `LocatorManager`, `winston`)
- E2E tests import from `tests/fixtures/base.ts` (not `@playwright/test` directly)

### Adding a New Page Object

1. Extend `BasePage` in `src/pages/`
2. Use `this.safeClick()` / `this.safeFill()` for interactions (delegates to `AutoHealer` if available)
3. Add selectors to `src/config/locators.json` with dot-path keys
4. Access via `LocatorManager.getInstance().getLocator('page.elementKey')`

### CI

GitHub Actions (`.github/workflows/playwright.yml`) runs on push/PR to `main`:

1. Unit tests with coverage
2. E2E tests across all 9 browser projects (matrix)
3. Uploads HTML reports as artifacts
   Uses `npm ci` (not `npm install`) and requires `GEMINI_API_KEY` secret.

## Agents

**Start with `lead` for any task** — it decomposes the request, delegates to the right specialists, and synthesises the results.

| Agent              | Model  | Task                                                                                                                                    |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `lead`             | opus   | Single entry point — orchestrates all other agents; enforces pre-push gates                                                             |
| `architect`        | opus   | Principal engineer — builds/modifies AutoHealer, LocatorManager, SiteHandler, BasePage, types, config; owns all architectural decisions |
| `code-reviewer`    | opus   | Review a PR, diff, or changed files; applies inline fixes for blocking issues                                                           |
| `test-engineer`    | opus   | All test work — coverage analysis, writing new test files, extending existing suites, flaky test diagnosis                              |
| `technical-writer` | sonnet | All developer-facing docs — JSDoc, README, CHANGELOG, migration guides, type documentation                                              |
| `devops-engineer`  | sonnet | CI/CD pipeline, npm deps, Playwright config, env vars, pre-push hooks, build optimisation                                               |

<!-- gitnexus:start -->

## GitNexus — Code Intelligence

This project is indexed by GitNexus as **self-healing-agent** (211 symbols, 485 relationships, 20 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/self-healing-agent/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool             | When to use                   | Command                                                                 |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `query`          | Find code by concept          | `gitnexus_query({query: "auth validation"})`                            |
| `context`        | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})`                              |
| `impact`         | Blast radius before editing   | `gitnexus_impact({target: "X", direction: "upstream"})`                 |
| `detect_changes` | Pre-commit scope check        | `gitnexus_detect_changes({scope: "staged"})`                            |
| `rename`         | Safe multi-file rename        | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher`         | Custom graph queries          | `gitnexus_cypher({query: "MATCH ..."})`                                 |

## Impact Risk Levels

| Depth | Meaning                               | Action                |
| ----- | ------------------------------------- | --------------------- |
| d=1   | WILL BREAK — direct callers/importers | MUST update these     |
| d=2   | LIKELY AFFECTED — indirect deps       | Should test           |
| d=3   | MAY NEED TESTING — transitive         | Test if critical path |

## Resources

| Resource                                            | Use for                                  |
| --------------------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/self-healing-agent/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/self-healing-agent/clusters`       | All functional areas                     |
| `gitnexus://repo/self-healing-agent/processes`      | All execution flows                      |
| `gitnexus://repo/self-healing-agent/process/{name}` | Step-by-step execution trace             |

## Self-Check Before Finishing

Before completing any code modification task, verify:

1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## CLI

- Re-index: `npx gitnexus analyze`
- Check freshness: `npx gitnexus status`
- Generate docs: `npx gitnexus wiki`

<!-- gitnexus:end -->
