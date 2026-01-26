/* FLOW_META
{
  "name": "crucible-discovery-review",
  "startUrl": "http://localhost:3000/crucibles",
  "generatedAt": "2026-01-17T17:17:39.123Z",
  "generatedFrom": "3afdd554"
}
*/

/**
 * Flow: crucible-discovery-review
 * Generated: 2026-01-17T17:17:39.123Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   (none)
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/crucible-discovery-review/run \
 *     -d '{"profile": "...", "params": {...}}'
 */

// Scroll to filter tabs section
const tabs = await page.locator("button:has-text(\"Featured\")").first(); if (tabs) await tabs.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);

// Click Ending Soon tab
await page.click("button:has-text(\"Ending Soon\")"); await page.waitForTimeout(500);

// Click High Stakes tab
await page.click("button:has-text(\"High Stakes\")"); await page.waitForTimeout(500);

// Click New tab
await page.click("button:has-text(\"New\")"); await page.waitForTimeout(500);

// Open sort dropdown by text Newest
await page.click("text=Newest"); await page.waitForTimeout(300);

// Close sort dropdown by pressing Escape
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
