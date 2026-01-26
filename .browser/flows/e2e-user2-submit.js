/* FLOW_META
{
  "name": "e2e-user2-submit",
  "startUrl": "http://localhost:3000/user/account",
  "params": {
    "Crucible ID": {
      "example": "20",
      "usedIn": ["navigation"]
    },
    "User ID": {
      "example": "4",
      "usedIn": ["testing-login"]
    },
    "Entry Count": {
      "example": "2",
      "usedIn": ["submission"]
    }
  },
  "generatedAt": "2026-01-17T18:15:48.541Z",
  "generatedFrom": "1ddcd282"
}
*/

/**
 * Flow: e2e-user2-submit
 * Generated: 2026-01-17T18:15:48.541Z
 * Start URL: http://localhost:3000/user/account
 *
 * Parameters:
 *   Crucible ID: (example: "20") - ID of crucible to submit to
 *   User ID: (example: "4") - Moderator user ID for testing-login (4=manuelurenah, 5=bkdiehl482, 6=koenb)
 *   Entry Count: (example: "2") - Number of entries to submit
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-user2-submit/run \
 *     -d '{"profile": "civitai-local", "params": {"Crucible ID": "20", "User ID": "4", "Entry Count": "2"}}'
 */

// Login as specified user (testing-login)
const csrf = await page.context().request.get("http://localhost:3000/api/auth/csrf");
const { csrfToken } = await csrf.json();
const userId = params['User ID'] || '4';
await page.context().request.post("http://localhost:3000/api/auth/callback/testing-login", {
  form: { csrfToken, id: userId, callbackUrl: "http://localhost:3000" }
});
await page.waitForTimeout(1000);

// Navigate to crucible
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}`, { waitUntil: "load" });
await page.waitForSelector("h1", { timeout: 15000 });
await page.waitForTimeout(1000);

// Record Buzz balance and click Submit Entry
const buzzText = await page.textContent("button:has-text('K')"); await page.click("button:has-text('Submit Entry')"); await page.waitForSelector(".mantine-Modal-content", { timeout: 10000 }); await page.waitForTimeout(1000); return { buzz: buzzText };

// Select first image
const images = await page.locator(".mantine-Modal-content img[src*='civitai']").all(); if(images.length >= 1) { await images[0].click(); } await page.waitForTimeout(500); return { count: images.length };

// Select second image
const images = await page.locator(".mantine-Modal-content img[src*='civitai']").all(); if(images.length >= 2) { await images[1].click(); } await page.waitForTimeout(500); const buttonText = await page.textContent("button:has-text('Submit')"); return { buttonText };

// Click Submit 2 Entries
await page.click("button:has-text('Submit 2 Entries')"); await page.waitForTimeout(3000); return { submitted: true };

// Wait and check submission result
await page.waitForTimeout(2000); await page.reload({ waitUntil: "load" }); await page.waitForSelector("h1"); await page.waitForTimeout(2000); const prizePool = await page.textContent("text=BUZZ") || "unknown"; const entries = await page.textContent("text=entries") || await page.textContent(".mantine-Text-root:has-text('entries')") || "unknown"; return { prizePool, entries };
