/* FLOW_META
{
  "name": "e2e-cancel-create",
  "startUrl": "http://localhost:3000/crucibles/create",
  "fixturesDir": ".browser/fixtures",
  "params": {
    "Crucible Name": {
      "example": "Cancellation Test",
      "usedIn": ["fill-form"]
    },
    "Description": {
      "example": "This crucible will be cancelled to test refund functionality",
      "usedIn": ["fill-form"]
    },
    "Entry Fee": {
      "example": "50",
      "usedIn": ["entry-rules"]
    },
    "Entry Limit": {
      "example": "2",
      "usedIn": ["entry-rules"]
    }
  },
  "generatedAt": "2026-01-17T18:52:39.806Z",
  "generatedFrom": "c9623225"
}
*/

/**
 * Flow: e2e-cancel-create
 * Generated: 2026-01-17T18:52:39.806Z
 * Start URL: http://localhost:3000/crucibles/create
 *
 * Parameters:
 *   Crucible Name: (example: "Cancellation Test")
 *   Description: (example: "This crucible will be cancelled to test refund functionality")
 *   Entry Fee: (example: "50") - Buzz per entry
 *   Entry Limit: (example: "2") - options: 1, 2, 3, 5, 10
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-cancel-create/run \
 *     -d '{"profile": "member", "params": {"Crucible Name": "Cancel Test", "Description": "Test", "Entry Fee": "50", "Entry Limit": "2"}}'
 */

// Upload cover image
const coverImage = ctx.fixturesDir + '/cover-16x9.png';
await page.locator('input[type="file"]').setInputFiles(coverImage);
await page.waitForTimeout(2000);

// Fill form fields
await page.getByLabel('Crucible Name').fill(params['Crucible Name']);
await page.getByLabel('Description').fill(params['Description'] || '');

// Click Next to go to Entry Rules
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(500);

// Set Entry Fee
await page.getByLabel("Entry Fee per User").fill(params['Entry Fee'] || "50"); await page.waitForTimeout(200);

// Set Entry Limit
await page.getByLabel("Entry Limit per User").selectOption(params['Entry Limit'] || "2"); await page.waitForTimeout(200);

// Click Next to go to Prizes step
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(500);

// Click Next to go to Review step
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(500);

// Create Crucible
await page.click("button:has-text(\"Create Crucible - Free\")"); await page.waitForTimeout(3000);

// Capture created crucible page
const url = page.url(); return url;
