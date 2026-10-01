import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

/**
 * Structural guard for the production locator store.
 *
 * `src/config/locators.json` is written at runtime by `LocatorManager` whenever a
 * heal succeeds, which makes it the one source file the test suite itself can
 * mutate. That has already gone wrong twice: a stray `test.concurrentString`
 * entry from a concurrency test was committed, removed in `5941ef3`
 * ("remove leftover test data from production locators.json"), and then
 * reappeared. Both times it was caught by eye during review rather than by CI.
 *
 * These assertions are the missing gate. They are deliberately cheap and run in
 * the normal unit suite so a polluted store fails `npm run validate` before it
 * can reach a pull request.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATORS_PATH = path.resolve(__dirname, 'locators.json');

/**
 * A locator store is a tree of page namespaces whose leaves are selector strings.
 *
 * `z.lazy` is required because the shape is recursive: a namespace may nest
 * further namespaces (`checkout.paymentForm.submit`) to any depth.
 */
type LocatorNode = string | { [key: string]: LocatorNode };

const locatorNodeSchema: z.ZodType<LocatorNode> = z.lazy(() =>
    z.union([z.string().min(1, 'selector must not be empty'), z.record(z.string(), locatorNodeSchema)])
);

const locatorStoreSchema = z.record(z.string(), locatorNodeSchema);

/**
 * Namespaces that indicate a test wrote into the production store.
 *
 * Tests must point `FileAdapter` at a temp path (as
 * `LocatorManager.integration.test.ts` does); anything landing here under one of
 * these names escaped that convention.
 */
const RESERVED_NAMESPACES = ['test', 'tests', 'spec', 'tmp', 'temp', 'fixture', 'mock', 'dummy'];

/**
 * Selector values that are obviously scaffolding rather than real selectors.
 *
 * `value-0` is the exact literal that leaked twice, so it is matched explicitly
 * alongside the generic placeholder names.
 */
const PLACEHOLDER_VALUE = /^(value-\d+|foo|bar|baz|qux|test|dummy|placeholder|todo|xxx+)$/i;

/** Flatten the store to `dot.path` → selector pairs for leaf-level assertions. */
function flatten(node: LocatorNode, prefix = ''): Array<[string, string]> {
    if (typeof node === 'string') return [[prefix, node]];
    return Object.entries(node).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
}

describe('locators.json production store', () => {
    const raw = fs.readFileSync(LOCATORS_PATH, 'utf-8');

    it('is valid JSON', () => {
        expect(() => JSON.parse(raw)).not.toThrow();
    });

    const parsed = JSON.parse(raw) as unknown;

    it('matches the locator-store shape (nested namespaces, non-empty string leaves)', () => {
        const result = locatorStoreSchema.safeParse(parsed);
        expect(
            result.success,
            `locators.json does not match the expected shape: ${JSON.stringify(result.error?.issues, null, 2)}`
        ).toBe(true);
    });

    it('contains no test-only namespaces', () => {
        const topLevelKeys = Object.keys(parsed as Record<string, unknown>);
        const offenders = topLevelKeys.filter(key => RESERVED_NAMESPACES.includes(key.toLowerCase()));

        expect(
            offenders,
            `Test data leaked into the production locator store under: ${offenders.join(', ')}. ` +
                `Tests must construct FileAdapter with an explicit temp path — see ` +
                `LocatorManager.integration.test.ts — rather than writing to src/config/locators.json.`
        ).toEqual([]);
    });

    it('contains no placeholder selector values', () => {
        const offenders = flatten(parsed as LocatorNode)
            .filter(([, selector]) => PLACEHOLDER_VALUE.test(selector.trim()))
            .map(([key, selector]) => `${key} = "${selector}"`);

        expect(
            offenders,
            `Placeholder values are not real selectors and will never match anything: ${offenders.join(', ')}`
        ).toEqual([]);
    });

    it('has no leading/trailing whitespace in any selector', () => {
        const offenders = flatten(parsed as LocatorNode)
            .filter(([, selector]) => selector !== selector.trim())
            .map(([key]) => key);

        expect(offenders, `Selectors with stray whitespace: ${offenders.join(', ')}`).toEqual([]);
    });
});
