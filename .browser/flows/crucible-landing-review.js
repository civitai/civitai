/* FLOW_META
{
  "name": "crucible-landing-review",
  "startUrl": "http://localhost:3000/crucibles",
  "params": {
    "Crucible ID": {
      "example": "15",
      "usedIn": ["navigation"]
    }
  },
  "generatedAt": "2026-01-17T17:24:19.896Z",
  "generatedFrom": "dfc5d32c"
}
*/

/**
 * Flow: crucible-landing-review
 * Generated: 2026-01-17T17:24:19.896Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   Crucible ID: (example: "15") - ID of crucible to review
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/crucible-landing-review/run \
 *     -d '{"profile": "member", "params": {"Crucible ID": "15"}}'
 */

// Navigate to active crucible landing page
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}`); await page.waitForTimeout(1500);

// Scroll to stats grid and capture
const statsGrid = await page.locator(".grid.grid-cols-3").first(); await statsGrid.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);

// Scroll to leaderboard section
const leaderboard = await page.locator("text=Prize Pool & Leaderboard").first(); await leaderboard.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);

// Capture Your Entries sidebar section
const yourEntries = await page.locator("text=YOUR ENTRIES").first(); await yourEntries.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);

// Capture All Entries grid section
const allEntries = await page.locator("text=All Entries").first(); await allEntries.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);

// Scroll down to see All Entries content
await page.evaluate(() => window.scrollBy(0, 200)); await page.waitForTimeout(500);

// Check page content for rules section
return await page.evaluate(() => { const text = document.body.innerText; return { hasRules: text.includes("Rules"), hasRequirements: text.includes("Requirements") || text.includes("Entry Fee"), fullPageText: text.substring(0, 2000) }; });

// Scroll to rules and requirements section
const rules = await page.locator("text=RULES & REQUIREMENTS").first(); await rules.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
