import { describe, expect, it } from 'vitest';
import { mergeHomeApps } from '~/components/Apps/appsHomeMerge';
import { toRecentAppFromListing } from '~/components/Apps/recentAppsRail';
import {
  parseRecentsForOwner,
  RECENTS_ENVELOPE_VERSION,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedAppsStore';
import type { MyAppRow } from '~/server/services/blocks/my-apps.logic';

/**
 * The `/apps` grid = server apps ∪ this account's local recents. Recents are fed through
 * the store's REAL pure reader (`parseRecentsForOwner`) where owner isolation or corruption
 * is the point, and through the store's REAL writer shape (`toRecentAppFromListing`) where
 * the join key is — so the keys under test are the ones production writes, not hand-typed
 * look-alikes.
 */

const row = (
  over: Partial<MyAppRow> & Pick<MyAppRow, 'listingId' | 'slug' | 'name'>
): MyAppRow => ({
  category: null,
  iconUrl: `https://img.invalid/${over.slug}.png`,
  coverUrl: null,
  kind: 'page',
  launchHref: `/apps/run/${over.slug}`,
  external: false,
  lastUsedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...over,
});

const FORGE = row({ listingId: 'apl_forge', slug: 'pixel-forge', name: 'Pixel Forge' });
const TAGGER = row({ listingId: 'apl_tagger', slug: 'tag-wizard', name: 'Tag Wizard' });
const LAB = row({
  listingId: 'apl_lab',
  slug: 'prompt-lab',
  name: 'Prompt Lab',
  kind: 'offsite',
  launchHref: 'https://promptlab.example.org/app',
  external: true,
});

/** What the store card writes for an on-site listing with a block — the real key shape. */
const recentOnsite = (slug: string, appBlockId: string, name: string): RecentApp =>
  toRecentAppFromListing({
    id: `apl_unused_${slug}`,
    slug,
    name,
    iconUrl: null,
    kindData: { kind: 'onsite', appBlockId, hasPage: true, liveUrl: 'https://x.invalid' },
  });
/** What the store card writes for an off-site listing — id is the LISTING id. */
const recentOffsite = (listingId: string, slug: string, name: string, url: string): RecentApp =>
  toRecentAppFromListing({
    id: listingId,
    slug,
    name,
    iconUrl: null,
    kindData: { kind: 'offsite', externalUrl: url },
  });

const blob = (ownerId: number | null, apps: unknown) =>
  JSON.stringify({ v: RECENTS_ENVELOPE_VERSION, ownerId, apps });

describe('mergeHomeApps', () => {
  it('🔴 dedupes a recents entry against the server row it names — ONE tile, server fields win', () => {
    // The on-site recent carries the AppBlock id as its `id` (never the listing id), so the
    // join has to be the slug. A merge keyed on id alone would show Pixel Forge twice.
    const tiles = mergeHomeApps({
      server: [FORGE, TAGGER],
      recents: [recentOnsite('pixel-forge', 'ab_forge', 'Stale Forge Name')],
      canOpenPage: true,
    });
    expect(tiles.map((t) => [t.key, t.source, t.name])).toEqual([
      ['listing:apl_forge', 'both', 'Pixel Forge'],
      ['listing:apl_tagger', 'server', 'Tag Wizard'],
    ]);
  });

  it('dedupes an OFF-SITE recent by its listing id even if its slug drifted', () => {
    const tiles = mergeHomeApps({
      server: [LAB],
      recents: [
        recentOffsite(
          'apl_lab',
          'prompt-lab-old',
          'Prompt Lab',
          'https://promptlab.example.org/app'
        ),
      ],
      canOpenPage: true,
    });
    expect(tiles.map((t) => t.key)).toEqual(['listing:apl_lab']);
  });

  it('🔴 recents come FIRST, in stored order; then the remaining server rows in server order', () => {
    const tiles = mergeHomeApps({
      server: [FORGE, TAGGER, LAB], // the server's own order (lastUsedAt desc)
      recents: [
        recentOffsite('apl_lab', 'prompt-lab', 'Prompt Lab', 'https://promptlab.example.org/app'),
        recentOnsite('tag-wizard', 'ab_tagger', 'Tag Wizard'),
      ],
      canOpenPage: true,
    });
    expect(tiles.map((t) => t.slug)).toEqual(['prompt-lab', 'tag-wizard', 'pixel-forge']);
  });

  it('🔴 a recents-only entry renders from its stored fields, with NO stored icon', () => {
    const tiles = mergeHomeApps({
      server: [],
      recents: [
        recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch'),
        recentOffsite('apl_ext', 'ext-notes', 'Ext Notes', 'https://notes.example.org/'),
      ],
      canOpenPage: true,
    });
    expect(tiles).toEqual([
      expect.objectContaining({
        key: 'recent:neon-sketch',
        name: 'Neon Sketch',
        launchHref: '/apps/run/neon-sketch',
        external: false,
        iconUrl: null,
        iconFromServer: false,
        source: 'recent',
        listingId: null,
      }),
      expect.objectContaining({
        key: 'recent:ext-notes',
        name: 'Ext Notes',
        launchHref: 'https://notes.example.org/',
        external: true,
        iconFromServer: false,
      }),
    ]);
  });

  it('a recents-only on-site entry launches its store page when the viewer cannot open pages', () => {
    const [tile] = mergeHomeApps({
      server: [],
      recents: [recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch')],
      canOpenPage: false,
    });
    expect(tile.launchHref).toBe('/apps/store-preview/neon-sketch');
  });

  it("a recents-only entry's stored name is sanitized (publisher text via localStorage)", () => {
    const [tile] = mergeHomeApps({
      server: [],
      recents: [{ id: 'ab_x', slug: 'x-app', blockId: 'x-app', kind: 'onsite', name: '‮evil' }],
      canOpenPage: true,
    });
    expect(tile.name).not.toContain('‮');
  });

  it('the same slug twice in recents yields one tile', () => {
    const r = recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch');
    expect(mergeHomeApps({ server: [], recents: [r, r], canOpenPage: true })).toHaveLength(1);
  });

  it('both sources empty → empty grid (the empty state)', () => {
    expect(mergeHomeApps({ server: [], recents: [], canOpenPage: true })).toEqual([]);
  });
});

describe('recents for the home are read per ACCOUNT, and a bad store reads as empty', () => {
  const OWN = 41;
  const OTHER = 73;
  const stored = [recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch')];

  it('🔴 another account’s recents never appear', () => {
    // Positive control first: the same blob DOES produce a tile for its own owner.
    expect(
      mergeHomeApps({
        server: [],
        recents: parseRecentsForOwner(blob(OWN, stored), OWN),
        canOpenPage: true,
      })
    ).toHaveLength(1);
    expect(
      mergeHomeApps({
        server: [],
        recents: parseRecentsForOwner(blob(OTHER, stored), OWN),
        canOpenPage: true,
      })
    ).toEqual([]);
    // …and the signed-out bucket is its own bucket, not a wildcard.
    expect(parseRecentsForOwner(blob(null, stored), OWN)).toEqual([]);
  });

  it.each([
    ['no store at all', null],
    ['not JSON', '{oops'],
    ['an unknown envelope version', JSON.stringify({ v: 1, ownerId: OWN, apps: stored })],
    [
      'apps is not an array',
      JSON.stringify({ v: RECENTS_ENVELOPE_VERSION, ownerId: OWN, apps: 'x' }),
    ],
    ['entries with no usable key', blob(OWN, [{ id: 7 }, { name: 'no id' }, null])],
  ])('a corrupt store (%s) reads as empty and the grid falls back to the server', (_l, raw) => {
    const recents = parseRecentsForOwner(raw, OWN);
    expect(recents).toEqual([]);
    expect(
      mergeHomeApps({ server: [FORGE], recents, canOpenPage: true }).map((t) => t.key)
    ).toEqual(['listing:apl_forge']);
  });
});
