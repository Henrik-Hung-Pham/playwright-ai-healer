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

    let result = raw.trim();
    if (!result) return null;

    // Extract the last backtick-quoted span (e.g. `#selector` or `css selector`).
    // Models that add commentary usually still wrap the real selector in
    // backticks, so preferring that span discards the surrounding prose.
    const backtickMatch = result.match(/`([^`]+)`/g);
    const lastMatch = backtickMatch ? backtickMatch[backtickMatch.length - 1] : undefined;
    if (lastMatch) {
        result = lastMatch.replace(/`/g, '').trim();
    } else {
        // Strip triple-backtick code fences if present
        result = result.replace(/```/g, '').trim();
    }

    // A verbose reply can still be multi-line at this point (a fenced block with
    // several lines, or an un-delimited essay). Reduce it to the single line most
    // likely to be the selector so downstream validation sees a clean candidate.
    result = reduceToSelectorLine(result);

    // Remove surrounding quotes that some models add around the selector
    result = stripSurroundingQuotes(result).trim();

    // The model signals "no match" as FAIL — catch it even after cleanup.
    if (result === 'FAIL') return null;

    return result || null;
}

/**
 * Reduce a multi-line reply to the one line that most plausibly holds a selector.
 *
 * Single-line input is returned untouched. For multi-line input the last
 * selector-like line wins (models tend to reason first and answer last); if no
 * line looks like a selector the last non-empty line is returned so no data is
 * silently dropped — downstream validation will reject it if it is not usable.
 */
function reduceToSelectorLine(text: string): string {
    if (!text.includes('\n')) return text.trim();

    const lines = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    if (lines.length <= 1) return lines[0] ?? text.trim();

    const selectorLike = lines.filter(isSelectorLike);
    const chosen = selectorLike.length > 0 ? selectorLike[selectorLike.length - 1] : lines[lines.length - 1];
    return (chosen ?? text).trim();
}

/**
 * Heuristic: does a single line read like a CSS/Playwright selector rather than
 * chain-of-thought prose? Rejects markdown bullets/headings/numbered items and
 * sentence-like lines (those ending in `.` or `:`); accepts lines that start
 * with a selector token and either carry selector syntax or are a bare tag name.
 */
function isSelectorLike(line: string): boolean {
    if (!line || line.length > 200) return false;
    // Markdown list/heading scaffolding the model uses to structure its reasoning.
    if (/^(?:[-*+]\s|#{1,6}\s|\d+[.)]\s)/.test(line)) return false;
    // Sentence/label endings — prose, not a selector.
    if (/[.:]$/.test(line)) return false;
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
