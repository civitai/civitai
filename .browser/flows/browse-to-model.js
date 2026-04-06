/**
 * Flow: browse-to-model
 * Generated: 2026-01-16T06:05:59.839Z
 * Start URL: https://civitai.com
 */

// --- Click models link ---
await page.click('a[href="/models"]'); await page.waitForSelector('a[href^="/models/"]');

// --- Click first model ---
await page.click('a[href^="/models/"]'); await page.waitForSelector('h1');
