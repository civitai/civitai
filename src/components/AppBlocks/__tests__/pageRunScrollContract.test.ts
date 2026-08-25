import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `/apps/run/<slug>` must declare a NON-SCROLLING layout, and its host must
 * claim no height of its own. Node `unit` project — the GATING suite. The
 * `.browser.test.tsx` component suites DO run in CI, as the report-only
 * `preview / component-tests` status (`pnpm run test:component`), so a break
 * there is visible but does not block a merge. The coupling is pinned here for
 * that reason, and only MEASURED in `PageBlockHostScrollFit.browser.test.tsx`.
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
 * 🔴 IT IS A CO-REQUISITE OF THREE LEGS, IN THREE PLACES. None is safe alone, so
 * the failure mode is someone reverting one during an unrelated change:
 *
 *   - `fit="fill"` WITHOUT `scrollable: false` → the host sits inside a layout
 *     that bounds nothing, so `flex: 1` has nothing to resolve against and the
 *     host is sized purely by `FILL_MIN_HEIGHT_PX` — a fixed 300px slab on a
 *     1080px screen. Broken, but quietly: it reads as a badly-sized block rather
 *     than a layout regression.
 *
 *     🔴 THIS FIGURE HAS BEEN WRONG TWICE, both times by editing the sentence
 *     instead of re-reading the code. It said "0px" (that is what `flex: 0`
 *     gives), then "~150px" (the iframe's intrinsic height — true before the
 *     floor existed, false the moment `FILL_MIN_HEIGHT_PX` was added in the same
 *     PR). Re-derive from the `fill` branch before touching this line.
 *   - `scrollable: false` WITHOUT `fit="fill"` → the host claims
 *     `100dvh - 60px` again. The `overflow-hidden` chain sits ABOVE the run
 *     page's own wrapper, and that wrapper is `overflowY: 'auto'`, so the excess
 *     is SCROLLED, not clipped: a page scrollbar beside the block's own — the
 *     exact bug this PR removes. Measured 708px of host in a 600px wrapper,
 *     `USER_SCROLLABLE=true`.
 *
 *     🔴 THIS BULLET SAID "CLIPPED" FOR FIVE COMMITS, and it was TRUE when
 *     written at `4f78d37351` — the wrapper had no `overflowY` then. `c48ba4d029`
 *     added it and nobody re-derived the sentence. Two later rounds each declared
 *     the stale-figure class eradicated while this sat here, and one of them
 *     added cross-references POINTING AT this paragraph. Nothing clips in this
 *     layout; the wrapper can always scroll.
 *   - EITHER OF THOSE WITHOUT the run page's wrapper `Box` → same as the first
 *     case. This is the leg the browser suite structurally cannot see, because
 *     that suite builds its own fixture wrapper instead of importing the page.
 *
 * Presence checks alone pass a half-revert of the third leg and every mutation
 * that inverts rather than deletes, so the assertions below pin whole normalised
 * expressions as well.
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

/** Collapse whitespace so an assertion pins the EXPRESSION, not its formatting. */
function norm(src: string): string {
  return src.replace(/\s+/g, ' ').trim();
}

/**
 * Pull one balanced-looking source region out of a file by anchor regex, and
 * fail loudly if the anchor stops matching.
 *
 * 🔴 A regex that no longer matches must never read as "the rule is satisfied".
 * These assertions are the only thing standing between a later refactor and a
 * silent return of the bug, so an unmatched anchor is a FAILURE, not a skip.
 */
function region(src: string, anchor: RegExp, label: string): string {
  // `matchAll`, not `exec`: a first-match read silently grades the WRONG
  // occurrence if a second ever appears. That exact bug bit the `<main>`
  // assertion below (it read the scrollable branch instead of the no-scroll
  // one), so the lesson is applied at every site rather than the one that hurt.
  const all = [...src.matchAll(new RegExp(anchor.source, `${anchor.flags.replace('g', '')}g`))];
  expect(
    all.length,
    `${label}: expected exactly ONE match for ${anchor}, found ${all.length}. ` +
      'Zero means the anchor rotted — update the pin deliberately rather than deleting it. ' +
      'More than one means this pin is now ambiguous and is grading an arbitrary occurrence.'
  ).toBe(1);
  return norm(all[0][0]);
}

/** Shared explanation attached to every verbatim pin, so a failure tells the
 *  maintainer what it is and what to do rather than just diffing two strings. */
const PIN_HELP =
  'This is a DELIBERATE verbatim pin, not an incidental string match — a token check here ' +
  'passed a ternary inversion, a `flex: 0` and a deleted `overflow: hidden`. If you changed ' +
  'this block on purpose (including a pure reformat or a rename), update the expected string ' +
  'here in the same commit. If you did not, you have reintroduced the /apps/run double ' +
  'scrollbar or its 0-height cousin — see this file’s header.';

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
    // one regresses the page in a DIFFERENT direction (see this file's header —
    // neither direction is clipping), so this is what has to fail.
    expect(
      nonScrolling === fillFit,
      `\`scrollable: false\` (${nonScrolling}) and \`fit="fill"\` (${fillFit}) are a ` +
        'co-requisite on the run page — drop `fit="fill"` and the double scrollbar ' +
        'comes back (the page wrapper scrolls the excess); drop `scrollable: false` and ' +
        'the host becomes a fixed floor-height slab. See this file’s header.'
    ).toBe(true);
  });

  /**
   * 🔴 PIN THE WHOLE EXPRESSION, NOT FEATURES OF IT.
   *
   * A pre-merge mutation sweep on the first version of this file found 9 of 17
   * mutants surviving, because every assertion here was a presence check. The
   * three that matter, all invisible to a token grep:
   *
   *   - INVERT THE TERNARY (`fit === 'fill'` → `fit !== 'fill'`) — breaks EVERY
   *     surface at once: the run page gets the viewport calc back (the double
   *     scrollbar) and the dev tunnel + mod review get `fill` inside unbounded
   *     parents (the collapse the prop doc warns about). Every token a presence
   *     check looks for is still there.
   *   - `flex: 1` → `flex: 0` in the fill branch — the host stops growing at all.
   *   - DELETE (or comment out) `overflow: 'hidden'` on the reveal wrapper — the
   *     8px transform leak returns.
   *
   * Pinning the normalised text of the whole expression kills all three in one
   * assertion. The accepted cost is that a cosmetic reformat of these exact
   * blocks fails this test — that is the trade for a machine-checkable claim,
   * and the failure message says so. `code()` runs first, so commenting a line
   * out changes the normalised string exactly as deleting it does.
   */
  it("pins the host's `fit` branches verbatim — inversion, `flex: 0` and a dropped `overflow` all fail", () => {
    const src = code(read(HOST));
    expect(region(src, /\.\.\.\(fit === 'fill'[\s\S]*?\}\),/, 'fit ternary'), PIN_HELP).toBe(
      "...(fit === 'fill' ? { flex: 1, minHeight: FILL_MIN_HEIGHT_PX, } " +
        ": { height: '100%', minHeight: 'calc(100dvh - 60px)', }),"
    );
  });

  it('pins the reveal wrapper, whose `overflow: hidden` is what confines the 8px transform', () => {
    const src = code(read(HOST));
    expect(
      region(src, /<Box\s+style=\{\{\s*position: 'relative',[\s\S]*?\}\}\s*>/, 'reveal wrapper'),
      PIN_HELP
    ).toBe(
      "<Box style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden', }} >"
    );
  });

  /**
   * 🔴 THE CO-REQUISITE IS A TRIO, NOT A PAIR — this is the third leg.
   *
   * The run page's own wrapper `Box` is what gives `fit="fill"` a growing flex
   * item to resolve against, and its `overflowY: 'auto'` is the scroll container
   * of last resort that makes `FILL_MIN_HEIGHT_PX` reachable instead of clipped.
   * Reverting it to the original `{ width: '100%' }` passed BOTH suites in the
   * pre-merge sweep while leaving the host sized only by its floor — measured
   * 300px host / 31px chrome / 269px iframe, whatever the viewport. The browser
   * test cannot see it because that test builds its own fixture wrapper rather
   * than importing the Next page.
   */
  it('pins the run page wrapper — the third leg the browser test structurally cannot see', () => {
    const src = code(read(RUN_PAGE));
    expect(
      region(src, /<Box\s+style=\{\{\s*display: 'flex',[\s\S]*?\}\}\s*>/, 'page wrapper'),
      PIN_HELP
    ).toBe(
      "<Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, " +
        "overflowY: 'auto', width: '100%', }} >"
    );
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
    //
    // Scoped to files that actually mount `PageBlockHost`, because `fit` is not
    // a name this codebase owns — Mantine's `Image` has a `fit` prop too, so an
    // unrelated `fit="fill"` elsewhere in `src` would otherwise fail this test
    // and hand an unrelated team a maintenance tax.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const src = code(fs.readFileSync(full, 'utf8'));
          // Match the IMPORT, not the JSX tag: `import { PageBlockHost as Host }`
          // renders `<Host …>`, which a tag-only test misses entirely. (The
          // pre-scoping version caught it, over-broadly; this keeps the scoping
          // without reopening that hole.)
          if (!/\bPageBlockHost\b/.test(src)) continue;
          if (/\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/.test(src))
            // Posix separators, so the expectation below reads the same on every
            // platform. Without this the walk yields `src\pages\…` on Windows and
            // the guard fails there while staying green on Linux CI.
            offenders.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
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
    // …and the non-scrollable branch clips instead of scrolling, all the way
    // down. Asserted as an unordered SET of classes, not as a literal string: a
    // prettier/tailwind-sort reorder is a no-op that would otherwise fail this.
    expect(src).toMatch(/no-scroll[^"']*flex[^"']*overflow-hidden/);

    // 🔴 `AppLayout` has TWO `<main>` elements — one per branch — so match ALL
    // of them and look for the no-scroll one. Reading only the first match found
    // the SCROLLABLE branch's `min-w-0 flex-1` and failed against the set this
    // test is about; a first-match read of a repeated pattern is its own bug
    // class, in the assertion as much as in an edit.
    //
    // 🔴 SORTED ARRAYS, NOT `Set`s. `expect([...]).toContainEqual(new Set([...]))`
    // does NOT deep-compare Set contents in Vitest — measured: it PASSES when
    // the expected set is absent entirely. A first draft of this assertion used
    // it and was silently vacuous, which the mutation sweep caught only because
    // dropping `overflow-hidden` survived. Sorting makes the comparison
    // order-independent without relying on Set equality.
    const mainClasses = [...src.matchAll(/<main className="([^"]*)">/g)].map((m) =>
      m[1].split(/\s+/).filter(Boolean).sort()
    );
    expect(mainClasses.length, 'expected both AppLayout branches to render a <main>').toBe(2);
    expect(mainClasses).toContainEqual(['flex', 'flex-1', 'flex-col', 'overflow-hidden'].sort());
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

  /**
   * 🔴 THE FLOOR'S VALUE BELONGS IN THE GATING TIER, NOT ONLY THE BROWSER ONE.
   *
   * `FILL_MIN_HEIGHT_PX` is the whole WCAG fix: too low and a short viewport
   * strands content behind `overflow-hidden`; too high and the page grows a
   * scrollbar beside the block's own on ordinary phones, which is THIS PR'S BUG
   * in a narrower window. Both guards on it were in
   * `PageBlockHostScrollFit.browser.test.tsx` — and that suite is REPORT-ONLY
   * (`preview / component-tests`) and historically ~16% flaky, i.e. exactly the
   * combination that trains people to click through. Measured: with the floor set
   * to 0, this gating file was 9/9 GREEN and only the non-blocking tier went red.
   *
   * So the band is asserted HERE too, by reading the declaration out of the
   * source the same way the `HEADER_HEIGHT` tripwire above does. The browser
   * suite still measures the CONSEQUENCE (a real host, laid out, at two viewport
   * sizes); this pins the DECISION so a merge cannot quietly change it.
   *
   * 🔴 THE BOUNDS ARE DELIBERATELY LITERALS HERE, NOT READ FROM THE SOURCE. A
   * band imported from (or regexed out of) `PageBlockHost.tsx` would be graded
   * against the same file it bounds, so a single edit could move the value and
   * its own limits together — the self-referential trap this whole guard exists
   * because of. The ARITHMETIC that justifies them lives on the constant's doc
   * comment; the NUMBERS live here (gating) and in
   * `PageBlockHostScrollFit.browser.test.tsx` (report-only). Both must admit a
   * value, so the tighter pair wins and drift is fail-safe.
   */
  it('`FILL_MIN_HEIGHT_PX` stays inside its documented band — in the BLOCKING tier', () => {
    const declared = /export const FILL_MIN_HEIGHT_PX = (\d+);/.exec(code(read(HOST)))?.[1];
    expect(
      declared,
      'FILL_MIN_HEIGHT_PX declaration not found in PageBlockHost.tsx — if it was renamed or ' +
        'derived, this guard must be re-pointed, not deleted: it is the only BLOCKING check on ' +
        'the floor value.'
    ).toBeDefined();

    const floor = Number(declared);
    // Lower: below this the block's own area (floor − ~31px AppBlockChrome) stops
    // being usable, which is the case the floor exists to prevent.
    // Upper: every px added widens the viewport population that sees two
    // scrollbars. 400 — the value this PR itself shipped one commit ago — is
    // outside the band on purpose.
    expect(floor).toBeGreaterThanOrEqual(280);
    expect(floor).toBeLessThanOrEqual(340);
  });
});
