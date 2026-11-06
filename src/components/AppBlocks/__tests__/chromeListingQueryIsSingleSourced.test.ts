import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The app-block host chrome reads `appListings.getAppDetail` from exactly ONE place.
 * Node `unit` project — the tier that EXECUTES this assertion (report-only on a pull
 * request, an honest verdict on a push to `main`). `ChromeReviewEntry.browser.test.tsx`
 * proves the same property behaviourally against real React Query, in the
 * browser tier (`Component tests`). NEITHER TIER BLOCKS A MERGE: `main` requires no status check at
 * all in this repo, so this is a signal a reviewer must read, not a door that stays shut.
 *
 * WHY IT EXISTS. F2 gave the chrome one consumer of that listing row (the app-name
 * crumb's store popover). F4 added a second (the ⋮ menu's review item, which needs
 * the listing `id` plus the `creator`/`kind` its eligibility gate reads). React Query
 * dedupes by KEY, so two consumers are one network request only while their inputs
 * AND options serialise identically — and that is a property of two separate pieces
 * of code, which nothing checks. `useQuery({ slug }, { retry: false })` and
 * `useQuery({ slug, kind: undefined }, {})` both compile, both render, both look
 * right, and the second doubles the chrome's traffic on a surface that renders on
 * every model page carrying a block.
 *
 * 🔴 SO THE RULE IS STRUCTURAL, NOT A COMPARISON OF TWO ARGUMENT LISTS. There is one
 * call site; a second one anywhere in the chrome fails this. That is strictly
 * stronger than checking that two call sites agree, because it also fails the
 * ALMOST-identical second call site that a diff-based check would have to be exactly
 * right about.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HOOK = 'src/components/AppBlocks/useChromeListingDetail.ts';
const TRPC = 'src/utils/trpc.ts';

/**
 * Every source that renders into the app-block host chrome. A file added here is a
 * file whose listing reads this rule now governs.
 */
const CHROME_SOURCES = [
  HOOK,
  'src/components/AppBlocks/IframeHost.tsx',
  'src/components/AppBlocks/AppNameCrumb.tsx',
  'src/components/AppBlocks/ChromeReviewEntry.tsx',
  'src/components/AppBlocks/ChromeRecentAppIcon.tsx',
];

function read(rel: string): string {
  const file = path.join(REPO_ROOT, rel);
  // Prove the path before trusting any "no match" below: a scan of an absent file
  // reports zero of everything, which reads as a clean pass.
  expect(fs.existsSync(file), `${rel} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip block + line comments — every token searched for below is also discussed at
 *  length in the prose around it, and a rule must never be satisfiable by prose ABOUT
 *  the rule. (This module's own header names `getAppDetail.useQuery` twice.) */
function code(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function countCallSites(src: string): number {
  return (src.match(/getAppDetail\.useQuery\s*\(/g) ?? []).length;
}

describe('the chrome reads the listing from one place', () => {
  it('the matcher can actually see a call site, and ignores prose about one — positive control', () => {
    // A guard built on a regex that matches nothing reports a confident, empty,
    // fully-green set. Feed it a shape it MUST find, and the two shapes that would
    // make it lie: a call spread across lines, and the same token inside a comment.
    expect(countCallSites('const x = trpc.appListings.getAppDetail.useQuery({ slug });')).toBe(1);
    expect(
      countCallSites('trpc.appListings.getAppDetail.useQuery(\n  { slug },\n  { retry: false }\n)')
    ).toBe(1);
    expect(countCallSites(code('// see getAppDetail.useQuery( for why\nconst y = 1;'))).toBe(0);
    expect(countCallSites(code('/* getAppDetail.useQuery({slug}) */ const y = 1;'))).toBe(0);
    expect(countCallSites('trpc.appListings.listReviews.useQuery({ id });')).toBe(0);
  });

  it('there is exactly ONE getAppDetail call site across every chrome source, and it is the shared hook', () => {
    const perFile = CHROME_SOURCES.map((rel) => [rel, countCallSites(code(read(rel)))] as const);
    const total = perFile.reduce((n, [, c]) => n + c, 0);

    expect(
      total,
      'the chrome must read `appListings.getAppDetail` from exactly one place. Found: ' +
        JSON.stringify(Object.fromEntries(perFile)) +
        '. A second call site is one network request per chrome render more than the first, ' +
        'and it only stays deduped while its input and options serialise identically to the ' +
        'other one — route it through `useChromeListingDetail` instead.'
    ).toBe(1);

    expect(
      Object.fromEntries(perFile)[HOOK],
      `the single call site must live in ${HOOK}, not in a component`
    ).toBe(1);
  });

  it('every consumer reaches the query through the shared hook', () => {
    // The count above would also be satisfied by a consumer that stopped reading the
    // listing altogether — which is a behaviour change, not a consolidation. Pin that
    // both surfaces still go through the hook.
    for (const rel of [
      'src/components/AppBlocks/AppNameCrumb.tsx',
      'src/components/AppBlocks/ChromeReviewEntry.tsx',
      'src/components/AppBlocks/ChromeRecentAppIcon.tsx',
    ]) {
      const src = code(read(rel));
      expect(src, `${rel} no longer calls useChromeListingDetail`).toMatch(
        /useChromeListingDetail\s*\(/
      );
    }
  });

  it('the "Recently run" menu renders each row icon through the gated ChromeRecentAppIcon, keyed by blockId', () => {
    // 🔴 THE NODE-TIER PIN OF THE MENU WIRING. The behavioural proof lives in
    // `AppBlockChrome.browser.test.tsx`, in the browser tier; without this a row
    // reverted to the generic glyph, or keyed by the AppBlock `id` instead of the listing
    // slug (`blockId`) — no icon ever, and a 404 per row per open — passes every executed
    // test. It also forbids reading `.iconUrl` anywhere in the host: that url is the
    // un-gated stored one this menu must never render.
    const usages = (src: string) => src.match(/<ChromeRecentAppIcon\b[^>]*\/>/g) ?? [];
    const BLOCK_ID_USAGE = /^<ChromeRecentAppIcon\s+slug=\{\s*\w+\.blockId\s*\}\s*\/>$/;

    // Positive controls: the matcher sees a usage, the shape test separates the two
    // keyings, and comment-stripping keeps prose from satisfying it.
    expect(usages('x = <ChromeRecentAppIcon slug={r.blockId} />')).toHaveLength(1);
    expect(BLOCK_ID_USAGE.test('<ChromeRecentAppIcon slug={r.blockId} />')).toBe(true);
    expect(BLOCK_ID_USAGE.test('<ChromeRecentAppIcon slug={r.id} />')).toBe(false);
    expect(usages(code('{/* <ChromeRecentAppIcon slug={r.blockId} /> */}'))).toHaveLength(0);

    const host = code(read('src/components/AppBlocks/IframeHost.tsx'));
    const found = usages(host);
    expect(found, 'IframeHost no longer renders ChromeRecentAppIcon exactly once').toHaveLength(1);
    expect(
      found[0],
      'the recents row must key the gated icon by the listing slug (blockId)'
    ).toMatch(BLOCK_ID_USAGE);
    expect(host, 'IframeHost must never read a stored (un-gated) iconUrl').not.toMatch(
      /\.iconUrl\b/
    );
  });

  it('the hook passes `retry: false`, matching the store-preview page it mirrors', () => {
    // A listing that is missing, unapproved or scope-gated 404s server-side. Retrying
    // it three times is three requests for an answer that cannot change, on a surface
    // that renders on every model page carrying a block.
    expect(code(read(HOOK))).toMatch(/retry:\s*false/);
  });

  it("the app's own query defaults are what the browser suite mirrors — staleTime: Infinity", () => {
    // 🔴 THIS PINS A CROSS-FILE PREMISE, NOT A CONSTANT FOR ITS OWN SAKE.
    // `ChromeReviewEntry.browser.test.tsx` builds its QueryClient with
    // `staleTime: Infinity` because that is what `src/utils/trpc.ts` ships; the shared
    // component harness uses React Query's default 0 instead. If the app ever drops to
    // a finite staleTime, remounting the second chrome surface would refetch in
    // PRODUCTION while the browser suite kept reporting one request — the dedupe test
    // would go quietly vacuous with nothing to indicate it. Change both together.
    const trpcSrc = code(read(TRPC));
    expect(
      trpcSrc,
      'src/utils/trpc.ts no longer defaults queries to `staleTime: Infinity` — re-read the ' +
        'dedupe assertion in ChromeReviewEntry.browser.test.tsx before believing it.'
    ).toMatch(/staleTime:\s*Infinity/);
  });
});
