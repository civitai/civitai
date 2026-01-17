/* FLOW_META
{
  "name": "e2e-user1-judge",
  "startUrl": "http://localhost:3000/crucibles",
  "params": {
    "Crucible ID": {
      "example": "20",
      "usedIn": ["navigation"]
    }
  },
  "generatedAt": "2026-01-17T18:31:34.286Z",
  "generatedFrom": "c9623225"
}
*/

/**
 * Flow: e2e-user1-judge
 * Generated: 2026-01-17T18:31:34.286Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   Crucible ID: (example: "20") - ID of crucible to judge
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-user1-judge/run \
 *     -d '{"profile": "member", "params": {"Crucible ID": "20"}}'
 */

// Navigate to judge page
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}/judge`);
await page.waitForTimeout(1500);

// Wait for pair images to load
await page.waitForSelector("img[alt*=\"Entry\"]" , { timeout: 10000 }).catch(() => null); await page.waitForTimeout(500);

// Scroll to see full pair
await page.evaluate(() => window.scrollTo(0, 200)); await page.waitForTimeout(1000);

// Reload page
await page.reload(); await page.waitForTimeout(3000);

// Wait for both images and capture
await page.waitForTimeout(2000); await page.evaluate(() => window.scrollTo(0, 400));

// Capture initial judging state - full view
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);

// Vote 1 - use keyboard shortcut 1
await page.keyboard.press("1"); await page.waitForTimeout(2000);

// Vote 2 - use keyboard shortcut 2
await page.waitForTimeout(1000); await page.keyboard.press("2"); await page.waitForTimeout(2000);

// Vote 3 - click Vote1 button
await page.waitForTimeout(1000); await page.locator("button:has-text(\"Vote\"):visible").first().click(); await page.waitForTimeout(2000);

// Scroll up to see final stats
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);
