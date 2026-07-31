import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  getRecentRailTarget,
  RECENT_RAIL_LIMIT,
  resolveRecentApp,
  selectChromeRecentApps,
  selectRecentRailEntries,
  toRecentAppFromListing,
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
   * that does run. Same shape of source-level gate as
   * `appListingPreview.test.ts`'s `<iframe sandbox>` check.
   */
  describe('AppBlockChrome is actually WIRED to this gate', () => {
    const SOURCE = path.resolve(__dirname, '../../AppBlocks/IframeHost.tsx');
    // Comments stripped: the file's own prose names both symbols repeatedly, and
    // matching that would scope these assertions to a doc-comment.
    const source = fs
      .readFileSync(SOURCE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

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

    it('has no second, ungated source of /apps/run/ hrefs in the chrome', () => {
      // The menu's links must come from the gated list, so the only `/apps/run/`
      // template in the file is the one indexed by a ChromeRecentApp blockId.
      const runHrefs = [...source.matchAll(/`\/apps\/run\/\$\{([^}]+)\}`/g)].map((m) =>
        m[1].trim()
      );
      expect(runHrefs).toEqual(['r.blockId']);
    });
  });
});
