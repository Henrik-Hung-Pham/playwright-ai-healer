# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- **Patched 5 dependency advisories** (`npm audit` now reports 0 vulnerabilities) via lock-file bumps within existing semver ranges — no `package.json` changes required:
    - `vitest` <4.1.0 → 4.1.8 (critical — Vitest UI server allowed arbitrary file read/execute, [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)) and its dependent `@vitest/coverage-v8`
    - `postcss` <8.5.10 → 8.5.15 (moderate — XSS via unescaped `</style>` in stringify output, [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93))
    - `brace-expansion` 5.0.2–5.0.5 → 5.0.6 (moderate — large numeric range defeats `max` DoS protection, [GHSA-jxxr-4gwj-5jf2](https://github.com/advisories/GHSA-jxxr-4gwj-5jf2))
    - `brace-expansion` 5.0.6 → 5.0.7 (high — DoS via exponential-time expansion of consecutive non-expanding `{}` groups, [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp)); reached only as a dev-only transitive of `eslint` → `minimatch`, so no runtime exposure, but it tripped the CI `npm audit --audit-level=high` gate

### Changed

- **Default `DOM_SNAPSHOT_CHAR_LIMIT` raised from 2000 → 12000** — the previous default truncated the prepared DOM snapshot to ~13% of what the serialiser builds (it caps raw output at 15000 chars), starving the AI of context on real-world pages. The new default keeps headroom for the prompt scaffolding; lower it to trade healing accuracy for token cost.

- **Self-Healing tests run on all browsers in CI** — the `--grep-invert "Self-Healing"` filter has been removed from the Firefox and WebKit matrix shards; healing scenarios now execute across all nine browser projects (Chromium, Chrome, Edge, Mobile Chrome, Firefox, WebKit, Mobile Safari, Tablet) instead of Chromium only.

- **Healing failure → unconditional skip** — when the AI cannot return a usable replacement selector (FAIL response, 4xx with no fallback provider, validation/confidence rejection), `AutoHealer` now always calls `test.skip()` instead of throwing, regardless of `config.ai.healing.failureMode`. The test cannot proceed without a selector, so failing it adds noise rather than signal. The `failureMode` setting still gates the separate "healed selector failed during interaction" branch.

### Refactored

- `AutoHealer.ts` split into four focused modules under `src/ai/`:
    - `AIClientManager` — owns AI client lifecycle, API key rotation, provider failover, and raw `makeRequest()` calls with timeout wrapping
    - `DOMSerializer` — `getSimplifiedDOM(page)` that captures a focused interactive-element snapshot for the AI prompt
    - `ResponseParser` — `parseAIResponse()` that strips markdown fences, backticks, and surrounding quotes from raw AI responses
    - `src/ai/index.ts` — barrel re-export for the `ai/` sub-package
- `AutoHealer.ts` shrinks from 891 → 512 lines; public API and healing control flow are unchanged.

### Added

- **Coverage thresholds gate** — `vitest.config.ts` now enforces minimum coverage (lines 80 %, branches 70 %, functions 80 %, statements 80 %); the `test:coverage` step fails the build when coverage regresses.
- **CI quality gates** — GitHub Actions unit-tests job now runs `npm run typecheck` (blocks type regressions), `npm run lint` (blocks linting regressions), and `npm run format:check` (blocks formatting drift) before the test step — closing the gap where the local `npm run validate` checked types and formatting but CI did not.
- **Nightly dependency audit** — `npm audit --audit-level=high` runs in a standalone `audit` job gated to the `schedule` and `workflow_dispatch` events, rather than as a step in the PR-path unit-tests job. Advisories publish on the ecosystem's schedule, not the project's, so a newly-disclosed CVE in a transitive dependency turned unrelated PRs red before their diff was ever evaluated — twice in one day (`brace-expansion` [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), `linkify-it` [GHSA-v245-v573-v5vm](https://github.com/advisories/GHSA-v245-v573-v5vm)), both dev-only transitives with no runtime exposure. Advisories are still surfaced within a day of disclosure. Kept as its own job because `e2e-tests` declares `needs: unit-tests`, so folding the audit back in would let a fresh advisory suppress the entire nightly E2E matrix.
- **Playwright browser cache in CI** — E2E matrix jobs cache `~/.cache/ms-playwright` keyed on OS + browser group + lock-file hash, saving ~2 min per job on cache hits.
- **Exponential backoff with jitter** — The AI retry loop now adds ±50 % random jitter on top of the exponential base delay (`Math.random() * base * 0.5`) to prevent retry storms when multiple workers hit a rate-limited endpoint simultaneously. The base unit and max-retries are now read from `config.ai.healing.retryDelay` and `config.ai.healing.maxRetries` respectively instead of being hardcoded.
- **Per-provider circuit breaker** (`src/utils/CircuitBreaker.ts`) — `AutoHealer` now maintains one `CircuitBreaker` per AI provider. After 5 consecutive server-error exhaustions the circuit opens and healing fast-fails with a clear log line instead of hammering the endpoint. The circuit transitions to `HALF_OPEN` after 60 s and closes on the next successful response. 11 unit tests cover all state transitions.
- **Action-boundary uniqueness guard** — `AutoHealer.assertUniqueMatch()` re-checks a healed selector against the live DOM immediately before the retry, on both the `executeAction` and `healAll` paths, rejecting it unless it resolves to **exactly one** element. This complements the upstream `scoreSelector` confidence gate in `HealingEngine`: most multi-match selectors are already filtered by their low uniqueness score, but a multi-match selector with a stable strategy (`id` / `data-testid` / `role`) can clear the confidence threshold (`0.5 + 0.2 = 0.70`) and would otherwise trip Playwright strict-mode at action time with an opaque error. The guard turns that late, generic failure into an early, explicit `'…is ambiguous — resolved to N elements'` rejection.
- **`vbscript:` in selector denylist** — `vbscript:alert(1)` previously passed the CSS safe-character regex; the prefix is now explicitly blocked before the regex allowlist runs.
- **Adversarial selector-validator test suite** — 16 new tests covering protocol bypasses (`vbscript:`, BOM-prefix `javascript:`), control-character injection (newline, CR, null byte), Unicode lookalike characters, `eval()` variants, `document.`/`window.` inside XPath and Playwright prefixes, CSS `expression()` blocks, and chained multi-payload selectors.
- **`docs` script** — `npm run docs` generates a TypeDoc HTML API reference into `docs/` from JSDoc annotations in `src/`.
- **`CategoryMenuPage`** — new page object (`src/pages/CategoryMenuPage.ts`) for typed category navigation; `select<K extends CategoryKey>(key, subcategoryKey?)` navigates to a top-level category and optionally drills into a subcategory tile, reusing the XPath + `getByRole` fallback strategy from `GiganttiHomePage`.
- **Typed category system** — `categoriesData` const in `src/config/index.ts` defines 7 top-level categories (`computers`, `phones`, `tablets`, `tvs`, `gaming`, `cameras`, `appliances`) each with their Finnish nav label and available subcategory tiles. Exports `CategoryKey` and `SubCategoryKey<K>` types for compile-time validation — invalid keys are caught by TypeScript.
- **`GiganttiHomePage.selectCategory<K>(key, subcategoryKey?)`** — typed shortcut delegating to `CategoryMenuPage`; replaces ad-hoc `navigateToCategory(string)` calls in tests (`navigateToCategory` is retained for backward compatibility).
- **`categoryTile` locator** (`src/config/locators.json`) — `main article li a:has(img)` selector used as fallback in `CategoryPage.verifyProductsDisplayed()` for category landing pages (which show subcategory tiles rather than `[data-testid="product-card"]` grids).
- **Category and subcategory E2E tests** — `tests/gigantti.spec.ts` extended with 5 top-level category navigation tests (loop over `computers`, `phones`, `tvs`, `gaming`, `appliances`) and 7 subcategory navigation tests (`computers → allComputers/components`, `tvs → headphones`, `gaming → consoles/games`, `appliances → refrigerators/washingMachines`).
- Nav link fallback in `CategoryMenuPage._navigateByLabel` scoped to `a:not([data-testid="product-card"])` to prevent matching product card links when searching for navigation anchors.
- Multi-stage `Dockerfile` (`deps` → `runner`) reduces rebuild time by caching the `npm ci` layer separately from the Playwright image layer.
- `docker-compose.yml` now exposes two named services: `unit-tests` (runs `npm run validate`) and `e2e-tests` (runs `npm run test:prod`, mounts `playwright-report/`, `test-results/`, and `logs/` as host volumes).

### Fixed

- **Logger module init TDZ** — `src/utils/Logger.ts` constructed its winston instance at module top-level, reading `config.logging.level`. Combined with the circular import between `Logger.ts` and `src/config/index.ts`, this raised `ReferenceError: Cannot access 'config' before initialization` whenever `config/index.ts` loaded first (e.g. under Playwright's worker boot). Winston construction is now deferred behind a lazy `getWinstonLogger()` getter so `config` is touched only at log-call time.
- **Confidence threshold** — healed selectors are now verified against the live DOM before use; selectors matching zero elements are rejected (confidence below `config.ai.healing.confidenceThreshold`). Scoring is currently binary (0.0 or 1.0) with a TODO to extend to continuous scoring.
- Unit test covering the confidence-threshold rejection path (healed selector passes validation but matches 0 DOM elements).
- **Selector validation** — AI-returned selectors are checked against an allowlist of safe patterns (CSS, XPath, Playwright text engines) and a denylist of dangerous payloads (`javascript:`, `<script>`, `eval(`, etc.) before being used or persisted.
- `HoverOptions`, `TypeOptions`, `SelectOptionOptions`, `SelectOptionValues`, `CheckOptions`, `WaitForSelectorOptions` — dedicated option types in `src/types.ts` replacing inline type literals.
- `AutoHealer.hover()` — self-healing hover action with AI fallback on failure.
- `AutoHealer.type()` — self-healing character-by-character input (`pressSequentially`) with AI fallback.
- `AutoHealer.selectOption()` — self-healing `<select>` option picker with AI fallback.
- `AutoHealer.check()` / `AutoHealer.uncheck()` — self-healing checkbox actions with AI fallback.
- `AutoHealer.waitForSelector()` — self-healing element wait with AI fallback.
- `HealingEvent.tokensUsed` — records prompt, completion, and total token counts from the AI provider when available.
- `HealingEvent.domSnapshotLength` — records the character length of the DOM snapshot sent to the AI for diagnostics.
- DOM snapshot char limit is now configurable via the `DOM_SNAPSHOT_CHAR_LIMIT` environment variable.
- `AutoHealer.healAll(operations)` — batch-heals multiple failing selectors; AI requests for all failures fire in parallel (`Promise.allSettled`) while Playwright page interactions remain sequential. Returns `HealAllResult[]` with per-operation outcome.
- `HealOperation` and `HealAllResult` types added to `src/types.ts`.
- **Selector stability metrics** — `LocatorManager` now tracks per-key failure and heal events in `src/config/metrics.json`. New methods: `recordSelectorFailure(key)`, `recordSelectorHealed(key)`, `getMetrics(key?)`. `AutoHealer` wires these automatically on every healing cycle.
- `SelectorMetrics` and `MetricsStore` types added to `src/types.ts`.
- **Pluggable locator storage** — `src/utils/LocatorAdapter.ts` introduces a `LocatorAdapter` interface with two implementations: `FileAdapter` (JSON + file-locking, default) and `SQLiteAdapter` (ACID SQLite via `better-sqlite3`). Select the backend with `LOCATOR_STORE=file|sqlite`.
- `LocatorManager` is now a thin facade delegating all I/O to the active `LocatorAdapter`; public API (`getLocator`, `updateLocator`, `getAllLocators`) is unchanged.
- `LocatorManager.resetInstance()` — static method to clear the singleton for clean unit-test isolation.

### Changed

- `AutoHealer` action methods (`hover`, `type`, `selectOption`, `check`, `uncheck`, `waitForSelector`) refactored to use a shared `executeAction` helper, eliminating duplicated healing/retry/skip logic.
- `AutoHealer` automatically switches AI provider (Gemini ↔ OpenAI) when a 4xx client error is received from the active provider, provided credentials for the alternate provider are configured.
- `BasePage.waitForPageLoad` now correctly honours the `networking` option; previously the `networkidle` wait was silently skipped regardless of the flag value.
- Config singleton is now lazily initialised and deduplicates environment loading to prevent double-loading on import.
- DOM snapshot reduction is now two-tier: interactive elements are prioritised with full attributes; ancestor context is included with minimal attributes; hard cap at 15 K characters.

### Fixed

- **AbortController for API timeouts** — `withTimeout` now creates an `AbortController` and passes its signal to the AI provider HTTP call; when the timeout fires, the underlying network request is properly cancelled instead of being left to run in the background.
- Removed redundant `count()` check from `executeAction()` — `heal()` is now the single authority for DOM element verification; the duplicate check in `executeAction()` produced a confusing `"healed selector validation failed"` message instead of the canonical `"HEALING REJECTED"` from `heal()`.
- Reverted `executeAction()` visibility pre-check timeout from `config.test.timeouts.default` (60 s) back to `config.test.timeouts.short` (5 s) — a non-blocking pre-check should not delay test execution by up to 60 seconds on timeout.
- Cookie banner dismissal no longer fails when the banner is hidden at the time of the DOM snapshot — `GiganttiHandler` now waits for the banner to become visible before attempting dismissal, swallowing the timeout if it never appears.
- `LocatorManager.updateLocator` now rolls back the in-memory state if the disk write fails.
- `LocatorManager.updateLocator` now re-throws errors instead of silently swallowing them, allowing callers (e.g. `AutoHealer.executeAction`) to handle persistence failures.
- Updated `updateLocator` test mocks to return `Promise<void>` (`.mockResolvedValue(undefined)`) to match the real async signature.
- Removed dead `TreeWalker` code path from `getSimplifiedDOM()`.
- Removed unused `popupHandlerRegistered` field from `AutoHealer`.
- `SiteHandler` unit test coverage raised from 22 % to 84 % — all overlay-dismissal paths, force-hide branches, and the `NoOpHandler` are now covered.
