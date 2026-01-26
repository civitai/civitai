/* FLOW_META
{
  "name": "e2e-user1-submit",
  "startUrl": "http://localhost:3000/crucibles",
  "params": {
    "Crucible ID": {
      "example": "20",
      "usedIn": ["navigation"]
    },
    "Entry Count": {
      "example": "2",
      "usedIn": ["submission"]
    }
  },
  "generatedAt": "2026-01-17T17:58:06.344Z",
  "generatedFrom": "c9623225"
}
*/

/**
 * Flow: e2e-user1-submit
 * Generated: 2026-01-17T17:58:06.344Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   Crucible ID: (example: "20") - ID of crucible to submit to
 *   Entry Count: (example: "2") - Number of entries to submit
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-user1-submit/run \
 *     -d '{"profile": "member", "params": {"Crucible ID": "20", "Entry Count": "2"}}'
 */

// Navigate to crucible
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}`);
await page.waitForTimeout(1500);

// Extract Buzz balance before submission
const buzzEl = await page.locator("[class*=buzz], [class*=Buzz]").first(); const text = buzzEl ? await buzzEl.textContent().catch(() => null) : null; return { buzzText: text };

// Click Submit Entry button
await page.click("button:has-text('Submit Entry')"); await page.waitForTimeout(1000);

// Select images based on Entry Count parameter
const entryCount = parseInt(params['Entry Count'] || '2');
const gridItems = await page.locator('.mantine-Modal-content .grid > div').all();
for (let i = 0; i < Math.min(entryCount, gridItems.length); i++) {
  await gridItems[i].click();
  await page.waitForTimeout(300);
}
await page.waitForTimeout(500);

// Click Submit button (text varies based on count)
await page.click(`button:has-text('Submit ${entryCount} Entr')`); await page.waitForTimeout(2000);

// Wait for submission to complete
await page.waitForTimeout(3000);

// Return final URL
return page.url();
