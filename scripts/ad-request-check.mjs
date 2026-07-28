/**
 * Verifies that gated pages make no ad requests.
 *
 * A gated page that runs an auction sends its URL to GAM, which lands NSFW URLs in the
 * policy violation center even though the gate hides the content. See docs/ads-gating-plan.md.
 *
 * Usage:
 *   node scripts/ad-request-check.mjs [origin]
 *
 * Defaults to https://civitai.com. Ads are disabled when `isDev` is true, so this cannot be
 * run against a local dev server — point it at a preview or production deploy.
 */
import { chromium } from 'playwright';

const origin = process.argv[2] ?? 'https://civitai.com';

const targets = [
  { label: 'GATED', path: '/models/1972981/sex-nudes-other-fun-stuff-snofs', expectAds: false },
  { label: 'CONTROL', path: '/models/1166008', expectAds: true },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const browser = await chromium.launch({ headless: true });
let failed = false;

for (const { label, path, expectAds } of targets) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const adRequests = [];
  const auctionCalls = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/gampad\/ads|\/pagead\/ads/.test(u)) adRequests.push(u);
    else if (/prebid|adnxs|rubiconproject|pubmatic|casalemedia|openx|criteo/i.test(u))
      auctionCalls.push(u);
  });

  const url = `${origin}${path}`;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    console.log(`  goto warning: ${e.message.slice(0, 80)}`);
  }
  // Auctions need the CMP round-trip plus the adSizes effect, and side rails need a scroll.
  await page.waitForTimeout(14000);
  await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
  await page.waitForTimeout(6000);

  const slots = await page.evaluate(() => {
    try {
      return window.googletag?.pubads?.().getSlots?.().map((s) => s.getAdUnitPath()) ?? [];
    } catch {
      return [];
    }
  });

  const ok = expectAds
    ? adRequests.length > 0 && slots.length > 0
    : adRequests.length === 0 && auctionCalls.length === 0 && slots.length === 0;
  if (!ok) failed = true;

  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${label}  ${url}`);
  console.log(`  GAM ad requests: ${adRequests.length}   auction calls: ${auctionCalls.length}`);
  console.log(`  defined slots: ${JSON.stringify(slots)}`);
  console.log(`  expected: ${expectAds ? 'ads served' : 'no ad requests at all'}`);

  await ctx.close();
}

await browser.close();
console.log(`\n${failed ? 'FAILED' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
