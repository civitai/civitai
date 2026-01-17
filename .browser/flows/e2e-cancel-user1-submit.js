/* FLOW_META
{
  "name": "e2e-cancel-user1-submit",
  "startUrl": "http://localhost:3000/crucibles",
  "params": {
    "Crucible ID": {
      "example": "21",
      "usedIn": ["navigation"]
    },
    "Entry Count": {
      "example": "2",
      "usedIn": ["submission"]
    }
  },
  "generatedAt": "2026-01-17T18:58:18.330Z",
  "generatedFrom": "c9623225"
}
*/

/**
 * Flow: e2e-cancel-user1-submit
 * Generated: 2026-01-17T18:58:18.330Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   Crucible ID: (example: "21") - ID of crucible to submit to
 *   Entry Count: (example: "2") - Number of entries to submit
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-cancel-user1-submit/run \
 *     -d '{"profile": "member", "params": {"Crucible ID": "21", "Entry Count": "2"}}'
 */

// Navigate to crucible
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}`);
await page.waitForTimeout(1500);

// Capture Buzz balance before submission
const buzzBtn = await page.locator('#mantine-ky3s7r4n6-target').textContent(); console.log('Buzz balance:', buzzBtn); return {buzzBalance: buzzBtn};

// Click Submit Entry button
await page.click("button:has-text('Submit Entry')"); await page.waitForSelector('.mantine-Modal-content', {timeout: 10000});

// Select first eligible image
const gridItems = await page.locator('.mantine-Modal-content .grid > div').all(); await gridItems[0].click(); console.log('Clicked first image');

// Select second eligible image
const gridItems = await page.locator('.mantine-Modal-content .grid > div').all(); await gridItems[1].click(); console.log('Clicked second image');

// Submit 2 entries
await page.click("button:has-text('Submit 2 Entries')"); await page.waitForTimeout(3000);
