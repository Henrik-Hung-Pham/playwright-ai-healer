/**
 * Parses and cleans the raw AI response text.
 *
 * Handles common formatting artifacts that AI models add to their responses:
 * - Markdown code fences (``` ... ```)
 * - Inline backtick wrapping (`selector`)
 * - Surrounding single or double quotes
 * - Chain-of-thought commentary that wraps the actual selector in prose
 *
 * @param raw - Raw string returned by the AI provider, or undefined
 * @returns Cleaned CSS selector string, or null if the response is empty or "FAIL"
 */
export function parseAIResponse(raw: string | undefined): string | null {
    if (!raw) return null;

    const text = raw.trim();
    if (!text) return null;
    if (text === 'FAIL') return null;

    // Fenced blocks are lifted out first. Their backticks would otherwise skew
    // the inline-span pairing below — a fence contributes three consecutive
    // backticks, which offsets every subsequent pair so that a "span" can match
    // the *prose between* two real code spans. That produced selectors such as
    // "*   Check uniqueness: Only one element has" and crashed page.locator().
    const fencedBodies: string[] = [];
    const prose = text.replace(/```[a-zA-Z]*\r?\n?([\s\S]*?)```/g, (_match, body: string) => {
        fencedBodies.push(body);
        return '\n';
    });

    // Inline code spans, in document order. Constrained to a single line so an
    // unbalanced stray backtick cannot swallow a paragraph.
    const inlineSpans = Array.from(prose.matchAll(/`([^`\n]+)`/g), match => (match[1] ?? '').trim()).filter(Boolean);

    // Candidate pools, in decreasing order of trust. Models that reason before
    // answering still tend to put the real selector in a code span, and to put
    // the final answer last — so each pool is scanned from the end.
    const fencedLines = fencedBodies.flatMap(splitLines);
    const proseLines = splitLines(prose);

    const chosen =
        lastSelectorLike(inlineSpans) ??
        lastSelectorLike(fencedLines) ??
        lastSelectorLike(proseLines) ??
        // Nothing looked like a selector. Return the last non-empty line rather
        // than null so no data is silently dropped; validation rejects it.
        proseLines[proseLines.length - 1] ??
        fencedLines[fencedLines.length - 1];

    if (chosen === undefined) return null;

    const result = stripSurroundingQuotes(chosen.trim()).trim();

    // The model signals "no match" as FAIL — catch it even after cleanup.
    if (result === 'FAIL') return null;

    return result || null;
}

/**
 * Extract every plausible selector from a reply, best-guess first.
 *
 * A single reply is a single hypothesis. Asking the model for several and
 * ranking them against the live DOM turns the model into a *candidate
 * generator* rather than an oracle — when its first choice is a decoy, a later
 * one is often correct, and the framework can now tell them apart on evidence
 * rather than accepting the first thing that parses.
 *
 * Ordering follows the model's own: code spans and fenced lines are read in
 * document order, and the model is asked to list its best guess first. Duplicates
 * are collapsed, keeping the earliest occurrence.
 *
 * @param raw - Raw provider output.
 * @param limit - Maximum candidates to return.
 * @returns Ordered, de-duplicated candidates. Empty when the reply is a refusal.
 */
export function parseAICandidates(raw: string | undefined, limit = 5): string[] {
    if (!raw) return [];
    const text = raw.trim();
    if (!text || text === 'FAIL') return [];

    const fencedBodies: string[] = [];
    const prose = text.replace(/```[a-zA-Z]*\r?\n?([\s\S]*?)```/g, (_match, body: string) => {
        fencedBodies.push(body);
        return '\n';
    });

    const inlineSpans = Array.from(prose.matchAll(/`([^`\n]+)`/g), match => (match[1] ?? '').trim()).filter(Boolean);

    const ordered = [...inlineSpans, ...fencedBodies.flatMap(splitLines), ...splitLines(prose)];

    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const entry of ordered) {
        // Quotes are stripped *before* the shape test: `isSelectorLike` requires
        // the line to start with a selector token, so a quoted answer like
        // `"#submit"` would otherwise be discarded as prose.
        const cleaned = stripSurroundingQuotes(entry.trim()).trim();
        if (!isSelectorLike(cleaned)) continue;
        if (!cleaned || cleaned === 'FAIL' || seen.has(cleaned)) continue;
        seen.add(cleaned);
        candidates.push(cleaned);
        if (candidates.length >= limit) break;
    }

    // Fall back to the single-answer parser so a reply that yields no
    // selector-like line still produces something for validation to reject,
    // matching the existing contract rather than silently returning nothing.
    if (candidates.length === 0) {
        const single = parseAIResponse(raw);
        return single ? [single] : [];
    }

    return candidates;
}

/** Split into trimmed, non-empty lines. */
function splitLines(text: string): string[] {
    return text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

/** The last entry that reads like a selector, or `undefined` if none do. */
function lastSelectorLike(candidates: string[]): string | undefined {
    for (let i = candidates.length - 1; i >= 0; i--) {
        const candidate = candidates[i];
        if (candidate !== undefined && isSelectorLike(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Heuristic: does a single line read like a CSS/Playwright selector rather than
 * chain-of-thought prose? Rejects markdown bullets/headings/numbered items,
 * sentence-like lines (those ending in `.` or `:`), HTML fragments, and bare
 * `attr="value"` pairs that models quote when *describing* an element; accepts
 * lines that start with a selector token and either carry selector syntax or
 * are a bare tag name.
 */
function isSelectorLike(line: string): boolean {
    if (!line || line.length > 200) return false;
    // Markdown list/heading scaffolding the model uses to structure its reasoning.
    if (/^(?:[-*+]\s|#{1,6}\s|\d+[.)]\s)/.test(line)) return false;
    // Sentence/label endings — prose, not a selector.
    if (/[.:]$/.test(line)) return false;
    // An HTML fragment quoted from the page, e.g. `<input id="quantity">`.
    if (/^</.test(line)) return false;
    // A bare attribute pair, e.g. `id="quantity"` — models cite these when
    // explaining *why* a selector is unique. It is not itself a valid selector,
    // and page.locator() throws on it.
    if (/^[a-zA-Z-]+=(["']).*\1$/.test(line)) return false;
    if (!/^[#.[*:a-zA-Z]/.test(line)) return false;
    const hasSelectorSyntax = /[#.[\]>~=]|>>|\bnth=|\btext=|\bhas=|:has\(|:nth|::/.test(line);
    const isBareTag = /^[a-zA-Z][\w-]*$/.test(line);
    return hasSelectorSyntax || isBareTag;
}

/** Remove a single matched layer of surrounding single or double quotes. */
function stripSurroundingQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.substring(1, value.length - 1);
    }
    return value;
}
