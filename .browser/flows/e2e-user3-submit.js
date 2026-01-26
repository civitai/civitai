/* FLOW_META
{
  "name": "e2e-user3-submit",
  "startUrl": "http://localhost:3000/",
  "params": {
    "Crucible ID": {
      "example": "20",
      "usedIn": ["navigation"]
    },
    "User ID": {
      "example": "5",
      "usedIn": ["testing-login"]
    },
    "Entry Count": {
      "example": "2",
      "usedIn": ["submission"]
    }
  },
  "generatedAt": "2026-01-17T18:21:52.069Z",
  "generatedFrom": "97932efe"
}
*/

/**
 * Flow: e2e-user3-submit
 * Generated: 2026-01-17T18:21:52.069Z
 * Start URL: http://localhost:3000/
 *
 * Parameters:
 *   Crucible ID: (example: "20") - ID of crucible to submit to
 *   User ID: (example: "5") - Moderator user ID for testing-login (4=manuelurenah, 5=bkdiehl482, 6=koenb)
 *   Entry Count: (example: "2") - Number of entries to submit
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-user3-submit/run \
 *     -d '{"profile": "creator", "params": {"Crucible ID": "20", "User ID": "5", "Entry Count": "2"}}'
 */

// Login as specified user (testing-login)
const csrf = await page.context().request.get("http://localhost:3000/api/auth/csrf").then(r => r.json());
const userId = params['User ID'] || '5';
await page.context().request.post("http://localhost:3000/api/auth/callback/testing-login", {
  form: { csrfToken: csrf.csrfToken, id: userId, callbackUrl: "http://localhost:3000" }
});
await page.waitForTimeout(1000);

// Navigate to crucible
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}`);
await page.waitForTimeout(1500);

// Check login status and get Buzz balance
await page.waitForTimeout(2000); const buzzBtn = page.locator("button:has-text(\"k\")").first(); const buzzText = await buzzBtn.textContent(); return { buzz: buzzText, url: page.url() };

// Get current crucible state before submission
const prizePool = await page.locator("text=/BUZZ/i").first().textContent().catch(() => null); const entries = await page.locator("text=/entries/i").first().textContent().catch(() => null); return { prizePool, entries };

// Click Submit Entry button to open modal
await page.click("button:has-text(\"Submit Entry\")"); await page.waitForSelector(".mantine-Modal-content", { timeout: 10000 });

// Scroll modal to see selectable images
const modal = page.locator(".mantine-Modal-content"); await modal.evaluate(el => el.scrollTop = el.scrollHeight); await page.waitForTimeout(500);

// Select first image for entry
const images = page.locator(".mantine-Modal-content img"); await images.nth(0).click(); await page.waitForTimeout(300);

// Find and click selectable image container
const containers = await page.locator(".mantine-Modal-content [class*=imageSelect], .mantine-Modal-content [class*=ImageSelect], .mantine-Modal-content [data-selectable]").all(); console.log("Found containers:", containers.length); if (containers.length > 0) { await containers[0].click(); } return { found: containers.length };

// Inspect modal DOM structure for image selection
const modal = page.locator(".mantine-Modal-content"); const html = await modal.evaluate(el => el.innerHTML.substring(0, 5000)); return html;

// Find image grid elements and their classes
const gridItems = await page.locator(".mantine-Modal-content .grid > div").all(); const info = []; for (let i = 0; i < Math.min(gridItems.length, 3); i++) { const classes = await gridItems[i].getAttribute("class"); const html = await gridItems[i].innerHTML(); info.push({ idx: i, classes, htmlStart: html.substring(0, 200) }); } return { totalItems: gridItems.length, items: info };

// Find eligible (non-red-border) images
const gridItems = await page.locator(".mantine-Modal-content .grid > div").all(); const eligible = []; for (let i = 0; i < gridItems.length; i++) { const classes = await gridItems[i].getAttribute("class") || ""; if (!classes.includes("border-red") && !classes.includes("cursor-not-allowed")) { eligible.push({ idx: i, classes }); } } return { total: gridItems.length, eligible };

// Click first eligible image (index 8)
const gridItems = page.locator(".mantine-Modal-content .grid > div"); await gridItems.nth(8).scrollIntoViewIfNeeded(); await gridItems.nth(8).click(); await page.waitForTimeout(500);

// Click second eligible image (index 19)
const gridItems = page.locator(".mantine-Modal-content .grid > div"); await gridItems.nth(19).scrollIntoViewIfNeeded(); await gridItems.nth(19).click(); await page.waitForTimeout(500);

// Click Submit 2 Entries button
await page.click("button:has-text(\"Submit 2 Entries\")"); await page.waitForTimeout(3000);

// Verify final crucible state after user3 submission
await page.reload(); await page.waitForTimeout(2000); const prizePool = await page.locator("text=/BUZZ/i").first().textContent().catch(() => null); const entries = await page.locator("text=/entries/i").first().textContent().catch(() => null); const yourEntries = await page.locator("text=/of 2 used/i").first().textContent().catch(() => null); return { prizePool, entries, yourEntries };
