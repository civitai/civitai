/* FLOW_META
{
  "name": "e2e-cancel-refund",
  "startUrl": "http://localhost:3000/crucibles",
  "params": {
    "Crucible ID": {
      "example": "21",
      "usedIn": ["navigation", "cancel-api"]
    }
  },
  "generatedAt": "2026-01-17T19:08:27.166Z",
  "generatedFrom": "c9623225"
}
*/

/**
 * Flow: e2e-cancel-refund
 * Generated: 2026-01-17T19:08:27.166Z
 * Start URL: http://localhost:3000/crucibles
 *
 * Parameters:
 *   Crucible ID: (example: "21") - ID of crucible to cancel
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/e2e-cancel-refund/run \
 *     -d '{"profile": "member", "params": {"Crucible ID": "21"}}'
 */

// Navigate to crucible
await page.goto(`http://localhost:3000/crucibles/${params['Crucible ID']}`);
await page.waitForTimeout(1500);

// Record initial Buzz balance
const buzzText = await page.locator("button:has-text('k')").first().textContent(); console.log('Initial Buzz balance:', buzzText); return { buzzBalance: buzzText };

// Find crucible menu/settings button
const menuButtons = await page.locator("button").allTextContents(); const icons = await page.locator("[class*=icon]").count(); const moreBtn = await page.locator("button:has([class*=dots]), button:has([class*=menu]), button:has([class*=settings]), button:has([class*=ellipsis])").count(); console.log('Menu buttons found:', menuButtons.filter(t => t.includes('More') || t.includes('Setting') || t.includes('..') || t === '')); console.log('Dots/menu/settings buttons:', moreBtn); return { menuButtonCount: moreBtn };

// Search for edit or cancel links
const allLinks = await page.locator("a").evaluateAll(links => links.map(l => ({href: l.href, text: l.textContent?.trim()}))); const editLinks = allLinks.filter(l => l.href.includes('edit') || l.href.includes('delete') || l.href.includes('cancel') || l.href.includes('manage')); console.log('Edit/delete/cancel/manage links:', editLinks); const allButtons = await page.locator("button").evaluateAll(btns => btns.map(b => ({text: b.textContent?.trim(), ariaLabel: b.getAttribute('aria-label'), dataTestId: b.getAttribute('data-testid')}))); console.log('All buttons:', allButtons); return { editLinks, buttons: allButtons };

// Look for crucible info section with action icons
const crucibleSection = await page.locator("text=Cancellation Test").first().locator("../.."); const parentHtml = await crucibleSection.evaluate(el => el.outerHTML.substring(0, 3000)); console.log('Crucible section HTML:', parentHtml); return { html: parentHtml.substring(0, 1000) };

// Call cancel API via fetch (using Crucible ID parameter)
const crucibleId = parseInt(params['Crucible ID']);
const response = await page.evaluate(async (id) => {
  try {
    const res = await fetch('/api/trpc/crucible.cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: { id } })
    });
    const data = await res.json();
    return { status: res.status, data };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}, crucibleId);
console.log('Cancel result:', JSON.stringify(response));
return response;

// Check user1 Buzz balance after cancellation
await page.waitForTimeout(2000); const buzzText = await page.locator('button:has-text("k")').first().textContent(); console.log('User1 Buzz balance after cancellation:', buzzText); return { buzzBalance: buzzText };

// Get user1 exact Buzz balance via API
const response = await page.evaluate(async () => { try { const res = await fetch('/api/trpc/buzz.getUserAccount'); const data = await res.json(); return { status: res.status, data }; } catch (e) { return { error: e.message || String(e) }; } }); console.log('User Buzz Account:', JSON.stringify(response)); return response;
