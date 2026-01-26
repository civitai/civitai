/* FLOW_META
{
  "name": "e2e-user2-judge",
  "startUrl": "http://localhost:3000/crucibles",
  "params": {
    "Crucible ID": {
      "example": "20",
      "usedIn": ["navigation"]
    }
  },
  "generatedAt": "2026-01-17T18:39:56.545Z",
  "generatedFrom": "1ddcd282"
}
*/

/**
 * Flow: e2e-user2-judge
 * Generated: 2026-01-17T18:39:56.545Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   Crucible ID: (example: "20") - ID of crucible to judge
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-user2-judge/run \
 *     -d '{"profile": "civitai-local", "params": {"Crucible ID": "20"}}'
 */

// Navigate to judge page
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}/judge`);
await page.waitForTimeout(1500);

// Wait for pairs to load and capture initial state
await page.waitForSelector("img", { timeout: 5000 }); await page.waitForTimeout(1000);

// Vote 1 - Press keyboard 1 for left image
await page.keyboard.press("1"); await page.waitForTimeout(2000);

// Vote 2 - Press keyboard 2 for right image
await page.waitForTimeout(1000); await page.keyboard.press("2"); await page.waitForTimeout(2000);

// Vote 3 - Click Vote1 button for left image
await page.waitForTimeout(1000); await page.locator("button:has-text(\"Vote1\"):visible").first().click(); await page.waitForTimeout(2000);

// Scroll up to see stats after vote 3
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);

// Vote 4 - Press keyboard 2 for right image
await page.keyboard.press("2"); await page.waitForTimeout(2000);

// Vote 5 - Press keyboard 1 for left image
await page.keyboard.press("1"); await page.waitForTimeout(2000);

// Vote 6 - Press keyboard 2 for right image
await page.keyboard.press("2"); await page.waitForTimeout(2000);

// Capture final stats - scroll to top
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);
