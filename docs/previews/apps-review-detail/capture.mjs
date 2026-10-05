// Regenerates every PNG beside this file: each review-detail Ladle story, both colour schemes.
//
//   node_modules/.bin/ladle serve --port 61121       # in one shell
//   PW_EXEC=<path-to-chromium> node docs/previews/apps-review-detail/capture.mjs
//
// Exits non-zero if any shot fails a floor, so a regenerated set cannot silently become a
// gallery of blank pages. Output is deviceScaleFactor 1 and clipped to the story's own content
// box: the first version shot 2x fullPage and produced 177-194 KB per file (2.3 MB total)
// against the 8-16 KB precedent next door in docs/previews/, mostly empty page below the fold.
// Run the PNGs through `pngquant --quality=65-90` afterwards, as the committed set was.
//
// Guards, because a screenshot of a blank page is indistinguishable from a screenshot of a
// working component until somebody looks:
//   · the rendered text must not contain "Story not found" (a wrong story id),
//   · it must be at least MIN_CHARS long (a crashed story renders Ladle's chrome only), and
//   · the page must not scroll horizontally.
// 🔴 `playwright`, THE DECLARED PACKAGE — not `playwright-core`. That is a fix, not a style
// choice: `playwright-core` is undeclared here and present only as a transitive of
// `playwright`, and `.npmrc` hoists nothing but `@types/*`, so under pnpm's strict layout it
// is not resolvable from repo code. Measured from a clean clone: `playwright` resolves,
// `playwright-core` gives ERR_MODULE_NOT_FOUND. The committed script would have failed for
// anyone running it; it only worked where a stray ambient `node_modules` sat above the
// checkout.
import { chromium } from 'playwright';
import { mkdirSync, statSync } from 'fs';

const BASE = 'http://localhost:61121';
const OUT = new URL('.', import.meta.url).pathname;
const MIN_CHARS = 300;
const STORIES = [
  { id: 'review-detail--permissions', name: 'permissions' },
  { id: 'review-detail--code--unified', name: 'code-unified', expand: 'src/App.tsx' },
  { id: 'review-detail--code--split', name: 'code-split', expand: 'src/App.tsx' },
  { id: 'review-detail--agent--partial-failure', name: 'agent-partial-failure' },
  { id: 'review-detail--agent--never-ran', name: 'agent-never-ran' },
  { id: 'review-detail--manifest', name: 'manifest' },
  { id: 'review-detail--preview--media', name: 'listing-media', minChars: 120 },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PW_EXEC,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const rows = [];
let bad = 0;

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  for (const { id: story, name, expand, minChars } of STORIES) {
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/?story=${story}&mode=preview&theme=${theme}`, {
      waitUntil: 'networkidle',
    });
    await pg.waitForTimeout(900);
    if (expand) {
      await pg.getByText(expand, { exact: true }).first().click();
      await pg.waitForTimeout(400);
    }
    const text = (await pg.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    const overflow = await pg.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    // Clip to the real content box so we do not commit a megabyte of empty page.
    const clip = await pg.evaluate(() => {
      const root = document.querySelector('#ladle-root') ?? document.body;
      let maxBottom = 0;
      let maxRight = 0;
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        maxBottom = Math.max(maxBottom, r.bottom + window.scrollY);
        maxRight = Math.max(maxRight, r.right + window.scrollX);
      }
      return {
        x: 0,
        y: 0,
        width: Math.min(Math.ceil(maxRight) + 16, document.documentElement.scrollWidth),
        height: Math.ceil(maxBottom) + 16,
      };
    });
    const file = `${OUT}/${theme}-${name}.png`;
    await pg.screenshot({ path: file, clip });
    const floor = minChars ?? MIN_CHARS;
    const ok = !/Story not found/.test(text) && text.length >= floor && overflow <= 1;
    if (!ok) bad += 1;
    rows.push({
      story,
      theme,
      chars: text.length,
      xOverflow: overflow,
      box: `${clip.width}x${clip.height}`,
      kb: Math.round(statSync(file).size / 1024),
      ok,
    });
    await pg.close();
  }
  await ctx.close();
}
await browser.close();

let total = 0;
for (const r of rows) {
  total += r.kb;
  console.log(
    `${r.ok ? 'OK  ' : 'BAD '} ${r.theme.padEnd(5)} ${r.story.padEnd(38)} chars=${String(
      r.chars
    ).padStart(5)} xOverflow=${r.xOverflow} box=${r.box.padEnd(10)} ${String(r.kb).padStart(4)}KB`
  );
}
console.log(`\n${rows.length} shots, ${bad} failed the floor, ${total} KB total`);
process.exit(bad === 0 ? 0 : 1);
