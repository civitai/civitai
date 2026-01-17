/* FLOW_META
{
  "name": "crucible-rating-review",
  "startUrl": "http://localhost:3000/crucibles",
  "generatedAt": "2026-01-17T17:34:58.060Z",
  "generatedFrom": "5a396e01"
}
*/

/**
 * Flow: crucible-rating-review
 * Generated: 2026-01-17T17:34:58.060Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   (none)
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/crucible-rating-review/run \
 *     -d '{"profile": "...", "params": {...}}'
 */

// Scroll to suggested crucibles section
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(500);

// Navigate to another crucible judge page
await page.goto("http://localhost:3000/crucibles/10/judge"); await page.waitForTimeout(1000);

// Navigate to crucible 19 judge page
await page.goto("http://localhost:3000/crucibles/19/judge"); await page.waitForTimeout(1000);

// Navigate to crucible 14 judge page
await page.goto("http://localhost:3000/crucibles/14/judge"); await page.waitForTimeout(1500);

// Navigate back to crucible 15 judge page
await page.goto("http://localhost:3000/crucibles/15/judge"); await page.waitForTimeout(1000);

// Scroll to see suggested crucibles cards
await page.evaluate(() => window.scrollBy(0, 300)); await page.waitForTimeout(500);

// Resize viewport and capture full page
await page.setViewportSize({ width: 1280, height: 1200 }); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);

// Scroll to top and capture stats bar
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);

// Navigate to E2E Rating Test crucible judge page
await page.goto("http://localhost:3000/crucibles/19/judge"); await page.waitForTimeout(1500);
