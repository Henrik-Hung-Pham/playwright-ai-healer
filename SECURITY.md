# Security Policy

## 🔒 Security Best Practices

This document outlines security best practices for using and contributing to the Self-Healing Playwright Agent.

## Reporting Security Vulnerabilities

If you discover a security vulnerability, please **DO NOT** open a public issue. Instead:

1. Email the maintainers directly (check package.json for contact info)
2. Include a detailed description of the vulnerability
3. Provide steps to reproduce if possible
4. Allow time for a fix before public disclosure

We take security seriously and will respond promptly to verified reports.

## API Key Management

### ⚠️ Never Commit API Keys

- Use environment variables (`.env` files)
- Add `.env` to `.gitignore`
- Use `.env.example` for documentation only
- Rotate keys if accidentally exposed

### Best Practices

```bash
# ✅ Good - Use environment variables
AI_PROVIDER=gemini
GEMINI_API_KEY=your_secret_key_here

# ❌ Bad - Never hardcode in source
const apiKey = "sk-abc123...";
```

### Key Rotation

The framework supports multiple API keys for automatic rotation:

```typescript
// Single key
const healer = new AutoHealer(page, process.env.API_KEY, 'gemini');

// Multiple keys for rotation (recommended)
const healer = new AutoHealer(page, [process.env.API_KEY_1, process.env.API_KEY_2], 'gemini');
```

## Input Validation

### Selector Validation

All AI-returned selectors are automatically validated by the built-in `validateSelector()` method before use. It applies two layers of protection:

1. **Denylist** — immediately rejects selectors containing dangerous patterns such as `javascript:`, `<script>`, `eval(`, `data:`, `vbscript:`, and CSS expression injection
2. **Allowlist** — only accepts known-safe patterns: CSS selectors (`#id`, `.class`, `[attr]`, `tag`), XPath (`//`, `/`), and Playwright locator engines (`text=`, `role=`, `data-testid=`, etc.)

```typescript
// Built-in — no user code required
// heal() calls validateSelector() before returning any selector
const result = await healer.heal(brokenSelector, error);
// result is null if validation fails — the test is skipped safely
```

Selectors that fail validation are logged and rejected; the test is skipped rather than retried with a potentially dangerous string.

### HTML Sanitization

The framework automatically sanitizes DOM content before sending to AI:

- Removes `<script>` tags
- Removes `<style>` tags
- Removes comments
- Limits content size

## Rate Limiting

### Built-in Protection

The framework includes built-in rate limit handling:

- Automatically detects 429 errors
- Skips tests instead of timing out
- Supports key rotation for resilience

### Recommended Limits

- **Development**: Use generous rate limits
- **CI/CD**: Monitor usage and implement backoff
- **Production**: Use multiple keys with rotation

## Secure Configuration

### Environment-Specific Settings

```bash
# Development (.env.dev)
HEADLESS=false
LOG_LEVEL=debug

# Production (.env.prod)
HEADLESS=true
LOG_LEVEL=warn
```

### Timeout Configuration

Set appropriate timeouts to prevent hanging:

```typescript
test: {
    timeout: 120000, // Global test timeout
    timeouts: {
        click: 5000,
        fill: 5000,
        cookie: 10000,
    }
}
```

## Dependencies

### Regular Updates

- Keep dependencies up to date
- Review security advisories
- Use `npm audit` regularly

```bash
# Check for vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix
```

CI runs `npm audit --audit-level=high` in a dedicated **Dependency Audit**
workflow (`.github/workflows/audit.yml`) on the nightly schedule, on manual
`workflow_dispatch`, and on pull requests that change `package.json` or
`package-lock.json`. It does not run on pull requests that leave the dependency
graph untouched, so that a newly-published advisory cannot block unrelated work.
Run the command locally before pushing any dependency change.

### Trusted Packages

This project uses well-maintained packages:

- `@playwright/test` - Official Playwright test runner
- `openai` - Official OpenAI SDK
- `@google/generative-ai` - Official Google Gemini SDK
- `winston` - Popular logging library

## Logging Security

### Safe Logging Practices

```typescript
// ✅ Good - Log without sensitive data
logger.info('[AutoHealer] Attempting click on selector');

// ❌ Bad - Don't log API keys or tokens
logger.info(`API Key: ${apiKey}`);
```

### Log Rotation

Logs are automatically rotated:

- Max file size: 5MB
- Keep last 3 files
- Located in `logs/` directory (gitignored)

## CI/CD Security

### GitHub Actions

- Use secrets for API keys
- Enable branch protection
- Require code reviews
- Run security scans

### Environment Variables in CI

```yaml
# .github/workflows/test.yml
env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Browser Security

### Sandbox Mode

Always run tests in sandboxed environments:

```typescript
// Default - secure sandbox
const browser = await chromium.launch();

// ⚠️ Avoid - disables security features
const browser = await chromium.launch({
    args: ['--no-sandbox'], // Only in trusted environments
});
```

### Context Isolation

Use isolated browser contexts:

```typescript
// Each test gets isolated context
test('my test', async ({ page }) => {
    // page is automatically isolated
});
```

## Data Privacy

> **The single most important fact about this framework:** when a selector fails,
> a snapshot of the page under test is transmitted to a third-party LLM provider.
> If you test an authenticated application against real data, that data leaves
> your infrastructure. Read this section before enabling healing anywhere near
> production.

### The egress path

Healing is the only feature that sends data off-box. Nothing is transmitted on
the happy path.

|                 |                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**     | A Playwright interaction fails and `AutoHealer` attempts a repair. Never on success.                                                   |
| **Payload**     | A simplified DOM snapshot (`DOMSerializer.getSimplifiedDOM`), the failed selector, and the Playwright error message.                   |
| **Destination** | `generativelanguage.googleapis.com` (Gemini) or `api.openai.com` (OpenAI), per `AI_PROVIDER`.                                          |
| **Volume**      | Capped by `DOM_SNAPSHOT_CHAR_LIMIT` — **default 12 000 characters** per heal attempt.                                                  |
| **Frequency**   | Once per failed interaction, per worker. The snapshot is captured once and reused across retries, key rotation, and provider failover. |
| **Retention**   | Governed entirely by your contract with the provider. This framework has no control over it.                                           |

### What is transmitted

For every **visible interactive element** (`input`, `button`, `select`,
`textarea`, `form`, `[role=button|textbox|searchbox|combobox|checkbox|radio]`,
`[onclick]`, `[data-testid]`, `[data-test]`, `[data-cy]`):

- The attributes `id`, `name`, `class`, `type`, `placeholder`, `aria-label`,
  `role`, `href`, `title`, `alt`, `for`, `action`
- Every `data-test*` and `data-cy*` attribute
- Its **direct text content**, truncated to 80 characters

For every **ancestor** of such an element: the tag name plus `id`, `name`, `role`.

If the page contains **no interactive elements at all**, a fallback path
serialises the entire `<body>` — all elements, and all text nodes truncated to
100 characters each — with only the attribute allowlist above retained.

### What is redacted

| Rule                                                                             | Applies to                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `value` attributes → `[REDACTED]`                                                | `input` / `textarea`. On the primary path `value` is additionally not in the attribute allowlist, so it is never emitted at all; the redaction is defence in depth for anyone who later adds it. |
| Email addresses → `[EMAIL]`                                                      | Text content, both paths                                                                                                                                                                         |
| Phone numbers → `[PHONE]`                                                        | Text content, both paths                                                                                                                                                                         |
| `class` attributes over 60 chars                                                 | Truncated                                                                                                                                                                                        |
| `script`, `style`, `svg`, `link`, `meta`, `noscript`, `iframe`, `video`, `audio` | Dropped entirely                                                                                                                                                                                 |

Elements hidden by CSS are skipped (`checkVisibility`). That is a snapshot-size
optimisation, not a privacy control — do not rely on it.

### Residual risk — what is NOT redacted

This is the part that matters for a risk assessment. The scrubbing is two regexes.
It does **not** remove:

- **Names, postal addresses, postcodes, national IDs, dates of birth**
- **Account numbers, order numbers, customer references, invoice IDs**
- **Session tokens, JWTs, or API keys appearing in `href` query strings** — `href`
  is on the transmitted allowlist in full
- **Non-North-American phone numbers.** The phone regex is NANP-shaped
  (`(+N) NNN-NNN-NNNN`); most international formats pass through untouched
- **Anything in `aria-label`, `title`, `alt`, or element text** beyond emails and
  phone numbers — e.g. `aria-label="Delete payment card ending 4242"`
- **Free-text content of interactive elements**, which on many applications
  includes the user's own name in a header menu button

Treat the redaction as reducing incidental exposure, not as an anonymisation
control, and never as a compliance boundary.

### Controls available today

| Control                                  | Effect                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omit `GEMINI_API_KEY` / `OPENAI_API_KEY` | The only complete opt-out. Note it is a blunt one: `resolveAIProvider` **throws**, so the run fails rather than proceeding with healing disabled. There is no graceful "healing off" switch today. |
| `DOM_SNAPSHOT_CHAR_LIMIT`                | Reduces the volume transmitted per heal. Does not change what kinds of data are eligible.                                                                                                          |
| `AI_PROVIDER`                            | Chooses which third party receives the data.                                                                                                                                                       |
| Non-production test data                 | The effective mitigation. Nothing that never enters the page can leave it.                                                                                                                         |

### Known gaps

These are not implemented and should be assumed absent when assessing risk:

- No graceful "healing disabled" mode — unsetting the key aborts the run rather
  than running the suite without healing
- No per-test or per-page opt-out — healing is all-or-nothing for a run
- No URL allowlist/denylist to suppress healing on sensitive routes
- No configurable redaction rules or custom PII patterns
- No local/self-hosted model option; both providers are external SaaS
- No audit log of what was transmitted (snapshot **length** is recorded in
  `HealingEvent.domSnapshotLength`; the content is not retained)

### Guidance by environment

- **Local development, synthetic data** — safe to enable.
- **CI against a seeded staging environment** — safe to enable, provided the seed
  data is synthetic. This is the intended deployment.
- **Any environment containing real customer data** — do not enable healing.
  Run with the API key unset. If you need healing signal, reproduce the failure
  against seeded data instead.
- **Regulated data (PCI / PHI / financial)** — do not enable. Sending cardholder
  or health data to a general-purpose LLM endpoint will not survive an audit, and
  the redaction above is not designed to make it do so.

Before enabling healing against any environment you did not seed yourself, confirm:
you have a data processing agreement with the provider, the provider's training-on-input
setting is disabled for your account, and your DPIA covers LLM egress.

## Network Security

### HTTPS Only

- Use HTTPS for all external requests
- Verify SSL certificates
- Avoid mixed content

### Proxy Support

If using a proxy, ensure it's secure:

```typescript
// Secure proxy configuration
const browser = await chromium.launch({
    proxy: {
        server: 'https://secure-proxy.example.com',
        bypass: 'localhost,127.0.0.1',
    },
});
```

## Secure Defaults

The framework is configured with secure defaults:

- ✅ Strict TypeScript compilation
- ✅ ESLint security rules enabled
- ✅ No eval or dynamic code execution
- ✅ AI-returned selectors validated via denylist + allowlist before use
- ✅ Page HTML treated as untrusted in the healing prompt (delimiter neutralisation,
  field sanitisation, explicit "data, not instructions" framing)
- ✅ Healed selectors must resolve to exactly one live DOM element before use
- ✅ No default endpoint or bundled credential — egress is impossible until an
  API key is explicitly configured
- ✅ Error messages don't leak sensitive info

Note the scope of the selector gate: it establishes that a healed selector
_resolves uniquely_, **not** that it points at the element originally intended.
A unique selector aimed at the wrong element is accepted. See
`tests/benchmark/healing-accuracy.spec.ts` for the accuracy oracle that measures
this separately.

## Compliance

### GDPR Considerations

Healing transmits page content to a third-party processor. See
[Data Privacy](#data-privacy) for exactly what is sent and what the redaction
does and does not cover.

- Establish a data processing agreement with your AI provider before enabling healing
- Disable training-on-input for your provider account
- Ensure your DPIA covers LLM egress from the test environment
- Use synthetic test data — the only complete mitigation
- Treat the built-in email/phone scrubbing as incidental-exposure reduction,
  **not** as anonymisation or pseudonymisation under Art. 4(5)

### Testing Guidelines

- Use synthetic test data
- Avoid scraping competitor sites
- Respect robots.txt
- Follow terms of service

## Security Checklist

Before deploying:

- [ ] All API keys in environment variables
- [ ] `.env` files in `.gitignore`
- [ ] Dependencies up to date
- [ ] No secrets in source code
- [ ] Logs don't contain sensitive data
- [ ] Tests use synthetic data
- [ ] Rate limits configured
- [ ] Error handling doesn't expose internals
- [ ] Security scan passed (CodeQL)
- [ ] **The target environment contains no real customer data** — or healing is
      disabled by leaving the provider API key unset
- [ ] **Data processing agreement in place** with the configured AI provider
- [ ] **Training-on-input disabled** for the provider account
- [ ] npm audit shows no vulnerabilities

## Updates

This security policy is reviewed regularly. Last updated: 2026-03-03

## Additional Resources

- [OWASP Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [Playwright Security](https://playwright.dev/docs/browser-contexts)
- [OpenAI Security](https://platform.openai.com/docs/guides/safety-best-practices)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
