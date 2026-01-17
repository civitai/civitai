/* FLOW_META
{
  "name": "crucible-submission-review",
  "startUrl": "http://localhost:3000/crucibles/15",
  "generatedAt": "2026-01-17T17:28:54.318Z",
  "generatedFrom": "5e5240b2"
}
*/

/**
 * Flow: crucible-submission-review
 * Generated: 2026-01-17T17:28:54.318Z
 * Start URL: http://localhost:3000/crucibles/15
 *
 * Parameters:
 *   (none)
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/crucible-submission-review/run \
 *     -d '{"profile": "...", "params": {...}}'
 */

// Click Submit Entry button
await page.click("button:has-text('Submit Entry')"); await page.waitForTimeout(1000);

// Scroll image grid to see valid/invalid indicators
const modalContent = await page.locator('.mantine-Modal-content').first(); if (modalContent) { await modalContent.evaluate(el => el.scrollTop = 200); } await page.waitForTimeout(500);

// Click first image to select it
const images = await page.locator('.mantine-Modal-content img').all(); if (images.length > 0) { await images[0].click(); } await page.waitForTimeout(500);

// Click image with green checkmark that can be selected
const scrollArea = await page.locator('.mantine-ScrollArea-viewport').first(); if (scrollArea) { await scrollArea.evaluate(el => el.scrollTop = 300); } await page.waitForTimeout(500);

// Select last image in first row
await page.locator('.mantine-Modal-content img').nth(4).click(); await page.waitForTimeout(500);

// Select image in second row with green check
await page.locator('.mantine-Modal-content img').nth(7).click(); await page.waitForTimeout(500);

// Scroll modal to top to see requirements badges
const scrollArea2 = await page.locator('.mantine-ScrollArea-viewport').first(); if (scrollArea2) { await scrollArea2.evaluate(el => el.scrollTop = 0); } await page.waitForTimeout(500);

// Capture submit button with Buzz cost
const submitBtn = await page.locator('button:has-text("Submit 1 Entry")'); await submitBtn.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);

// Close modal by pressing Escape
await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
