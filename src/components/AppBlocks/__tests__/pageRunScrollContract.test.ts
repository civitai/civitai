import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `/apps/run/<slug>` must declare a NON-SCROLLING layout, and its host must
 * claim no height of its own. Node `unit` project — the suite CI actually runs
 * (the `.browser.test.tsx` component suites are not run in CI at all), which is
 * why the coupling is pinned here and only MEASURED in
 * `PageBlockHostScrollFit.browser.test.tsx`.
 *
 * WHAT BROKE. The route shipped a bare `export default function AppPage`, so it
 * inherited `AppLayout`'s default `scrollable: true` — a `ScrollArea` with
 * `overflow-y: auto`. Inside it `PageBlockHost` claimed
 * `min-height: calc(100dvh - 60px)`, which subtracts the site header and nothing
 * else. Sub-nav, its `mb-3`, the rewards banner, the footer and the adhesive ad
 * all sit inside or beside that scroll viewport, so the host was unconditionally
 * taller than the space it had: an outer scrollbar that scrolled only the
 * residue, beside the block's own scrollbar inside the iframe.
 *
 * 🔴 THE TWO HALVES ARE A CO-REQUISITE, WHICH IS THE ACTUAL POINT OF THIS FILE.
 * Neither is safe alone and they live in different places, so the failure mode is
 * someone reverting one during an unrelated change:
 *
 *   - `fit="fill"` WITHOUT `scrollable: false` → the host claims no height inside
 *     a layout that bounds nothing, so `flex: 1` resolves against an auto-height
 *     parent and the iframe renders 0px tall. A blank page, which reads as a
 *     broken block rather than a layout regression.
 *   - `scrollable: false` WITHOUT `fit="fill"` → the outer scrollbar is gone but
 *     the host still claims more height than the now `overflow-hidden` chain can
 *     give it, so the bottom of the app is CLIPPED and unreachable. Strictly
 *     worse than the bug being fixed.
 *
 * A test that only checked for the presence of each would pass on either
 * half-revert, so the assertions below are written as an equivalence.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RUN_PAGE = path.join(REPO_ROOT, 'src/pages/apps/run/[slug]/[[...path]].tsx');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/PageBlockHost.tsx');
const APP_LAYOUT = path.join(REPO_ROOT, 'src/components/AppLayout/AppLayout.tsx');

function read(file: string): string {
  // Prove the path before trusting a "no match": a comparison against an absent
  // operand reports SAME, not MISSING, and a renamed route would otherwise turn
  // every assertion below into a vacuous pass on an empty string.
  expect(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip block + line comments so a rule can never be satisfied by prose ABOUT
 *  the rule — every one of these tokens is discussed at length in the comments
 *  it is being searched for in. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the run page and its host agree on who owns the height', () => {
  it('the run page ships BOTH halves — non-scrolling layout AND a fill-fit host', () => {
    const src = code(read(RUN_PAGE));

    // Half 1: the route opts out of AppLayout's ScrollArea.
    expect(src).toMatch(/\bscrollable:\s*false\b/);
    // It has to reach the layout, which means going through `Page(...)` — a bare
    // default export silently takes every default back.
    expect(src).toMatch(/export\s+default\s+Page\s*\(/);

    // Half 2: the host is told not to claim a viewport-derived height.
    expect(src).toMatch(/\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/);
  });

  it('neither half can be reverted on its own', () => {
    const src = code(read(RUN_PAGE));
    const nonScrolling = /\bscrollable:\s*false\b/.test(src);
    const fillFit = /\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/.test(src);

    // The equivalence, not two independent presence checks. Half-reverting either
    // one regresses the page in a DIFFERENT direction (0px iframe / clipped app),
    // so this is what has to fail.
    expect(
      nonScrolling === fillFit,
      `\`scrollable: false\` (${nonScrolling}) and \`fit="fill"\` (${fillFit}) are a ` +
        'co-requisite on the run page — shipping one without the other replaces the ' +
        'double scrollbar with a 0px or clipped iframe. See this file’s header.'
    ).toBe(true);
  });

  it('the host still DEFAULTS to `viewport`, so the other three mounters are untouched', () => {
    const src = code(read(HOST));
    // The dev tunnel and the mod-review preview mount inside scrolling ancestors
    // that bound nothing; flipping this default would collapse both.
    expect(src).toMatch(/\bfit\s*=\s*['"]viewport['"]/);
  });

  it('only the run page opts into `fill` — a new mounter must opt in deliberately', () => {
    // A directory walk, not a hand-kept list: the point is to notice a mounter
    // nobody told this test about.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (
            /\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/.test(code(fs.readFileSync(full, 'utf8')))
          )
            offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));

    expect(offenders.sort()).toEqual(['src/pages/apps/run/[slug]/[[...path]].tsx']);
  });

  it('the layout premise this all rests on still holds', () => {
    // If `AppLayout`'s two branches ever stop differing this way, the fix above is
    // reasoning about a layout that no longer exists — and would fail SILENTLY,
    // since both halves would still be present in the source.
    const src = code(read(APP_LAYOUT));

    // The scrollable branch is a bounded, auto-overflow viewport…
    expect(src).toMatch(/scrollable\s*\?\s*\(\s*<ScrollArea/);
    // …and the non-scrollable branch clips instead of scrolling, all the way down.
    expect(src).toMatch(/no-scroll[^"']*flex[^"']*overflow-hidden/);
    expect(src).toMatch(/<main className="flex flex-1 flex-col overflow-hidden">/);
  });

  it('`HEADER_HEIGHT` is still 60, so the surviving `viewport` calc is not silently stale', () => {
    // `PageBlockHost` hardcodes `60` as a SECOND COPY of a constant private to
    // `AppHeader.tsx`. The run page no longer depends on it, but the dev tunnel
    // and mod review still do — and a header resize would re-open this bug there
    // with nothing to notice. One rule, two places: this is the tripwire until
    // they are consolidated.
    const header = read(path.join(REPO_ROOT, 'src/components/AppLayout/AppHeader/AppHeader.tsx'));
    const declared = /const HEADER_HEIGHT = (\d+);/.exec(code(header))?.[1];
    expect(declared, 'HEADER_HEIGHT declaration not found in AppHeader.tsx').toBeDefined();

    const hostCalc = /minHeight:\s*'calc\(100dvh - (\d+)px\)'/.exec(code(read(HOST)))?.[1];
    expect(hostCalc, 'the viewport-fit calc not found in PageBlockHost.tsx').toBeDefined();

    expect(hostCalc).toBe(declared);
  });
});
