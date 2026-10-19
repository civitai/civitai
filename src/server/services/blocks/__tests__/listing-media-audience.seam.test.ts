import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SEAM — host × viewer browsing level × the live projection, through the REAL store reads.
 *
 * `listing-media-audience.test.ts` pins the rule in isolation. This file drives the real
 * `listAvailableListings` and `getListingDetail`, with only the database and the redis cache
 * stubbed, so the per-image gate is exercised together with the catalog cache (whose key is
 * derived here exactly the way `queryCache` derives it), the request's host class and the viewer's
 * browsing level. A gate that worked in the pure module but was not threaded into one of these
 * reads — or was computed from the wrong host, or ignored the viewer — fails here.
 *
 * Fixture values are pairwise distinct and distinct from every constant the code names: image
 * ids 11/12/13 (+ 15/16 in T7), urls `a.png`/`b.png`/`c.png` (+ `e.png`/`f.png`), levels PG = 1,
 * PG-13 = 2, R = 4.
 */

vi.mock('~/client-utils/edge-url', () => ({
  // Recognisable, and carries the width, so a wrong width class is visible too.
  getEdgeUrl: (src: string, opts?: { width?: number }) => `edge:${src}@${opts?.width ?? 'auto'}`,
}));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));

/**
 * An in-memory `queryCache`: entries keyed by `[key, version, hashifyObject(sql)]`, the same
 * join `queryCache` uses, so a `.red` page and a `.com` page land in different entries only if
 * the SERVICE gives them different keys. A miss runs the page producer; a hit does not.
 */
const { cacheStore, cacheStats, pageRows } = vi.hoisted(() => ({
  cacheStore: new Map<string, unknown[]>(),
  cacheStats: { misses: 0, hits: 0 },
  pageRows: { current: [] as { id: string; sort_key: string }[] },
}));
vi.mock('~/server/utils/cache-helpers', async () => {
  const { hashifyObject } = await import('~/utils/string-helpers');
  return {
    queryCache: (_db: unknown, key: string, version?: string) => async (sql: unknown) => {
      const cacheKey = [key, version, hashifyObject(sql as object).toString()]
        .filter((p) => p != null && p !== '')
        .join(':');
      const hit = cacheStore.get(cacheKey);
      if (hit) {
        cacheStats.hits += 1;
        return hit;
      }
      cacheStats.misses += 1;
      const rows = [...pageRows.current];
      cacheStore.set(cacheKey, rows);
      return rows;
    },
    bustCacheTag: vi.fn(async () => undefined),
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getListingDetail,
  getListingPreviewForReview,
  listAvailableListings,
  projectListingCard,
  projectListingDetail,
} from '../app-listing.service';
import { NsfwLevel } from '~/server/common/enums';

const PG = NsfwLevel.PG; // 1
const PG13 = NsfwLevel.PG13; // 2
const R = NsfwLevel.R; // 4

/** A viewer whose saved browsing level admits PG through R. */
const R_VIEWER_LEVEL = PG | PG13 | R;

type Img = ReturnType<typeof scanned>;

function scanned(id: number, url: string, nsfwLevel: number) {
  return {
    id,
    url,
    nsfwLevel,
    ingestion: 'Scanned',
    needsReview: null as string | null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null as string | null,
  };
}

const LISTING_ID = 'apl_media_seam_01';

/** One mutable image table: rows reference images by id, so a re-level is one write here. */
const images = new Map<number, Img>();

function listingRow(opts: {
  contentRating: string;
  iconId: number | null;
  coverId: number | null;
  screenshotIds: number[];
  /** An on-site listing with a deployed AppBlock (what the in-app "Recently run" menu lists). */
  onsite?: boolean;
}) {
  const img = (id: number | null) => (id == null ? null : images.get(id) ?? null);
  const onsite = opts.onsite
    ? {
        kind: 'onsite',
        appBlockId: 'ab_media_seam',
        appBlock: {
          manifest: {},
          currentVersionDeployedAt: new Date('2026-02-01T00:00:00.000Z'),
          approvedScopes: [],
        },
      }
    : {};
  return {
    id: LISTING_ID,
    serialId: 31,
    kind: 'offsite',
    slug: 'media-seam',
    name: 'Media Seam',
    tagline: null,
    description: null,
    category: null,
    contentRating: opts.contentRating,
    externalUrl: 'https://example.com/app',
    connectClientId: null,
    connectRequestedScopes: null,
    status: 'approved',
    updatedAt: new Date('2026-02-03T04:05:06.000Z'),
    appBlockId: null,
    appBlock: null,
    metric: null,
    user: { id: 9, username: 'dev', image: null },
    icon: img(opts.iconId),
    cover: img(opts.coverId),
    screenshots: opts.screenshotIds.map((id, i) => ({ caption: `cap-${i}`, image: img(id) })),
    ...onsite,
  };
}

let shape: Parameters<typeof listingRow>[0];

const BASE_INPUT = { kind: 'all', sort: 'newest', limit: 20 } as const;

async function card(redCapable: boolean, viewerBrowsingLevel?: number) {
  const { items } = await listAvailableListings(BASE_INPUT as never, {
    redCapable,
    scope: 'full',
    floor: 'public',
    viewerBrowsingLevel,
  });
  expect(items, 'the page lost the listing — the media assertions would be vacuous').toHaveLength(
    1
  );
  return items[0] as { iconUrl: string | null; coverUrl: string | null };
}

async function detail(redCapable: boolean, viewerBrowsingLevel?: number) {
  const d = await getListingDetail(
    { slug: 'media-seam' },
    { redCapable, scope: 'full', floor: 'public', viewerBrowsingLevel }
  );
  expect(
    d,
    'the detail read returned nothing — the media assertions would be vacuous'
  ).not.toBeNull();
  return d!;
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  cacheStats.misses = 0;
  cacheStats.hits = 0;
  images.clear();
  images.set(11, scanned(11, 'a.png', PG));
  images.set(12, scanned(12, 'b.png', R));
  images.set(13, scanned(13, 'c.png', PG13));
  shape = { contentRating: 'g', iconId: null, coverId: null, screenshotIds: [] };
  pageRows.current = [{ id: LISTING_ID, sort_key: '0001' }];
  dbMock.dbRead.appListing.findMany.mockImplementation(async () => [listingRow(shape)]);
  dbMock.dbRead.appListing.findFirst.mockImplementation(async () => listingRow(shape));
});

describe('T1 — the detail gallery is gated per image, by host and viewer', () => {
  beforeEach(() => {
    // A `g` listing that carries an R screenshot: what an on-site media revision (no rating
    // floor) or a post-approval re-rate that skipped the re-derive leaves behind.
    shape = { contentRating: 'g', iconId: null, coverId: null, screenshotIds: [11, 12] };
  });

  it('a non-red host shows only the PG screenshot', async () => {
    const d = await detail(false, R_VIEWER_LEVEL);
    expect(d.screenshots).toEqual([{ url: 'edge:a.png@1200', caption: 'cap-0' }]);
  });

  it('a red host shows both to a viewer who has opted into R', async () => {
    const d = await detail(true, R_VIEWER_LEVEL);
    expect(d.screenshots).toEqual([
      { url: 'edge:a.png@1200', caption: 'cap-0' },
      { url: 'edge:b.png@1200', caption: 'cap-1' },
    ]);
  });

  it('a red host shows only the PG screenshot to an anonymous viewer', async () => {
    const d = await detail(true, undefined);
    expect(d.screenshots).toEqual([{ url: 'edge:a.png@1200', caption: 'cap-0' }]);
  });
});

describe('T2 — the cover falls back to the first screenshot THIS viewer may see', () => {
  beforeEach(() => {
    shape = { contentRating: 'g', iconId: null, coverId: null, screenshotIds: [12, 11] };
  });

  it('non-red host: the card and the detail both take the PG screenshot, never the R one', async () => {
    expect((await card(false, R_VIEWER_LEVEL)).coverUrl).toBe('edge:a.png@1200');
    expect((await detail(false, R_VIEWER_LEVEL)).coverUrl).toBe('edge:a.png@1200');
  });

  it('red host + R viewer: the first screenshot is visible, so it is the cover', async () => {
    expect((await card(true, R_VIEWER_LEVEL)).coverUrl).toBe('edge:b.png@1200');
  });

  it('a hidden cover image is replaced by a visible screenshot, not shown', async () => {
    shape = { contentRating: 'g', iconId: 12, coverId: 12, screenshotIds: [11] };
    const c = await card(false, R_VIEWER_LEVEL);
    expect(c.coverUrl).toBe('edge:a.png@1200');
    // The R icon has nothing to fall back to: the renderer's placeholder (null).
    expect(c.iconUrl).toBeNull();
    // The detail projection gates its icon the same way.
    const d = await detail(false, R_VIEWER_LEVEL);
    expect(d.iconUrl).toBeNull();
    expect(d.coverUrl).toBe('edge:a.png@1200');
  });
});

describe('T3 — a level change takes effect on the next read, with no rating write and no bust', () => {
  it('re-levelling one screenshot PG→R between two non-red reads drops it from the second', async () => {
    shape = { contentRating: 'g', iconId: 11, coverId: null, screenshotIds: [13, 11] };
    const before = await card(false, R_VIEWER_LEVEL);
    // `g` admits PG only off a red host, so PG-13 (13) is hidden and the PG one (11) is the cover.
    expect(before.coverUrl).toBe('edge:a.png@1200');
    expect(before.iconUrl).toBe('edge:a.png@256');

    // A community-consensus / scanner re-rate: the image row changes, nothing else does.
    images.set(11, scanned(11, 'a.png', R));
    const after = await card(false, R_VIEWER_LEVEL);
    expect(after.coverUrl).toBeNull();
    expect(after.iconUrl).toBeNull();

    // POSITIVE CONTROL that the cache was really in play: the second read was served from the
    // cached id page, so what dropped the image was the live projection below the cache.
    expect(cacheStats).toEqual({ misses: 1, hits: 1 });
  });
});

describe('SEAM — one shared cache, two host classes, two viewers', () => {
  it('a red read cannot hand its media to a later non-red read through the cache', async () => {
    shape = { contentRating: 'g', iconId: 12, coverId: 12, screenshotIds: [12, 11] };

    const red = await card(true, R_VIEWER_LEVEL);
    expect(red).toMatchObject({ iconUrl: 'edge:b.png@256', coverUrl: 'edge:b.png@1200' });

    const com = await card(false, R_VIEWER_LEVEL);
    expect(com).toMatchObject({ iconUrl: null, coverUrl: 'edge:a.png@1200' });

    // The same viewer level both times, so the difference is the host alone — and the two
    // reads used two cache entries (one miss each), so it is not a stale page either.
    expect(cacheStats).toEqual({ misses: 2, hits: 0 });
  });

  it('on a red host the VIEWER decides: the same request shape differs only by browsing level', async () => {
    shape = { contentRating: 'g', iconId: 12, coverId: 12, screenshotIds: [12, 11] };
    const optedIn = await card(true, R_VIEWER_LEVEL);
    const anonymous = await card(true, undefined);
    expect(optedIn.coverUrl).toBe('edge:b.png@1200');
    expect(anonymous.coverUrl).toBe('edge:a.png@1200');
    expect(anonymous.iconUrl).toBeNull();
    // Shared cache entry (same host class): the viewer term is applied BELOW the cache.
    expect(cacheStats).toEqual({ misses: 1, hits: 1 });
  });

  it('off a red host the listing rating caps media even for an R viewer', async () => {
    // A `pg13` listing admits PG-13 off a red host; a `g` one does not.
    shape = { contentRating: 'pg13', iconId: null, coverId: 13, screenshotIds: [13] };
    expect((await card(false, R_VIEWER_LEVEL)).coverUrl).toBe('edge:c.png@1200');
    shape = { contentRating: 'g', iconId: null, coverId: 13, screenshotIds: [13] };
    cacheStore.clear();
    expect((await card(false, R_VIEWER_LEVEL)).coverUrl).toBeNull();
  });
});

// THE RED-HOST RULE through the real store reads: on a red host the media ceiling is the one the
// non-red host applies to the same listing, UNION the viewer's opted-in levels. A red host never
// shows less SFW media than a non-red host, and shows mature media only to a viewer who opted in.
describe('T6 — a red host never shows less than a non-red host', () => {
  /** A viewer who opted into PG and R but not PG-13 (5): distinct from every ceiling constant. */
  const PG_AND_R_VIEWER = PG | R;

  beforeEach(() => {
    // A `pg13` listing: PG-13 cover, an R screenshot behind it.
    shape = { contentRating: 'pg13', iconId: 13, coverId: 13, screenshotIds: [12] };
  });

  it('an anonymous viewer on a red host sees the PG-13 cover a non-red host shows', async () => {
    const com = await card(false, undefined);
    expect(com, 'positive control: the non-red host shows the PG-13 cover').toMatchObject({
      coverUrl: 'edge:c.png@1200',
      iconUrl: 'edge:c.png@256',
    });
    const red = await card(true, undefined);
    expect(red).toMatchObject({ coverUrl: 'edge:c.png@1200', iconUrl: 'edge:c.png@256' });
    // …and still no R screenshot for that viewer.
    expect((await detail(true, undefined)).screenshots).toEqual([]);
  });

  it('a red-host viewer who opted into R but not PG-13 keeps the PG-13 cover and gains the R shot', async () => {
    const d = await detail(true, PG_AND_R_VIEWER);
    expect(d.coverUrl).toBe('edge:c.png@1200');
    expect(d.screenshots).toEqual([{ url: 'edge:b.png@1200', caption: 'cap-0' }]);
  });

  it('a non-red host still hides the R screenshot from the same opted-in viewer (unchanged)', async () => {
    const d = await detail(false, PG_AND_R_VIEWER);
    expect(d.coverUrl).toBe('edge:c.png@1200');
    expect(d.screenshots).toEqual([]);
  });
});

describe('T7 — the in-app "Recently run" menu icon: getListingDetail.iconUrl for an on-site app', () => {
  // INVARIANT GUARDS for this PR's last change: the menu (`ChromeRecentAppIcon`) draws exactly
  // this field, read through `appListings.getAppDetail`, and these were already true of the
  // detail read before the menu used it. They pin what the menu now depends on.
  beforeEach(() => {
    images.set(15, { ...scanned(15, 'e.png', PG), blockedFor: 'moderated' });
    images.set(16, { ...scanned(16, 'f.png', 0), ingestion: 'Pending' });
  });

  const icon = async (redCapable: boolean, viewerBrowsingLevel?: number) =>
    (await detail(redCapable, viewerBrowsingLevel)).iconUrl;

  it('positive control: a PG icon on a `g` listing shows on a non-red host', async () => {
    shape = { contentRating: 'g', iconId: 11, coverId: null, screenshotIds: [], onsite: true };
    expect(await icon(false, R_VIEWER_LEVEL)).toBe('edge:a.png@256');
  });

  it('non-red host: an R icon is null, even for a viewer who opted into R', async () => {
    shape = { contentRating: 'g', iconId: 12, coverId: null, screenshotIds: [], onsite: true };
    expect(await icon(false, R_VIEWER_LEVEL)).toBeNull();
  });

  it('non-red host: a blocked icon is null whatever its level', async () => {
    shape = { contentRating: 'g', iconId: 15, coverId: null, screenshotIds: [], onsite: true };
    expect(await icon(false, R_VIEWER_LEVEL)).toBeNull();
  });

  it('non-red host: an unrated icon is null', async () => {
    shape = { contentRating: 'g', iconId: 16, coverId: null, screenshotIds: [], onsite: true };
    expect(await icon(false, R_VIEWER_LEVEL)).toBeNull();
  });

  it("non-red host: an icon above the listing's own rating is null", async () => {
    shape = { contentRating: 'g', iconId: 13, coverId: null, screenshotIds: [], onsite: true };
    expect(await icon(false, R_VIEWER_LEVEL)).toBeNull();
  });

  it('red host: an R icon shows to a viewer who opted into R, and not to an anonymous one', async () => {
    shape = { contentRating: 'r', iconId: 12, coverId: null, screenshotIds: [], onsite: true };
    expect(await icon(true, R_VIEWER_LEVEL)).toBe('edge:b.png@256');
    expect(await icon(true, undefined)).toBeNull();
  });
});

describe('the two views that are NOT a per-request public audience', () => {
  beforeEach(() => {
    images.set(14, { ...scanned(14, 'd.png', PG), ingestion: 'Pending' });
    shape = { contentRating: 'g', iconId: 12, coverId: 14, screenshotIds: [12, 11] };
  });

  // Red before the gate existed (every caller then showed everything), and the guard on the
  // default itself: flipping it to the ungated view fails this case.
  it('a projection called WITHOUT a view gets the narrowest public one', () => {
    const row = listingRow(shape);
    const c = projectListingCard(row as never);
    expect(c).toMatchObject({ iconUrl: null, coverUrl: 'edge:a.png@1200' });
    expect(projectListingDetail(row as never).screenshots).toEqual([
      { url: 'edge:a.png@1200', caption: 'cap-1' },
    ]);
  });

  // INVARIANT GUARD (green before the gate too; certified by flipping the preview to a public
  // view): the moderator preview shows what is attached — the R icon, the still-scanning
  // cover, every screenshot — so a reviewer can see, and reject, what the public would not get.
  it('the moderator review preview is ungated', async () => {
    dbMock.dbRead.appListing.findUnique.mockImplementation(async () => ({
      ...listingRow(shape),
      revisionOfId: null,
    }));
    const preview = await getListingPreviewForReview({ listingId: LISTING_ID });
    expect(preview?.card).toMatchObject({
      iconUrl: 'edge:b.png@256',
      coverUrl: 'edge:d.png@1200',
    });
    expect(preview?.detail.screenshots).toEqual([
      { url: 'edge:b.png@1200', caption: 'cap-0' },
      { url: 'edge:a.png@1200', caption: 'cap-1' },
    ]);
  });
});
