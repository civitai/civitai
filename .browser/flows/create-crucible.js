/* FLOW_META
{
  "name": "create-crucible",
  "startUrl": "http://localhost:3000/crucibles/create",
  "params": {
    "Crucible Name": { "example": "My Crucible", "required": true },
    "Description": { "example": "A test crucible", "required": true },
    "Entry Fee per User": { "example": "10", "required": false },
    "Entry Limit per User": { "example": "10", "required": false }
  },
  "fixturesDir": ".browser/fixtures",
  "generatedAt": "2026-01-16T20:11:31.078Z"
}
*/

/**
 * Flow: create-crucible
 * Creates a new crucible with the given parameters.
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/create-crucible/run \
 *     -d '{"profile": "civitai-local", "params": {"Crucible Name": "...", "Description": "..."}}'
 */

// Step 1: Upload cover image (required)
// ctx.fixturesDir is injected by the flow runner
const coverImage = ctx.fixturesDir + '/cover-16x9.png';
await page.locator('input[type="file"]').setInputFiles(coverImage);

// Fill basic info
await page.getByLabel('Crucible Name').fill(params['Crucible Name']);
await page.getByLabel('Description').fill(params['Description']);

// Wait for file upload to complete
await page.waitForTimeout(2000);

// Go to Step 2: Entry Rules
await page.click("button:has-text('Next')");
await page.waitForTimeout(500);

// Fill entry rules (use defaults if not provided)
if (params['Entry Fee per User']) {
  await page.getByLabel('Entry Fee per User').fill(params['Entry Fee per User']);
}
if (params['Entry Limit per User']) {
  await page.selectOption('[name*="entry"]', params['Entry Limit per User']);
}

// Go to Step 3: Prizes (use defaults)
await page.click("button:has-text('Next')");
await page.waitForTimeout(500);

// Go to Step 4: Review
await page.click("button:has-text('Next')");
await page.waitForTimeout(500);

// Create the crucible
await page.click("button:has-text('Create Crucible')");
await page.waitForURL(/\/crucibles\/\d+/, { timeout: 30000 });
