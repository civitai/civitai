/* FLOW_META
{
  "name": "e2e-create-crucible",
  "startUrl": "http://localhost:3000/crucibles/create",
  "fixturesDir": ".browser/fixtures",
  "params": {
    "Crucible Name": {
      "example": "E2E Test Crucible",
      "usedIn": ["fill-form"]
    },
    "Description": {
      "example": "End-to-end test crucible for automated testing",
      "usedIn": ["fill-form"]
    },
    "Entry Limit": {
      "example": "2",
      "usedIn": ["entry-rules"]
    },
    "Entry Fee": {
      "example": "100",
      "usedIn": ["entry-rules"]
    }
  },
  "generatedAt": "2026-01-17T17:53:28.250Z",
  "generatedFrom": "c9623225"
}
*/

/**
 * Flow: e2e-create-crucible
 * Generated: 2026-01-17T17:53:28.250Z
 * Start URL: http://localhost:3000/crucibles/create
 *
 * Parameters:
 *   Crucible Name: (example: "E2E Test Crucible")
 *   Description: (example: "End-to-end test crucible for automated testing")
 *   Entry Limit: (example: "2") - options: 1, 2, 3, 5, 10
 *   Entry Fee: (example: "100") - Buzz per entry
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-create-crucible/run \
 *     -d '{"profile": "member", "params": {"Crucible Name": "My Crucible", "Description": "Test", "Entry Limit": "2", "Entry Fee": "100"}}'
 */

// Upload cover image
const coverImage = ctx.fixturesDir + '/cover-16x9.png';
await page.locator('input[type="file"]').setInputFiles(coverImage);
await page.waitForTimeout(2000);

// Scroll to form inputs
await page.evaluate(() => window.scrollBy(0, 200));

// Fill crucible name and description
await page.getByLabel('Crucible Name').fill(params['Crucible Name']);
await page.getByLabel("Description").fill(params['Description'] || '');

// Click Next to go to Entry Rules
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(500);

// Scroll up to see all Entry Rules fields
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);

// Set entry fee
if (params['Entry Fee']) {
  await page.getByLabel("Entry Fee per User").fill(params['Entry Fee']);
}

// Set entry limit
await page.getByLabel("Entry Limit per User").selectOption(params['Entry Limit'] || "2");

// Click Next to go to Prizes
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(500);

// Click Next to go to Review
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(500);

// Click Create Crucible button
await page.getByRole("button", {name: /Create Crucible/}).click(); await page.waitForTimeout(3000);

// Get current URL
return page.url();
