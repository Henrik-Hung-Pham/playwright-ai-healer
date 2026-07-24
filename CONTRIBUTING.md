# Contributing to Self-Healing Playwright Agent

Thank you for your interest in contributing to the Self-Healing Playwright Agent! This document provides guidelines and best practices for contributing to this project.

## 🚀 Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn
- Git

### Setup

1. Fork the repository
2. Clone your fork:
    ```bash
    git clone https://github.com/your-username/playwright-ai-healer.git
    cd playwright-ai-healer
    ```
3. Install dependencies:
    ```bash
    npm install
    ```
4. Create a branch for your feature:
    ```bash
    git checkout -b feature/your-feature-name
    ```

## 🔧 Development Workflow

### Running Tests

```bash
# Run unit tests
npm run test:unit

# Run unit tests in watch mode
npm run test:unit:watch

# Run with coverage
npm run test:coverage
```

### Code Quality

Before submitting a PR, ensure your code passes all quality checks:

```bash
# Run all validation checks
npm run validate

# Or run individually:
npm run typecheck    # TypeScript compilation
npm run lint         # ESLint
npm run format:check # Prettier formatting
npm run test:unit    # Unit tests
```

### Auto-fix Issues

```bash
# Auto-fix linting issues
npm run lint:fix

# Auto-format code
npm run format
```

## 📝 Code Style Guidelines

### TypeScript

- Use strict TypeScript types - avoid `any` where possible
- Prefer interfaces for object shapes
- Use type unions for alternatives
- Document public APIs with JSDoc comments

### Naming Conventions

- **Classes**: PascalCase (e.g., `AutoHealer`, `LocatorManager`)
- **Functions/Methods**: camelCase (e.g., `getLocator`, `updateSelector`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_RETRIES`)
- **Files**: PascalCase for classes, camelCase for utilities

### Comments and Documentation

- Add JSDoc comments for all public APIs
- Include `@param`, `@returns`, `@throws` tags
- Add usage examples in JSDoc where helpful
- Comment complex logic but avoid obvious comments

Example:

```typescript
/**
 * Safe click method that attempts self-healing on failure
 *
 * @param selector - CSS selector or locator key
 * @param options - Playwright click options
 * @throws Error if healing fails
 * @example
 * await healer.click('#submit-button');
 */
async click(selector: string, options?: ClickOptions) {
    // Implementation
}
```

## 🧪 Testing Guidelines

### Unit Tests

- Write tests for all new functionality
- Use descriptive test names
- Follow the AAA pattern: Arrange, Act, Assert
- Mock external dependencies
- Aim for high code coverage (>80%)

Example:

```typescript
it('should heal broken selector using AI', async () => {
    // Arrange
    const mockPage = createMockPage();
    const healer = new AutoHealer(mockPage, 'api-key');

    // Act
    await healer.click('#broken-selector');

    // Assert
    expect(mockAI.generateContent).toHaveBeenCalled();
});
```

### Integration Tests

- Test realistic user flows
- Use actual Playwright browsers when possible
- Test cross-browser compatibility

### Healing Accuracy Benchmark

```bash
npm run test:healing-benchmark
```

`tests/benchmark/healing-accuracy.spec.ts` measures whether healing repairs a selector to the **correct** element, not merely to one that resolves. Each case renders a fixture DOM in which exactly one element is the right answer, marked `data-benchmark-target="true"`, and asserts the healed selector resolves to it.

Run it when you change anything on the healing path — the prompt (`HealingPrompt.ts`), the parser (`ResponseParser.ts`), the scorer (`SelectorScorer.ts`), the validator, or the default model. Those changes can silently degrade accuracy while every other test stays green, because the ordinary suite only checks that healing returned *something usable*.

Adding a case: append to `CASES`, mark the correct element with `data-benchmark-target="true"`, and keep the marker off the `data-test*` / `data-cy*` prefixes — otherwise `DOMSerializer` forwards it into the prompt and hands the model the answer. The first test in the file guards this.

It runs on the **nightly** CI schedule rather than on PRs: it spends live AI quota per case, and a regression reflects the model or prompt rather than any one PR's diff.

## 🔒 Security Best Practices

- Never commit API keys or secrets
- Use environment variables for sensitive data
- Validate and sanitize all inputs
- Handle errors gracefully without exposing sensitive info
- Keep dependencies up to date

## 📦 Pull Request Process

1. **Update Documentation**: Update README.md if you add features
2. **Add Tests**: Include tests for new functionality
3. **Run Validation**: Ensure `npm run validate` passes
4. **Write Clear Commits**: Use conventional commit messages
5. **Update Changelog**: Add entry to CHANGELOG.md (if exists)

### Commit Message Format

Use conventional commits:

```
feat: add support for multiple AI providers
fix: resolve race condition in healing logic
docs: update API documentation
test: add tests for LocatorManager
refactor: simplify error handling
chore: update dependencies
```

### PR Title Format

- Use clear, descriptive titles
- Reference issues: `feat: add retry logic (#123)`
- Keep it concise but informative

## 🐛 Bug Reports

When filing a bug report, include:

- **Description**: Clear description of the issue
- **Steps to Reproduce**: Minimal steps to reproduce
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Environment**: OS, Node version, browser versions
- **Logs**: Relevant error messages or logs

## 💡 Feature Requests

For feature requests, include:

- **Use Case**: Why is this feature needed?
- **Proposed Solution**: How should it work?
- **Alternatives**: Other solutions considered
- **Examples**: Code examples if applicable

## 📚 Code Review Guidelines

### For Authors

- Keep PRs focused and small
- Respond to feedback promptly
- Update your PR based on review comments
- Keep the PR up to date with main branch

### For Reviewers

- Be respectful and constructive
- Focus on code quality and maintainability
- Suggest improvements, don't demand
- Approve if code meets standards

## 🎯 Areas for Contribution

- **AI Providers**: Support for additional AI providers (Claude, Llama, etc.)
- **Healing Strategies**: Improved selector healing algorithms
- **Performance**: Optimization of DOM capture and token usage
- **Documentation**: Improve guides, examples, tutorials
- **Testing**: Expand test coverage
- **Browser Support**: Enhanced cross-browser compatibility

## 📄 License

By contributing, you agree that your contributions will be licensed under the project's license.

## 🤝 Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Give constructive feedback
- Focus on the code, not the person
- Assume good intentions

## ❓ Questions?

- Open an issue for questions
- Check existing issues and discussions
- Join our community discussions

Thank you for contributing! 🎉
