import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  getRecentRailAction,
  getRecentRailTarget,
  RECENT_RAIL_LIMIT,
  reconcileRecentApps,
  resolveRecentApp,
  selectChromeRecentApps,
  selectRecentRailEntries,
  toRecentAppFromListing,
  type RecentHealMemo,
} from '~/components/Apps/recentAppsRail';
import type { RecentApp } from '~/components/Apps/recentlyOpenedAppsStore';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * "Recently opened" rail view-model — node `unit` project: the fast,
 * deterministic suite CI runs on every PR (the browser component suites are not
 * run in CI at all).
 *
 * Pins the four things that can silently break a returning viewer's rail:
 *   1. LEGACY-SHAPE TOLERANCE — a `{id, blockId}` entry written before `slug`
 *      existed still resolves (on-site slug === block_id), and an entry that
 *      genuinely cannot be resolved is DROPPED rather than rendered as a dead
 *      link.
 *   2. DEDUPE + CAP.
 *   3. TARGET selection — never a dead/incorrect nav for any kind × flag combo.
 *   4. APP-CHROME MENU eligibility — the `/apps/run/`-only dropdown offers an
 *      entry only to a viewer who can actually open that route.
 */

const onsite = (over: Partial<RecentApp> = {}): RecentApp => ({
  id: 'ab_1',
  blockId: 'gen-matrix',
  slug: 'gen-matrix',
  kind: 'onsite',
  hasPage: true,
  name: 'Gen Matrix',
  ...over,
});

const offsite = (over: Partial<RecentApp> = {}): RecentApp => ({
  id: 'lst_1',
  slug: 'ext-app',
  kind: 'offsite',
  externalUrl: 'https://ext.example/app',
  name: 'Ext App',
  ...over,
});

describe('resolveRecentApp — legacy-shape tolerance', () => {
  it('resolves a LEGACY {id, blockId}-only entry (on-site slug === block_id)', () => {
    // The v1 store shape. Dropping it would silently empty a returning viewer's
    // rail; resolving it is safe because app-listing-mapper sets
    // `slug: ab.blockId` for every on-site listing.
    const resolved = resolveRecentApp({ id: 'ab_9', blockId: 'legacy-app' });
    expect(resolved).toEqual({
      id: 'ab_9',
      slug: 'legacy-app',
      blockId: 'legacy-app',
      kind: 'onsite',
      // Never recorded by the legacy writer → treated as FALSE, so the rail
      // routes to the always-valid detail rather than a maybe-404 run route.
      hasPage: false,
    });
  });

  it('a legacy entry links to the DETAIL, never to /apps/run (hasPage unknown)', () => {
    const resolved = resolveRecentApp({ id: 'ab_9', blockId: 'legacy-app' })!;
    expect(getRecentRailTarget(resolved, { canOpenPage: true })).toEqual({
      href: '/apps/store-preview/legacy-app',
      external: false,
    });
  });

  it('an OFF-SITE entry with no slug is DROPPED (blockId can never stand in)', () => {
    expect(
      resolveRecentApp({ id: 'x', blockId: 'not-a-listing-slug', kind: 'offsite' })
    ).toBeNull();
  });

  it('an entry with neither slug nor blockId is DROPPED (no dead link)', () => {
    expect(resolveRecentApp({ id: 'x' })).toBeNull();
  });

  it('a slug-only on-site entry resolves and back-fills blockId', () => {
    const resolved = resolveRecentApp({
      id: 'x',
      slug: 'only-slug',
      kind: 'onsite',
      hasPage: true,
    });
    expect(resolved).toMatchObject({ slug: 'only-slug', blockId: 'only-slug', hasPage: true });
  });

  it('a non-https off-site externalUrl is dropped by the https guard', () => {
    const resolved = resolveRecentApp(offsite({ externalUrl: 'http://insecure.example' }))!;
    expect(resolved.externalUrl).toBeUndefined();
  });

  it('🔴 hasPage is accepted ONLY as the literal boolean true, never as a truthy value', () => {
    // `hasPage: entry.hasPage === true` — not `!!entry.hasPage`. This blob is
    // user-writable localStorage, so a hand-edited `"true"` (string) or `1`
    // must NOT be read as "this app has a launch page": that would route the
    // rail at `/apps/run/<blockId>`, which 404s for a model-slot app.
    for (const truthy of ['true', 1, {}, []] as unknown[]) {
      const resolved = resolveRecentApp({
        ...onsite(),
        hasPage: truthy as boolean,
      })!;
      expect(resolved.hasPage, `hasPage=${JSON.stringify(truthy)}`).toBe(false);
      expect(getRecentRailTarget(resolved, { canOpenPage: true }).href).toBe(
        '/apps/store-preview/gen-matrix'
      );
    }
  });
});

describe('selectRecentRailEntries — dedupe + cap + drop', () => {
  it('drops unresolvable entries but keeps the resolvable ones around them', () => {
    const out = selectRecentRailEntries([
      { id: 'bad' }, // no handle
      onsite({ id: 'good' }),
      { id: 'bad2', kind: 'offsite', blockId: 'nope' }, // off-site w/o slug
    ]);
    expect(out.map((e) => e.id)).toEqual(['good']);
  });

  it('de-dups by id, keeping the FIRST (newest — the store prepends)', () => {
    const out = selectRecentRailEntries([
      onsite({ id: 'dup', name: 'Newest' }),
      onsite({ id: 'dup', name: 'Older' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Newest');
  });

  it('caps at RECENT_RAIL_LIMIT', () => {
    const many = Array.from({ length: RECENT_RAIL_LIMIT + 4 }, (_, i) =>
      onsite({ id: `a${i}`, slug: `s${i}`, blockId: `s${i}` })
    );
    expect(selectRecentRailEntries(many)).toHaveLength(RECENT_RAIL_LIMIT);
  });

  it('honours an explicit limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => onsite({ id: `a${i}`, slug: `s${i}` }));
    expect(selectRecentRailEntries(many, { limit: 2 })).toHaveLength(2);
  });

  it('an empty store yields an empty rail (→ the view renders nothing)', () => {
    expect(selectRecentRailEntries([])).toEqual([]);
  });
});

describe('getRecentRailTarget', () => {
  it('on-site page app + canOpenPage → re-opens at /apps/run/<blockId>', () => {
    expect(getRecentRailTarget(resolveRecentApp(onsite())!, { canOpenPage: true })).toEqual({
      href: '/apps/run/gen-matrix',
      external: false,
    });
  });

  it('on-site page app + appBlocksPages DARK → the detail (never a 404 run link)', () => {
    expect(getRecentRailTarget(resolveRecentApp(onsite())!, { canOpenPage: false })).toEqual({
      href: '/apps/store-preview/gen-matrix',
      external: false,
    });
  });

  it('on-site NON-page app → the detail even with canOpenPage', () => {
    expect(
      getRecentRailTarget(resolveRecentApp(onsite({ hasPage: false }))!, { canOpenPage: true })
    ).toEqual({ href: '/apps/store-preview/gen-matrix', external: false });
  });

  it('off-site → the external destination, as an external anchor', () => {
    expect(getRecentRailTarget(resolveRecentApp(offsite())!, { canOpenPage: true })).toEqual({
      href: 'https://ext.example/app',
      external: true,
    });
  });

  it('off-site with no usable external url → the detail (never actionless)', () => {
    expect(
      getRecentRailTarget(resolveRecentApp(offsite({ externalUrl: undefined }))!, {
        canOpenPage: true,
      })
    ).toEqual({ href: '/apps/store-preview/ext-app', external: false });
  });

  it('encodes an odd slug / blockId', () => {
    const resolved = resolveRecentApp(onsite({ slug: 'a b/c', blockId: 'a b/c' }))!;
    expect(getRecentRailTarget(resolved, { canOpenPage: true }).href).toBe('/apps/run/a%20b%2Fc');
    expect(getRecentRailTarget(resolved, { canOpenPage: false }).href).toBe(
      '/apps/store-preview/a%20b%2Fc'
    );
  });
});

describe('toRecentAppFromListing', () => {
  const card = (over: Partial<ListingCard> = {}): ListingCard =>
    ({
      id: 'lst_1',
      slug: 'my-app',
      kind: 'onsite',
      name: 'My App',
      tagline: null,
      category: null,
      contentRating: null,
      iconUrl: 'https://cdn.example/icon.png',
      coverUrl: null,
      creator: null,
      recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
      reviewCount: 0,
      kindData: {
        kind: 'onsite',
        appBlockId: 'ab_1',
        hasPage: true,
        liveUrl: 'https://my-app.civit.ai',
      },
      ...over,
    } as ListingCard);

  it('🔴 on-site KEYS ON THE APPBLOCK ID — the same key the run page writes', () => {
    // The de-dup key must match the OTHER on-site writer, `/apps/run/<slug>`
    // (`recordRecentlyOpenedApp({ id: appBlockId, … })` in
    // src/pages/apps/run/[slug]/[[...path]].tsx). Keying on the AppListing id
    // here would persist ONE app as TWO entries — two rail tiles, and a
    // "move to front on re-open" that only ever moves one of them.
    const entry = toRecentAppFromListing(card());
    expect(entry.id).toBe('ab_1'); // kindData.appBlockId, NOT card.id ('lst_1')
    expect(entry).toEqual({
      id: 'ab_1',
      slug: 'my-app',
      blockId: 'my-app',
      kind: 'onsite',
      hasPage: true,
      name: 'My App',
      iconUrl: 'https://cdn.example/icon.png',
    });
  });

  it('on-site with NO backing appBlockId falls back to the listing id', () => {
    // The only on-site case the run page can never have written (no AppBlock →
    // no /apps/run route), so there is no other key to collide with.
    const entry = toRecentAppFromListing(
      card({
        kindData: {
          kind: 'onsite',
          appBlockId: null,
          hasPage: false,
          liveUrl: 'https://my-app.civit.ai',
        },
      })
    );
    expect(entry.id).toBe('lst_1');
  });

  it('the two on-site writers agree on the de-dup key (one app → one entry)', () => {
    // The run page writes `{ id: appBlockId, blockId, slug: blockId, … }`; this
    // builder must produce the SAME id for the same app, or the store's
    // de-dup-by-id does nothing.
    const fromRunPage = { id: 'ab_1', blockId: 'my-app', slug: 'my-app' };
    expect(toRecentAppFromListing(card()).id).toBe(fromRunPage.id);
  });

  it('off-site → carries the https external url and NO blockId', () => {
    const entry = toRecentAppFromListing(
      card({
        kind: 'offsite',
        iconUrl: null,
        kindData: { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://ext.app' },
      })
    );
    expect(entry).toEqual({
      id: 'lst_1',
      slug: 'my-app',
      kind: 'offsite',
      name: 'My App',
      externalUrl: 'https://ext.app',
    });
    expect(entry.blockId).toBeUndefined();
  });

  it('off-site with a non-https url → no externalUrl (guard), still resolvable to the detail', () => {
    const entry = toRecentAppFromListing(
      card({
        kind: 'offsite',
        kindData: { kind: 'offsite', subKind: 'external-link', externalUrl: 'http://ext.app' },
      })
    );
    expect(entry.externalUrl).toBeUndefined();
    expect(getRecentRailTarget(resolveRecentApp(entry)!, { canOpenPage: true })).toEqual({
      href: '/apps/store-preview/my-app',
      external: false,
    });
  });
});

describe('selectChromeRecentApps — the app-chrome "Recently run" menu', () => {
  /**
   * 🔴 THE DEAD-LINK GATE. The menu's ONLY link shape is `/apps/run/<blockId>`,
   * and that route 404s fail-closed for a viewer without `appBlocksPages`
   * (`src/pages/apps/run/[slug]/[[...path]].tsx` gates on
   * `features.appBlocks && features.appBlocksPages`).
   *
   * Both writers that feed the menu record ON-SITE `{hasPage:true}` entries
   * WITHOUT consulting that flag — the detail page's "Open live" CTA
   * (`AppListingDetailBody` → `toRecentAppFromListing`) and the legacy
   * `MarketplaceBody.recordRecent`. So a viewer with the flag dark can hold a
   * full store of entries that are individually well-formed and uniformly
   * un-openable. Without this gate the menu offers every one of them.
   */
  it('canOpenPage:false → NOTHING is offered (every /apps/run link would 404)', () => {
    const entries = [onsite(), onsite({ id: 'ab_2', blockId: 'other', slug: 'other' })];
    expect(selectChromeRecentApps(entries, { canOpenPage: false, limit: 5 })).toEqual([]);
  });

  it('canOpenPage:true → the same on-site entries ARE offered', () => {
    const entries = [onsite(), onsite({ id: 'ab_2', blockId: 'other', slug: 'other' })];
    expect(
      selectChromeRecentApps(entries, { canOpenPage: true, limit: 5 }).map((r) => r.blockId)
    ).toEqual(['gen-matrix', 'other']);
  });

  it('excludes the app currently being viewed (nothing to return to)', () => {
    const entries = [onsite(), onsite({ id: 'ab_2', blockId: 'other', slug: 'other' })];
    expect(
      selectChromeRecentApps(entries, {
        canOpenPage: true,
        currentAppBlockId: 'ab_1',
        limit: 5,
      }).map((r) => r.id)
    ).toEqual(['ab_2']);
  });

  it('excludes off-site entries — and an off-site one carrying a stray blockId', () => {
    // The second is what a hand-edited localStorage produces: it would link to
    // `/apps/run/<someone-elses-block>`, i.e. the WRONG app, not just a 404.
    const entries = [offsite(), offsite({ id: 'lst_2', blockId: 'gen-matrix' }), onsite()];
    expect(
      selectChromeRecentApps(entries, { canOpenPage: true, limit: 5 }).map((r) => r.id)
    ).toEqual(['ab_1']);
  });

  it('drops an on-site entry with no blockId (it would render /apps/run/undefined)', () => {
    const entries = [onsite({ id: 'ab_3', blockId: undefined, slug: 'slug-only' }), onsite()];
    expect(
      selectChromeRecentApps(entries, { canOpenPage: true, limit: 5 }).map((r) => r.id)
    ).toEqual(['ab_1']);
  });

  it('caps at `limit`, newest-first (the store already prepends)', () => {
    const entries = Array.from({ length: 9 }, (_, i) =>
      onsite({ id: `ab_${i}`, blockId: `app-${i}`, slug: `app-${i}` })
    );
    expect(
      selectChromeRecentApps(entries, { canOpenPage: true, limit: 5 }).map((r) => r.blockId)
    ).toEqual(['app-0', 'app-1', 'app-2', 'app-3', 'app-4']);
  });

  /**
   * 🔴 A GATE NOTHING CALLS IS NOT A GATE. Everything above tests the function
   * in isolation; none of it would fail if `AppBlockChrome` went back to
   * filtering inline, or if the fail-closed default flipped. The only test that
   * exercises the real menu lives in the browser (`component`) project, which
   * CI does not run — so the wiring is pinned HERE, structurally, in the suite
   * that does run.
   */
  describe('AppBlockChrome is actually WIRED to this gate', () => {
    const SRC = path.resolve(__dirname, '../../..');
    /** Read a source file with comments stripped — the files' own prose names
     *  every symbol here repeatedly, and matching that would scope these
     *  assertions to a doc-comment instead of to code. */
    const readCode = (rel: string) =>
      fs
        .readFileSync(path.join(SRC, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');

    const source = readCode('components/AppBlocks/IframeHost.tsx');

    it('builds its "Recently run" list through selectChromeRecentApps', () => {
      expect(source).toMatch(/selectChromeRecentApps\(/);
    });

    it('🔴 canOpenPage FAILS CLOSED — the prop defaults to false, never true', () => {
      // A caller that cannot prove the viewer passed the `appBlocksPages` gate
      // must get no `/apps/run/` links. Flipping this default silently re-opens
      // the dead-link path for every such caller at once.
      expect(source).toMatch(/canOpenPage\s*=\s*false/);
      expect(source).not.toMatch(/canOpenPage\s*=\s*true/);
    });

    it('🔴 PageBlockHost FAILS CLOSED TOO — the forwarding default is false, never true', () => {
      // Both links of the chain default the prop, and only one of them used to
      // be covered here. `PageBlockHost` is what three of the four chrome
      // surfaces mount through, so flipping ITS default to true re-opens
      // guaranteed-404 links on all three at once with the check above still
      // green.
      const host = readCode('components/AppBlocks/PageBlockHost.tsx');
      expect(host).toMatch(/canOpenPage\s*=\s*false/);
      expect(host).not.toMatch(/canOpenPage\s*=\s*true/);
      // …and it really forwards it to the chrome (a default nothing passes on
      // is not a gate).
      expect(host).toMatch(/<AppBlockChrome[\s\S]{0,400}?canOpenPage=\{canOpenPage\}/);
    });

    it('has no second, ungated source of /apps/run/ hrefs in the chrome', () => {
      // The menu's links must come from the gated list, so the only `/apps/run/`
      // template in the file is the one indexed by a ChromeRecentApp blockId.
      const runHrefs = [...source.matchAll(/`\/apps\/run\/\$\{([^}]+)\}`/g)].map((m) =>
        m[1].trim()
      );
      expect(runHrefs).toEqual(['r.blockId']);
    });
  });

  /**
   * 🔴 THE OPT-IN IS PINNED BY NOTHING UNLESS THE POPULATION IS ENUMERATED.
   *
   * The gate above only proves the DEFAULT is closed. The bug that actually
   * shipped was the mirror image: three of the four surfaces that mount the
   * chrome passed nothing, so the fail-closed default silently removed
   * "Recently run" for every viewer on the model slot, mod review and the dev
   * tunnel — with every existing test green, because deleting the opt-in from
   * the one wired surface broke no assertion either.
   *
   * A hardcoded list of "the four known mounters" would not have caught it (it
   * IS the thing that was wrong), so this DISCOVERS the mounters by scanning
   * the tree and asserts the invariant over whatever it finds:
   *
   *   - every non-test mount of `<AppBlockChrome` / `<PageBlockHost` passes a
   *     `canOpenPage` prop, and
   *   - every mount OUTSIDE the two host modules sources it from the viewer's
   *     flags — not a per-surface constant.
   *
   * The second half is the design fix: what gates the SURFACE (the dev tunnel's
   * `isAppBlocksDevTunnelEnabled`, the reviewer check on mod review) is a
   * different question from what gates the LINK TARGET, and only the latter
   * matters — the menu always points at `/apps/run/<blockId>`, whose own
   * `getServerSideProps` 404s unless `appBlocks && appBlocksPages` for every
   * viewer regardless of where they came from. So the predicate is uniform and
   * is the FULL conjunction: `appBlocksPages` alone is only half of it, and
   * because `appBlocks` is the block-runtime kill-switch (and Flipt overrides
   * disable as well as enable) pages-on/blocks-off is a reachable state in which
   * every one of those links 404s. All four surfaces do also carry their own
   * `appBlocks` check today (the run page and review preview in
   * `getServerSideProps`, the model slot in `BlockSlot`, the dev tunnel in its
   * own SSR gate), so the one-flag form was not a live bug — but it made this
   * gate depend on an invariant held in four other functions, which is the same
   * distant coupling that produced the original defect.
   *
   * SCOPE — deliberately narrow: this scans only the two chrome-bearing hosts,
   * not every `canOpenPage` consumer. `AppBlockCard`, `AppListingCard`,
   * `AppListingDetailBody`, `MySubmissionsList`, `MarketplaceBody` and
   * `RecentlyOpenedApps` also take the prop and are all fail-closed and wired
   * today, but they still pass the one-flag `!!features.appBlocksPages` form, so
   * a single uniform assertion across the whole population would be wrong right
   * now. Widening the scan is tracked as a follow-up together with converting
   * those surfaces to the conjunction; until then this guard covers the mounts
   * that lost their opt-in outright, which is the defect that shipped.
   */
  describe('every chrome mounter opts in from the run-route flags', () => {
    const SRC = path.resolve(__dirname, '../../..');
    /** The two modules that declare the prop; both must appear in the scan. */
    const HOST_MODULES = [
      'components/AppBlocks/IframeHost.tsx',
      'components/AppBlocks/PageBlockHost.tsx',
    ];
    /** The ONLY module allowed to pass something other than the flags: it is a
     *  pure forwarder of its own `canOpenPage` prop (asserted above). Note
     *  `IframeHost.tsx` is NOT exempt — the model slot is a real surface and
     *  must read the flags like every other one. */
    const FORWARDER = 'components/AppBlocks/PageBlockHost.tsx';
    const MOUNT = /<(?:AppBlockChrome|PageBlockHost)\b/g;

    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.tsx') && !/\.test\.tsx$/.test(entry.name)) out.push(full);
      }
      return out;
    }

    /**
     * Blank the CONTENTS of every comment, string and template literal
     * (preserving offsets and line breaks) so that no `<PageBlockHost` inside a
     * doc comment or a string can be mistaken for a mount, and no `>` inside one
     * can terminate a real one. Replaces the old two-regex comment strip, which
     * shifted every offset after it and could itself be fooled by a
     * block-comment opener sitting inside a string literal.
     */
    function maskNonCode(code: string): string {
      const out = code.split('');
      const blank = (from: number, to: number) => {
        for (let i = Math.max(from, 0); i < Math.min(to, out.length); i++) {
          if (out[i] !== '\n') out[i] = ' ';
        }
      };
      let i = 0;
      while (i < code.length) {
        const ch = code[i];
        const next = code[i + 1];
        if (ch === '/' && next === '/') {
          const nl = code.indexOf('\n', i);
          const end = nl === -1 ? code.length : nl;
          blank(i, end);
          i = end;
        } else if (ch === '/' && next === '*') {
          const close = code.indexOf('*/', i + 2);
          const end = close === -1 ? code.length : close + 2;
          blank(i, end);
          i = end;
        } else if (ch === '"' || ch === "'" || ch === '`') {
          let j = i + 1;
          while (j < code.length) {
            if (code[j] === '\\') j += 2;
            else if (code[j] === ch) break;
            else j++;
          }
          blank(i + 1, j); // keep the delimiters, blank the body
          i = j + 1;
        } else i++;
      }
      return out.join('');
    }

    /**
     * The OPENING TAG of the JSX element starting at `idx` — from its `<`
     * through the `>` that closes that tag, excluding children and siblings.
     *
     * 🔴 The bound is the entire point, and it can fail in BOTH directions:
     *   - too LOOSE and a `canOpenPage` appearing anywhere later satisfies the
     *     check. Two ways that happens: `PageBlockHost.tsx` mentions the prop in
     *     its own prop list, and — the one that actually bit — a non-compliant
     *     mount inherits the NEXT SIBLING's compliant props. Either is a false
     *     GREEN over the exact defect this guard exists to catch.
     *   - too TIGHT and a legitimate mount reads as non-compliant: a false RED.
     *
     * A newline-anchored terminator (`/>` alone on its own line) gets both
     * wrong, because that shape is a formatting accident rather than a property
     * of JSX: a single-line `<PageBlockHost {...props} />`, or a mount nested
     * inside a JSX prop, has no such line, so the scan runs straight past it.
     * Verified 2026-07-31 with a throwaway probe — a probe component whose
     * single-line mount passed NO `canOpenPage`, followed by a compliant
     * sibling, was fully green under the old bound.
     *
     * So walk characters instead of matching a shape: count `{}` depth (which
     * is where nested JSX, arrow bodies and `a > b` comparisons live) and stop
     * at the first `>` at depth 0. Strings/comments are already masked out by
     * `maskNonCode`, so they cannot contribute a spurious brace or `>`.
     */
    function elementAt(code: string, idx: number): string {
      let depth = 0;
      for (let i = idx + 1; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '>' && depth === 0) return code.slice(idx, i + 1);
      }
      return code.slice(idx); // unterminated tag — let the assertions fail loudly
    }

    /** Every non-test .tsx that renders one of the two chrome-bearing hosts. */
    const files = walk(path.join(SRC, 'components')).concat(walk(path.join(SRC, 'pages')));
    const scanned = files.map((file) => {
      const raw = fs.readFileSync(file, 'utf8');
      const code = maskNonCode(raw);
      return {
        rel: path.relative(SRC, file).split(path.sep).join('/'),
        raw,
        code,
        elements: [...code.matchAll(MOUNT)].map((hit) => elementAt(code, hit.index ?? 0)),
      };
    });
    const mounters = scanned.filter((m) => m.elements.length > 0);

    it('the extractor is bounded to ONE opening tag (the false green that shipped)', () => {
      // A direct test of the helper, because every assertion below is only as
      // honest as this bound. Each fixture is a mount that passes NOTHING,
      // followed by a compliant sibling; a correct bound never sees the sibling.
      const sibling = '\n      <PageBlockHost canOpenPage={!!features.appBlocksPages} />\n';
      const shapes: Record<string, string> = {
        'single-line self-closing': '<PageBlockHost {...props} />',
        'multi-line': '<PageBlockHost\n        blockId={id}\n        slug={slug}\n      />',
        'spread props only': '<PageBlockHost {...chromeProps} />',
        'nested in a JSX prop': '<Wrapper render={<PageBlockHost {...props} />} />',
        'children, not self-closing': '<PageBlockHost blockId={id}>{kids}</PageBlockHost>',
        'expression containing >': '<PageBlockHost show={a > b} on={() => go()} />',
      };
      for (const [label, jsx] of Object.entries(shapes)) {
        const code = maskNonCode(`<div>\n      ${jsx}${sibling}    </div>`);
        const first = code.indexOf('<PageBlockHost');
        expect(elementAt(code, first), label).not.toMatch(/canOpenPage/);
      }
      // …and it does not under-read: the prop IS found when the mount carries it.
      const compliant = maskNonCode(
        `<PageBlockHost {...p} canOpenPage={!!features.appBlocksPages} />`
      );
      expect(elementAt(compliant, 0)).toMatch(/canOpenPage=\{!!features\.appBlocksPages\}/);
      // A tag name inside a string literal is NOT a mount (false-red guard).
      expect(maskNonCode(`const s = '<PageBlockHost />';`)).not.toMatch(/<PageBlockHost/);
    });

    it('found the mount sites (the scan itself must not silently match nothing)', () => {
      // Without this, every assertion below would pass vacuously if the walk
      // broke, the components were renamed, or the roots moved. The floor is
      // deliberately BELOW the live count (5 as of 2026-07-31: the two host
      // modules + run page + dev tunnel + review preview) so that legitimately
      // retiring one surface does not red the guard with no bug — the
      // HOST_MODULES check below is what makes it non-vacuous, since those two
      // are structural rather than a headcount.
      expect(mounters.length).toBeGreaterThanOrEqual(3);
      expect(mounters.map((m) => m.rel)).toEqual(expect.arrayContaining(HOST_MODULES));
      // Masking must not SWALLOW a mount site: any file whose raw text names one
      // of the tags has to survive into the scan. This is the failure mode that
      // would otherwise turn a lexer bug into silence rather than a red.
      const swallowed = scanned
        .filter((m) => /<(?:AppBlockChrome|PageBlockHost)\b/.test(m.raw) && m.elements.length === 0)
        .map((m) => m.rel);
      expect(swallowed).toEqual([]);
    });

    it('🔴 every chrome/host mount passes canOpenPage — none may rely on the default', () => {
      const missing = mounters
        .filter((m) => m.elements.some((el) => !/\bcanOpenPage\b/.test(el)))
        .map((m) => m.rel);
      expect(missing).toEqual([]);
    });

    it('🔴 every mount but the forwarder sources it from BOTH run-route flags', () => {
      const PREDICATE = /canOpenPage=\{!!\(features\.appBlocks && features\.appBlocksPages\)\}/;
      const offenders = mounters
        .filter((m) => m.rel !== FORWARDER)
        .filter((m) => m.elements.some((el) => !PREDICATE.test(el)))
        .map((m) => m.rel);
      // Two ways to fail here, both real:
      //   - a per-surface constant (`canOpenPage` / `={true}` / `={false}`) —
      //     the link target is gated on the VIEWER, so the predicate cannot vary
      //     by surface;
      //   - `!!features.appBlocksPages` alone — half the route's predicate. The
      //     run route 404s unless BOTH flags are on, and `appBlocks` is the
      //     block-runtime kill-switch, so the one-flag form is only correct for
      //     as long as every mounting surface keeps its own `appBlocks` check.
      //     That is true today; pinning the conjunction here is what stops it
      //     from becoming a live bug the moment one of them stops being true.
      expect(offenders).toEqual([]);
    });
  });
});

/**
 * `getRecentRailAction` — the rail tile's icon CTA (added with the tile's
 * interaction pass). DERIVED from `getRecentRailTarget` rather than re-deciding,
 * so a play glyph labelled "Open" can never point at a detail page: that would be
 * a lie in the button's ACCESSIBLE NAME, not merely a cosmetic mismatch.
 */
describe('getRecentRailAction', () => {
  const onsite = (over: Partial<Parameters<typeof getRecentRailAction>[0]> = {}) => ({
    id: 'ab_1',
    slug: 'gen-matrix',
    blockId: 'gen-matrix',
    kind: 'onsite' as const,
    hasPage: true,
    name: 'Gen Matrix',
    ...over,
  });

  it('an on-site page app the viewer CAN run → open', () => {
    expect(getRecentRailAction(onsite(), { canOpenPage: true })).toEqual({
      action: 'open',
      label: 'Open Gen Matrix',
    });
  });

  it('the pages flag dark → view (matches the detail fallback, never a 404 "Open")', () => {
    expect(getRecentRailAction(onsite(), { canOpenPage: false })).toEqual({
      action: 'view',
      label: 'View details for Gen Matrix',
    });
  });

  it('an on-site app with no page → view', () => {
    expect(getRecentRailAction(onsite({ hasPage: false }), { canOpenPage: true }).action).toBe(
      'view'
    );
  });

  it('an off-site entry with a usable url → visit', () => {
    expect(
      getRecentRailAction(
        {
          id: 'lst_1',
          slug: 'ext-app',
          kind: 'offsite',
          hasPage: false,
          externalUrl: 'https://ext.example/app',
          name: 'Ext App',
        },
        { canOpenPage: true }
      )
    ).toEqual({ action: 'visit', label: 'Visit Ext App' });
  });

  it('an off-site entry with NO url falls back to view, matching its target', () => {
    expect(
      getRecentRailAction(
        { id: 'lst_2', slug: 'ext-app', kind: 'offsite', hasPage: false, name: 'Ext App' },
        { canOpenPage: true }
      ).action
    ).toBe('view');
  });

  it('falls back to the slug when the entry has no name', () => {
    expect(getRecentRailAction(onsite({ name: undefined }), { canOpenPage: true }).label).toBe(
      'Open gen-matrix'
    );
  });

  it('🔴 NEVER disagrees with getRecentRailTarget, across the whole matrix', () => {
    // The coupling, asserted directly rather than by inspection: `visit` iff the
    // target is external, `open` iff the target is the run route. A future edit
    // that changes one function's branching and not the other's fails here.
    for (const kind of ['onsite', 'offsite'] as const)
      for (const hasPage of [true, false])
        for (const canOpenPage of [true, false])
          for (const externalUrl of [undefined, 'https://ext.example/app']) {
            const entry = {
              id: 'x',
              slug: 'app',
              blockId: 'app',
              kind,
              hasPage,
              ...(externalUrl ? { externalUrl } : {}),
            };
            const target = getRecentRailTarget(entry, { canOpenPage });
            const { action } = getRecentRailAction(entry, { canOpenPage });
            expect(action === 'visit').toBe(target.external);
            expect(action === 'open').toBe(target.href.startsWith('/apps/run/'));
          }
  });
});

/**
 * RECONCILIATION — repairing persisted recents from the loaded listings.
 *
 * The defect: `resolveRecentApp` reads a MISSING `hasPage` as `false`, so the
 * legacy `{id, blockId, name, iconUrl}` entries `MarketplaceBody.recordRecent`
 * wrote render an EYE at `/apps/store-preview/<slug>` for apps the viewer runs.
 * A real viewer's localStorage had 7 of 8 entries in that shape.
 */
describe('reconcileRecentApps', () => {
  const onsiteCard = (over: Partial<ListingCard> = {}): ListingCard =>
    ({
      id: 'lst_gm',
      slug: 'gen-matrix',
      kind: 'onsite',
      name: 'Gen Matrix',
      tagline: null,
      category: null,
      contentRating: null,
      iconUrl: null,
      coverUrl: null,
      creator: null,
      recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
      reviewCount: 0,
      kindData: {
        kind: 'onsite',
        appBlockId: 'ab_gm',
        hasPage: true,
        liveUrl: 'https://gen-matrix.civit.ai',
      },
      ...over,
    } as ListingCard);

  /** The EXACT legacy shape: no `kind`, no `hasPage`, no `slug`. */
  const legacy = (over: Partial<RecentApp> = {}): RecentApp => ({
    id: 'ab_gm',
    blockId: 'gen-matrix',
    name: 'Gen Matrix',
    ...over,
  });

  it('🔴 upgrades a {id, blockId} legacy entry from the matching card', () => {
    const [out] = reconcileRecentApps([legacy()], [onsiteCard()]);
    expect(out).toEqual({
      id: 'ab_gm',
      slug: 'gen-matrix',
      blockId: 'gen-matrix',
      kind: 'onsite',
      hasPage: true,
      name: 'Gen Matrix',
    });
  });

  it('🔴 THE WHOLE POINT: that entry now derives a PLAY action, not an eye', () => {
    // The end-to-end read, through the real resolver + the real action
    // derivation — the icon, the href and the accessible label all come from
    // here, so this is the assertion that maps to what a viewer sees.
    const before = resolveRecentApp(legacy())!;
    expect(getRecentRailAction(before, { canOpenPage: true })).toEqual({
      action: 'view',
      label: 'View details for Gen Matrix',
    });

    const [reconciled] = reconcileRecentApps([legacy()], [onsiteCard()]);
    const after = resolveRecentApp(reconciled)!;
    expect(getRecentRailAction(after, { canOpenPage: true })).toEqual({
      action: 'open',
      label: 'Open Gen Matrix',
    });
    expect(getRecentRailTarget(after, { canOpenPage: true }).href).toBe('/apps/run/gen-matrix');
  });

  it('🔴 NEVER DROPS an unmatched entry — it is returned untouched', () => {
    const stranger = legacy({ id: 'ab_pv', blockId: 'prompt-vault', name: 'Prompt Vault' });
    const out = reconcileRecentApps([stranger], [onsiteCard()]);
    expect(out).toHaveLength(1);
    // Same VALUE and same reference: an unmatched entry is not rebuilt at all.
    expect(out[0]).toBe(stranger);
  });

  it('🔴 CORRECTS DOWN too — a stale hasPage:true loses its page when the card says so', () => {
    // The mutation-sensitive direction. A `entry.hasPage ?? card.hasPage`
    // implementation passes every test above and fails this one, having left the
    // rail offering a guaranteed-404 `/apps/run/…` under an "Open" label.
    const stale = onsite({ id: 'ab_gm', blockId: 'gen-matrix', slug: 'gen-matrix', hasPage: true });
    const [out] = reconcileRecentApps(
      [stale],
      [
        onsiteCard({
          kindData: {
            kind: 'onsite',
            appBlockId: 'ab_gm',
            hasPage: false,
            liveUrl: 'https://gen-matrix.civit.ai',
          },
        }),
      ]
    );
    expect(out.hasPage).toBe(false);
    expect(getRecentRailTarget(resolveRecentApp(out)!, { canOpenPage: true }).href).toBe(
      '/apps/store-preview/gen-matrix'
    );
  });

  it('🔴 matches on blockId→card.slug when the id matches NOTHING', () => {
    // 🔴 THE KEY THIS FIX TURNS ON. Every other test here happens to have an
    // `id` equal to the card's `appBlockId`, so they ALL pass with the
    // `blockId`→`slug` lookup deleted — they would certify a reconcile that
    // cannot join the one shape the defect is made of. This entry's `id` matches
    // no card by either id namespace, so ONLY the blockId→slug path can upgrade
    // it, and deleting that path fails exactly here.
    //
    // The join works because for an ON-SITE app the AppListing slug IS the
    // AppBlock `block_id` (`app-listing-mapper.ts` → `slug: ab.blockId`). Note the
    // card side of the join is `card.slug`; the ENTRY side is `blockId`, because a
    // legacy entry HAS no `slug` — keying both sides on `slug` matches zero rows.
    const [out] = reconcileRecentApps(
      [{ id: 'legacy-key-that-matches-no-card', blockId: 'gen-matrix', name: 'Gen Matrix' }],
      [onsiteCard()]
    );
    expect(out.hasPage).toBe(true);
    expect(out.kind).toBe('onsite');
    expect(out.slug).toBe('gen-matrix');
    // …and the id is still NOT rewritten, even on a slug-path match.
    expect(out.id).toBe('legacy-key-that-matches-no-card');
  });

  it('matches on the AppBlock id when the entry has no blockId', () => {
    const out = reconcileRecentApps([{ id: 'ab_gm', slug: 'gen-matrix' }], [onsiteCard()]);
    expect(out[0].hasPage).toBe(true);
  });

  it('🔴 the appBlockId join carries an entry whose recorded slug is STALE', () => {
    // The case that makes the `entry.id → card.kindData.appBlockId` lookup
    // load-bearing rather than redundant. Every other fixture's `blockId` already
    // equals the card `slug`, so they all still reconcile with that join deleted.
    // Here the app's `block_id` has MOVED since the entry was written, so the
    // slug join misses and only the AppBlock id — the store's de-dup key, and the
    // one identifier both on-site writers agree on — can still find the card.
    const [out] = reconcileRecentApps(
      [{ id: 'ab_gm', blockId: 'the-old-block-id', name: 'Gen Matrix' }],
      [onsiteCard()]
    );
    expect(out.hasPage).toBe(true);
    // …and the STALE handle is replaced by the card's current one, so the tile
    // links to where the app lives now rather than to a 404.
    expect(out.slug).toBe('gen-matrix');
    expect(out.blockId).toBe('gen-matrix');
  });

  it('🔴 an unmatched entry is passed through byte-for-byte, not rebuilt', () => {
    // Guards the pass-through against a mutation that RETURNS something for an
    // unmatched entry instead of the entry itself. Asserted on a list where the
    // unmatched entry is NOT the first element, so a `return entries[0]`-shaped
    // bug cannot coincidentally return the right object.
    const matched = legacy();
    const unmatched: RecentApp = { id: 'ab_pv', blockId: 'prompt-vault', name: 'Prompt Vault' };
    const out = reconcileRecentApps([matched, unmatched], [onsiteCard()]);
    expect(out[1]).toBe(unmatched);
    expect(out[1]).toEqual({ id: 'ab_pv', blockId: 'prompt-vault', name: 'Prompt Vault' });
    // No `kind`/`hasPage` invented for an app we know nothing about.
    expect(out[1].kind).toBeUndefined();
    expect(out[1].hasPage).toBeUndefined();
  });

  it('matches an OFF-SITE entry on the listing id, and strips a stray blockId', () => {
    // A stray `blockId` on an off-site entry would point the app-chrome
    // "Recently run" menu at a DIFFERENT app (`selectChromeRecentApps` filters on
    // `!!blockId`), so reconciliation must remove it, not merge around it.
    const card = onsiteCard({
      id: 'lst_ext',
      slug: 'ext-app',
      kind: 'offsite',
      name: 'Ext App',
      kindData: { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://ext.example/a' },
    });
    const [out] = reconcileRecentApps([{ id: 'lst_ext', blockId: 'stale-block' }], [card]);
    expect(out.blockId).toBeUndefined();
    expect(out).toMatchObject({
      kind: 'offsite',
      slug: 'ext-app',
      externalUrl: 'https://ext.example/a',
    });
    expect(selectChromeRecentApps([out], { canOpenPage: true, limit: 6 })).toEqual([]);
  });

  it('keeps the entry id — the de-dup key must not churn', () => {
    // `id` is the store's de-dup key AND the rail's ordering handle. Rewriting it
    // could split one app into two entries or collide with another.
    const [out] = reconcileRecentApps([legacy({ id: 'ab_gm' })], [onsiteCard()]);
    expect(out.id).toBe('ab_gm');
  });

  it('preserves a recorded iconUrl the card cannot supply', () => {
    const [out] = reconcileRecentApps(
      [legacy({ iconUrl: 'https://cdn.example/old.png' })],
      [onsiteCard({ iconUrl: null })]
    );
    expect(out.iconUrl).toBe('https://cdn.example/old.png');
  });

  it('is IDEMPOTENT — reconciling a reconciled list changes nothing', () => {
    const once = reconcileRecentApps([legacy()], [onsiteCard()]);
    expect(reconcileRecentApps(once, [onsiteCard()])).toEqual(once);
  });

  it('is a no-op with no cards loaded (the query has not resolved yet)', () => {
    const entries = [legacy()];
    expect(reconcileRecentApps(entries, [])).toBe(entries);
  });

  it('preserves order and length across a mixed list', () => {
    const entries = [legacy({ id: 'ab_pv', blockId: 'prompt-vault' }), legacy()];
    const out = reconcileRecentApps(entries, [onsiteCard()]);
    expect(out.map((e) => e.id)).toEqual(['ab_pv', 'ab_gm']);
  });

  it('🔴 an OFF-SITE entry does NOT consult the slug join — it would heal to the WRONG app', () => {
    // An off-site listing has no AppBlock, so its `blockId` names nothing. No
    // writer produces this shape today, but `coerce` accepts it, so a future one
    // reopens the hole. Every value here is pairwise distinct EXCEPT the
    // collision under test: the entry's stray `blockId` equals the ON-SITE
    // card's slug, and the entry's own listing is not on the loaded pages.
    const ghost: RecentApp = {
      id: 'lst_ghost',
      kind: 'offsite',
      blockId: 'gen-matrix', // ← the collision: an on-site card's slug
      slug: 'ghost-app',
      name: 'Ghost App',
      externalUrl: 'https://ghost.example/a',
    };
    const out = reconcileRecentApps([ghost], [onsiteCard()]);

    // Untouched — not merged, not partially overwritten, not rebuilt.
    expect(out[0]).toBe(ghost);
    // The specific harm the gate prevents: taking the other app's identity.
    expect(out[0].slug).toBe('ghost-app');
    expect(out[0].name).toBe('Ghost App');
    expect(out[0].kind).toBe('offsite');
    // …and therefore never offering the on-site app's run link under this tile.
    const resolved = resolveRecentApp(out[0])!;
    expect(getRecentRailTarget(resolved, { canOpenPage: true }).href).toBe(
      'https://ghost.example/a'
    );
  });

  /**
   * 🔴 MONOTONIC HEALING. Everything above reconciles against ONE card set. The
   * caller's card set is filter- and page-scoped (`listAvailable` is keyed on
   * `{kind, category, sort, limit}` with no `keepPreviousData`), so it EMPTIES on
   * every sort/filter change and NARROWS whenever the viewer's app is on page 2
   * or behind the active filter. These pin that neither can un-heal a tile.
   */
  describe('the `healed` memo — a match is a one-way ratchet across renders', () => {
    /** The action a viewer sees for `entry`, through the real resolver. */
    const actionOf = (entry: RecentApp) =>
      getRecentRailAction(resolveRecentApp(entry)!, { canOpenPage: true }).action;

    it('🔴 a healed entry SURVIVES the card set emptying (the sort/filter flip)', () => {
      const healed: RecentHealMemo = new Map();
      const [first] = reconcileRecentApps([legacy()], [onsiteCard()], healed);
      expect(first).toMatchObject({ kind: 'onsite', hasPage: true, slug: 'gen-matrix' });

      // The viewer changed `sort`. `data` goes undefined, so the caller passes
      // []. WITHOUT the memo the `cards.length === 0` early return hands back the
      // raw legacy entry and the tile reverts to an eye.
      const [second] = reconcileRecentApps([legacy()], [], healed);
      expect(second).toEqual(first);
      expect(actionOf(second)).toBe('open');
    });

    it('🔴 THE ROUND-TRIP THE VIEWER SEES: play→eye→play never happens', () => {
      const healed: RecentHealMemo = new Map();
      const step = (cards: ListingCard[]) =>
        actionOf(reconcileRecentApps([legacy()], cards, healed)[0]);

      expect(step([])).toBe('view'); // first paint — the query has not resolved
      expect(step([onsiteCard()])).toBe('open'); // heals
      expect(step([])).toBe('open'); // sort change — pre-fix this was 'view'
      expect(step([onsiteCard()])).toBe('open'); // the new page resolves
    });

    it('🔴 …and the card set merely NARROWING cannot un-heal either (page 2 / filtered out)', () => {
      // Distinct from the empty case above: here cards ARE loaded, just not this
      // app's, so no early return is involved — the entry simply matches nothing.
      const healed: RecentHealMemo = new Map();
      const other = onsiteCard({
        id: 'lst_pv',
        slug: 'prompt-vault',
        name: 'Prompt Vault',
        kindData: {
          kind: 'onsite',
          appBlockId: 'ab_pv',
          hasPage: false,
          liveUrl: 'https://prompt-vault.civit.ai',
        },
      });
      reconcileRecentApps([legacy()], [onsiteCard()], healed);
      const [out] = reconcileRecentApps([legacy()], [other], healed);
      expect(actionOf(out)).toBe('open');
      expect(out.slug).toBe('gen-matrix');
      // Emphatically NOT the other app's identity.
      expect(out.name).toBe('Gen Matrix');
    });

    it('🔴 a MATCH still BEATS the memo — correcting DOWN survives monotonicity', () => {
      // The mutation-sensitive direction. An implementation where the memo wins
      // passes every test above and fails this one, having pinned a play glyph on
      // an app that has since lost its page — a guaranteed 404 under "Open".
      const healed: RecentHealMemo = new Map();
      reconcileRecentApps([legacy()], [onsiteCard()], healed);
      const lostItsPage = onsiteCard({
        kindData: {
          kind: 'onsite',
          appBlockId: 'ab_gm',
          hasPage: false,
          liveUrl: 'https://gen-matrix.civit.ai',
        },
      });
      const [out] = reconcileRecentApps([legacy()], [lostItsPage], healed);
      expect(out.hasPage).toBe(false);
      expect(actionOf(out)).toBe('view');
    });

    it('🔴 THE BOUND: the memo holds one value per RECENTS entry, never the catalog', () => {
      // 50 filter changes, each loading a different page of cards. If the
      // implementation accumulated CARDS this would grow without limit.
      const healed: RecentHealMemo = new Map();
      const entries = [legacy(), legacy({ id: 'ab_pv', blockId: 'prompt-vault' })];
      for (let i = 0; i < 50; i++) {
        const page = onsiteCard({
          id: `lst_${i}`,
          slug: `app-${i}`,
          kindData: {
            kind: 'onsite',
            appBlockId: `ab_${i}`,
            hasPage: true,
            liveUrl: 'https://x.civit.ai',
          },
        });
        reconcileRecentApps(entries, [page, onsiteCard()], healed);
        expect(healed.size).toBeLessThanOrEqual(entries.length);
      }
      // Only the entry that actually matched is remembered — one, not 51.
      expect([...healed.keys()]).toEqual(['ab_gm']);
    });

    it('🔴 THE BOUND: an id the recents no longer contain is DROPPED, not retained', () => {
      const healed: RecentHealMemo = new Map();
      reconcileRecentApps([legacy()], [onsiteCard()], healed);
      expect([...healed.keys()]).toEqual(['ab_gm']);

      // The viewer ran 8 other apps; `ab_gm` rolled off the capped store. It can
      // never be consulted again, so keeping it is pure leak.
      reconcileRecentApps([legacy({ id: 'ab_pv', blockId: 'prompt-vault' })], [], healed);
      expect(healed.has('ab_gm')).toBe(false);
      expect(healed.size).toBe(0);
    });

    it('the memo is only ever WRITTEN from a card — an unmatched entry seeds nothing', () => {
      const healed: RecentHealMemo = new Map();
      reconcileRecentApps(
        [legacy({ id: 'ab_pv', blockId: 'prompt-vault' })],
        [onsiteCard()],
        healed
      );
      expect(healed.size).toBe(0);
    });

    it('OMITTING the memo is exactly the old behaviour (the 2-arg calls above still hold)', () => {
      // Invariant guard, not a regression test: it pins that adding the
      // parameter changed nothing for a caller that does not pass it.
      const entries = [legacy()];
      expect(reconcileRecentApps(entries, [])).toBe(entries);
      expect(reconcileRecentApps(entries, [onsiteCard()])).toEqual(
        reconcileRecentApps(entries, [onsiteCard()], new Map())
      );
    });
  });

  /**
   * 🔴 The memo is an OPTIONAL parameter, so the un-healing bug is one deleted
   * argument away and would pass every test above. This scans the one production
   * call site, the same way the chrome-mount gate is scanned earlier in this file.
   */
  describe('the /apps store is actually WIRED to the monotonic form', () => {
    const source = fs
      .readFileSync(
        path.resolve(__dirname, '../../..', 'components/Apps/AppListingsMarketplaceBody.tsx'),
        'utf8'
      )
      // Strip comments — that file's prose names these symbols repeatedly, and
      // matching prose would scope the assertion to a doc-comment, not to code.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    it('found the call site (the scan itself must not silently match nothing)', () => {
      expect(source.length).toBeGreaterThan(1000);
      expect(source).toMatch(/reconcileRecentApps\(/);
    });

    it('🔴 passes a cross-render memo — a two-arg call restores the un-healing bug', () => {
      expect(source).toMatch(/reconcileRecentApps\(\s*recents,\s*items,\s*[A-Za-z0-9_.]+\s*\)/);
    });

    it('🔴 holds that memo in a REF — module state would leak across mounts', () => {
      // `useState`/a module-level Map would either not survive re-render or would
      // outlive the mount and be shared between two stores.
      expect(source).toMatch(/useRef<RecentHealMemo>\(\s*new Map\(\)\s*\)/);
    });
  });
});
