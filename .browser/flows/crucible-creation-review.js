/* FLOW_META
{
  "name": "crucible-creation-review",
  "startUrl": "http://localhost:3000/crucibles/create",
  "params": {
    "Crucible Name": {
      "example": "Test Crucible for Review",
      "usedIn": [
        "fill-form-1-fields"
      ]
    }
  },
  "fixturesDir": ".browser/fixtures",
  "generatedAt": "2026-01-17T17:41:09.501Z",
  "generatedFrom": "4e8906f3"
}
*/

/**
 * Flow: crucible-creation-review
 * Generated: 2026-01-17T17:41:09.501Z
 * Start URL: http://localhost:3000/crucibles/create
 *
 * Parameters:
 *   Crucible Name: (example: "Test Crucible for Review")
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/crucible-creation-review/run \
 *     -d '{"profile": "...", "params": {...}}'
 */

// Scroll to see duration options
await page.evaluate(() => window.scrollBy(0, 400)); await page.waitForTimeout(500);

// Scroll to duration section
const durationLabel = await page.locator("text=Duration").first(); if (await durationLabel.count() > 0) { await durationLabel.scrollIntoViewIfNeeded(); } else { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } await page.waitForTimeout(500);

// fill-form-1-fields
await page.getByLabel('Crucible Name').fill(params['Crucible Name']);

// Upload cover image fixture (ctx.fixturesDir injected by flow runner)
const coverImage = ctx.fixturesDir + '/cover-16x9.png';
await page.locator('input[type="file"]').setInputFiles(coverImage);

// Wait for image upload and scroll up
await page.waitForTimeout(2000); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);

// Click Next to go to Step 2 Entry Rules
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(1000);

// Scroll to top of Step 2 Entry Rules
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);

// Scroll up to show Entry Fee and Step tabs
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500); await page.setViewportSize({ width: 1280, height: 1200 }); await page.waitForTimeout(500);

// Click Next to go to Step 3 Prizes
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(1000);

// Click Next to go to Step 4 Review
await page.click("button:has-text(\"Next\")"); await page.waitForTimeout(1000);

// Scroll to capture Prize Distribution and cost summary
await page.evaluate(() => window.scrollBy(0, 300)); await page.waitForTimeout(500);

// Scroll to see full Prize Distribution
const prizeSection = await page.locator("text=Prize Distribution").first(); if (await prizeSection.count() > 0) { await prizeSection.scrollIntoViewIfNeeded(); } await page.waitForTimeout(500);

// Scroll down to show full Prize Distribution content
await page.evaluate(() => window.scrollBy(0, 200)); await page.waitForTimeout(500);
