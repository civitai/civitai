import { describe, expect, it } from 'vitest';
import {
  getRecentRailTarget,
  RECENT_RAIL_LIMIT,
  resolveRecentApp,
  selectRecentRailEntries,
  toRecentAppFromListing,
} from '~/components/Apps/recentAppsRail';
import type { RecentApp } from '~/components/Apps/recentlyOpenedAppsStore';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * "Recently opened" rail view-model — node `unit` project (the BLOCKING gate;
 * the browser component suites are report-only).
 *
 * Pins the three things that can silently break a returning viewer's rail:
 *   1. LEGACY-SHAPE TOLERANCE — a `{id, blockId}` entry written before `slug`
 *      existed still resolves (on-site slug === block_id), and an entry that
 *      genuinely cannot be resolved is DROPPED rather than rendered as a dead
 *      link.
 *   2. DEDUPE + CAP.
 *   3. TARGET selection — never a dead/incorrect nav for any kind × flag combo.
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
    expect(resolveRecentApp({ id: 'x', blockId: 'not-a-listing-slug', kind: 'offsite' })).toBeNull();
  });

  it('an entry with neither slug nor blockId is DROPPED (no dead link)', () => {
    expect(resolveRecentApp({ id: 'x' })).toBeNull();
  });

  it('a slug-only on-site entry resolves and back-fills blockId', () => {
    const resolved = resolveRecentApp({ id: 'x', slug: 'only-slug', kind: 'onsite', hasPage: true });
    expect(resolved).toMatchObject({ slug: 'only-slug', blockId: 'only-slug', hasPage: true });
  });

  it('a non-https off-site externalUrl is dropped by the https guard', () => {
    const resolved = resolveRecentApp(offsite({ externalUrl: 'http://insecure.example' }))!;
    expect(resolved.externalUrl).toBeUndefined();
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

  it('on-site → carries slug, blockId (= slug), kind + hasPage', () => {
    expect(toRecentAppFromListing(card())).toEqual({
      id: 'lst_1',
      slug: 'my-app',
      blockId: 'my-app',
      kind: 'onsite',
      hasPage: true,
      name: 'My App',
      iconUrl: 'https://cdn.example/icon.png',
    });
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
