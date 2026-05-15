import { test, expect } from './fixtures/base.js';
import { config } from '../src/config/index.js';

/**
 * Healing Demo Tests
 *
 * These tests intentionally use broken selectors to demonstrate the self-healing
 * capability. The AutoHealer will detect the broken selector, ask the AI for a
 * fix, and retry with the corrected selector.
 */
test.describe('Self-Healing Demo', () => {
    test('should heal a broken book card selector', async ({ booksPage, autoHealer }) => {
        // Ensure autoHealer is available
        expect(autoHealer).toBeDefined();

        // Open the books home page
        await booksPage.open();

        // Intentionally use a BROKEN selector with the POM's "safeClick" function
        // This demonstrates that POM functions are now self-healing!
        await booksPage.safeClick('#nonexistent-book-card-xyz-12345', {
            timeout: config.test.timeouts.short,
        });

        // Verify the healing events were recorded
        const events = autoHealer!.getHealingEvents();
        expect(events.length).toBeGreaterThan(0);
        expect(events[0]?.success).toBe(true);
    });
});
