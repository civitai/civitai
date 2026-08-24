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
 *   - `fit="fill"` WITHOUT `scrollable: false` → the host claims no height inside
 *     a layout that bounds nothing, so `flex: 1` resolves against an auto-height
 *     parent and the iframe LETTERBOXES to roughly its ~150px intrinsic
 *     replaced-element height. (Measured. An earlier version of this note said
 *     "0px"; that is what `flex: 0` produces, not this.) Broken, but quietly —
 *     it reads as a badly-sized block rather than a layout regression.
 *   - `scrollable: false` WITHOUT `fit="fill"` → the outer scrollbar is gone but
 *     the host still claims more height than the now `overflow-hidden` chain can
 *     give it, so the bottom of the app is CLIPPED and unreachable. Strictly
 *     worse than the bug being fixed.
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
  const m = anchor.exec(src);
  expect(m, `${label}: anchor ${anchor} no longer matches — update the pin deliberately`).not.toBe(
    null
  );
  return norm(m![0]);
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
   *   - `flex: 1` → `flex: 0` in the fill branch — a 0px host.
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
    expect(region(src, /\.\.\.\(fit === 'fill'[\s\S]*?\}\),/, 'fit ternary')).toBe(
      "...(fit === 'fill' ? { flex: 1, minHeight: FILL_MIN_HEIGHT_PX, } " +
        ": { height: '100%', minHeight: 'calc(100dvh - 60px)', }),"
    );
  });

  it('pins the reveal wrapper, whose `overflow: hidden` is what confines the 8px transform', () => {
    const src = code(read(HOST));
    expect(
      region(src, /<Box\s+style=\{\{\s*position: 'relative',[\s\S]*?\}\}\s*>/, 'reveal wrapper')
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
   * pre-merge sweep while letterboxing the iframe to its ~150px intrinsic
   * height — the browser test cannot see it because that test builds its own
   * fixture wrapper rather than importing the Next page.
   */
  it('pins the run page wrapper — the third leg the browser test structurally cannot see', () => {
    const src = code(read(RUN_PAGE));
    expect(
      region(src, /<Box\s+style=\{\{\s*display: 'flex',[\s\S]*?\}\}\s*>/, 'page wrapper')
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
          if (!/<PageBlockHost\b/.test(src)) continue;
          if (/\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/.test(src))
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
});
