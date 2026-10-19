import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SEAM — the civitai.red icon / cover OVERRIDES through the REAL store reads: host × viewer
 * browsing level × the live projection × the slot fallback, with the overrides themselves read
 * by the real SQL against the real migrations (PGlite) and the listing rows from a stubbed Prisma.
 *
 * What this pins together, which no single module's suite can:
 *   - the store reads the overrides ONLY for a red-capable request (I2) — counted at the
 *     database, not inferred from a projection;
 *   - each override is gated by the same per-image rule as the listing's own media, and falls
 *     back to the listing's own icon / cover (then the first visible screenshot) when hidden;
 *   - a red read cannot hand an override to a later non-red read through the shared id cache.
 *
 * Fixture values are pairwise distinct and distinct from every constant the code names: own
 * media 11 (PG, `a.png`) / 13 (PG-13, `c.png`); overrides 21 (R, `ri.png`), 22 (XXX, `rc.png`),
 * 23 (PG, `rp.png`), 24 (R but Blocked, `rb.png`), 25 (unrated, `ru.png`).
 */

// For the page's SSR wiring, which takes a request HOST: `civitai.red` is configured as a blue
// alias AND the red primary, as in production (see `listing-media-audience.test.ts`).
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (src: string, opts?: { width?: number }) => `edge:${src}@${opts?.width ?? 'auto'}`,
}));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));

const { cacheStore, pageRows } = vi.hoisted(() => ({
  cacheStore: new Map<string, unknown[]>(),
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
      if (hit) return hit;
      const rows = [...pageRows.current];
      cacheStore.set(cacheKey, rows);
      return rows;
    },
    bustCacheTag: vi.fn(async () => undefined),
  };
});

// The listing page's SSR scope read (`resolveListingPageSocialImage`); everything else real.
const { storeScope, scopeCalls } = vi.hoisted(() => ({
  storeScope: { current: 'full' as string },
  scopeCalls: [] as unknown[],
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  resolveStoreVisibilityScope: vi.fn(async (opts: unknown) => {
    scopeCalls.push(opts);
    return storeScope.current;
  }),
}));
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import {
  getListingDetail,
  getListingPreviewForReview,
  getListingSocialImage,
  listAvailableListings,
} from '../app-listing.service';
import { resolveListingPageSocialImage } from '../listing-page-social-image';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const PG = NsfwLevel.PG;
const PG13 = NsfwLevel.PG13;
const R = NsfwLevel.R;
const X = NsfwLevel.X;
const XXX = NsfwLevel.XXX;

const LISTING_ID = 'apl_red_seam_01';

function img(id: number, url: string, nsfwLevel: number) {
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

const OWN_PG = img(11, 'a.png', PG);
const OWN_PG13 = img(13, 'c.png', PG13);

/** A `g` listing whose own icon and cover are PG, with one PG-13 screenshot. */
function listingRow(over: { contentRating?: string; cover?: unknown } = {}) {
  return {
    id: LISTING_ID,
    serialId: 41,
    kind: 'offsite',
    slug: 'red-seam',
    name: 'Red Seam',
    tagline: null,
    description: null,
    category: null,
    contentRating: over.contentRating ?? 'g',
    externalUrl: 'https://example.com/app',
    connectClientId: null,
    connectRequestedScopes: null,
    status: 'approved',
    revisionOfId: null,
    updatedAt: new Date('2026-02-03T04:05:06.000Z'),
    appBlockId: null,
    appBlock: null,
    metric: null,
    user: { id: 9, username: 'dev', image: null },
    icon: OWN_PG,
    cover: 'cover' in over ? over.cover : OWN_PG,
    screenshots: [{ caption: 'cap-0', image: OWN_PG13 }],
  };
}

let row: ReturnType<typeof listingRow>;

/** Every statement that names the override table, by client — what I2 is counted on. */
const redStatements = { dbRead: 0, dbWrite: 0 };

let split: SplitDb;

beforeAll(async () => {
  split = await createSplitDb();
  await split.applyMigration();
  await split.applyRedSlotsMigration();
  await split.seed({ listingIds: [LISTING_ID] });
  await split.seedImages([
    { id: 21, nsfwLevel: R, url: 'ri.png' },
    { id: 22, nsfwLevel: XXX, url: 'rc.png' },
    { id: 23, nsfwLevel: PG, url: 'rp.png' },
    { id: 24, nsfwLevel: R, url: 'rb.png', ingestion: 'Blocked' },
    { id: 25, nsfwLevel: 0, url: 'ru.png', ingestion: 'Pending' },
  ]);
});
afterAll(() => split.db.close());

function routeAndCount(client: 'dbRead' | 'dbWrite') {
  const node = dbMock[client] as unknown as {
    $queryRaw: { mockImplementation: (f: never) => unknown };
    $executeRaw: { mockImplementation: (f: never) => unknown };
  };
  split.route(node as never);
  const routed = (
    node.$queryRaw as unknown as { getMockImplementation: () => unknown }
  ).getMockImplementation() as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  node.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (namesOverrideTable(strings, values)) redStatements[client] += 1;
    return routed(strings, ...values);
  }) as never);
}

/** A tagged-template statement naming the override table (a prebuilt `Prisma.sql` never is). */
function namesOverrideTable(strings: TemplateStringsArray, values: unknown[]) {
  return (
    Array.isArray(strings) && Prisma.sql(strings, ...values).text.includes('app_listing_red_media')
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  storeScope.current = 'full';
  scopeCalls.length = 0;
  cacheStore.clear();
  redStatements.dbRead = 0;
  redStatements.dbWrite = 0;
  await split.db.exec(`TRUNCATE app_listing_red_media`);
  row = listingRow();
  pageRows.current = [{ id: LISTING_ID, sort_key: '0001' }];
  dbMock.dbRead.appListing.findMany.mockImplementation(async () => [row]);
  dbMock.dbRead.appListing.findFirst.mockImplementation(async () => row);
  dbMock.dbRead.appListing.findUnique.mockImplementation(async () => row);
  routeAndCount('dbRead');
  routeAndCount('dbWrite');
});

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
    { slug: 'red-seam' },
    { redCapable, scope: 'full', floor: 'public', viewerBrowsingLevel }
  );
  expect(d, 'the detail read returned nothing').not.toBeNull();
  return d!;
}

const R_VIEWER = PG | PG13 | R;
const ALL_VIEWER = PG | PG13 | R | X | XXX;

describe('a red host shows an override to a viewer the store rule lets see it', () => {
  it('🔴 an R-opted viewer gets the R icon override on the card and the detail', async () => {
    await split.setRedSlots(LISTING_ID, { icon: 21 });
    expect((await card(true, R_VIEWER)).iconUrl).toBe('edge:ri.png@256');
    expect((await detail(true, R_VIEWER)).iconUrl).toBe('edge:ri.png@256');
  });

  it('🔴 XXX is allowed: an XXX-opted viewer gets the XXX cover override', async () => {
    await split.setRedSlots(LISTING_ID, { cover: 22 });
    expect((await card(true, ALL_VIEWER)).coverUrl).toBe('edge:rc.png@1200');
    expect((await detail(true, ALL_VIEWER)).coverUrl).toBe('edge:rc.png@1200');
  });

  it('invariant guard: a viewer who has not opted in gets the listing’s own icon and cover instead', async () => {
    await split.setRedSlots(LISTING_ID, { icon: 21, cover: 22 });
    for (const level of [undefined, R_VIEWER]) {
      const c = await card(true, level);
      // R icon: hidden from anonymous, shown to R. XXX cover: hidden from both.
      expect(c.coverUrl).toBe('edge:a.png@1200');
      if (level === undefined) expect(c.iconUrl).toBe('edge:a.png@256');
    }
  });

  it('a SFW override shows on a red host to anyone — it is still only ever read there', async () => {
    await split.setRedSlots(LISTING_ID, { icon: 23 });
    expect((await card(true, undefined)).iconUrl).toBe('edge:rp.png@256');
  });

  it('invariant guard: a Blocked or unrated override never renders; the listing’s own media does', async () => {
    await split.setRedSlots(LISTING_ID, { icon: 24, cover: 25 });
    const c = await card(true, ALL_VIEWER);
    expect(c).toEqual(
      expect.objectContaining({ iconUrl: 'edge:a.png@256', coverUrl: 'edge:a.png@1200' })
    );
  });

  it('a hidden cover override falls back to the own cover, then to the first visible screenshot', async () => {
    await split.setRedSlots(LISTING_ID, { cover: 22 });
    // Own cover gone too: the PG-13 screenshot is next — but a `g` listing caps that off a red
    // host, and an anonymous red viewer gets exactly that ceiling, so: null.
    row = listingRow({ cover: null });
    expect((await card(true, undefined)).coverUrl).toBeNull();
    // A PG-13-opted red viewer may see the screenshot, so it is the cover — never the XXX one.
    expect((await card(true, PG | PG13)).coverUrl).toBe('edge:c.png@1200');
  });
});

describe('T9 — a non-red request never reads an override (I2), and never shows one', () => {
  it('🔴 INVARIANT GUARD: a red read, then a non-red read through the same cache', async () => {
    // A PG override: one the non-red ceiling WOULD admit, so if a non-red read ever reached and
    // honoured it, the url assertions below would see it.
    await split.setRedSlots(LISTING_ID, { icon: 23, cover: 23 });

    expect((await card(true, R_VIEWER)).iconUrl).toBe('edge:rp.png@256');
    expect(
      redStatements.dbRead,
      'positive control: the red read reaches the table'
    ).toBeGreaterThan(0);

    redStatements.dbRead = 0;
    const comCard = await card(false, R_VIEWER);
    const comDetail = await detail(false, R_VIEWER);
    expect(comCard).toEqual(
      expect.objectContaining({ iconUrl: 'edge:a.png@256', coverUrl: 'edge:a.png@1200' })
    );
    expect(comDetail.iconUrl).toBe('edge:a.png@256');
    expect(comDetail.coverUrl).toBe('edge:a.png@1200');
    expect(redStatements, 'a non-red read issued a statement on the override table').toEqual({
      dbRead: 0,
      dbWrite: 0,
    });
  });
});

describe('fail-safe while the environment cannot serve overrides', () => {
  it('invariant guard: columns absent: a red host shows the listing’s own media, and nothing throws', async () => {
    const t = await createSplitDb();
    // The render read's catch-all would turn a "column does not exist" into "no overrides" as
    // well, so pin that it never got that far: the PROBE answered, and nothing was logged.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await t.applyMigration();
      t.route(dbMock.dbRead as never);
      const c = await card(true, ALL_VIEWER);
      expect(c).toEqual(
        expect.objectContaining({ iconUrl: 'edge:a.png@256', coverUrl: 'edge:a.png@1200' })
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await t.db.close();
    }
  });

  it('🔴 a failing read is "no overrides", never a 500', async () => {
    await split.setRedSlots(LISTING_ID, { icon: 21 });
    const routed = dbMock.dbRead.$queryRaw.getMockImplementation() as (
      s: TemplateStringsArray,
      ...v: unknown[]
    ) => Promise<unknown>;
    dbMock.dbRead.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (namesOverrideTable(strings, values)) throw new Error('connection reset');
        return routed(strings, ...values);
      }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await detail(true, R_VIEWER)).iconUrl).toBe('edge:a.png@256');
      // Positive control for the "nothing was logged" assertion above: a real failure IS logged.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the moderator preview carries every image with its level, overrides included', () => {
  it('returns the overrides of the previewed row, as attached', async () => {
    await split.setRedSlots(LISTING_ID, { icon: 24, cover: 22 });
    const preview = await getListingPreviewForReview({ listingId: LISTING_ID });
    expect(preview?.media).toEqual({
      icon: { imageId: 11, url: 'edge:a.png@256', nsfwLevel: PG },
      cover: { imageId: 11, url: 'edge:a.png@1200', nsfwLevel: PG },
      // Blocked is shown to the moderator (as attached) — it is the reviewer's to reject.
      redIcon: { imageId: 24, url: 'edge:rb.png@256', nsfwLevel: R },
      redCover: { imageId: 22, url: 'edge:rc.png@1200', nsfwLevel: XXX },
      screenshots: [{ imageId: 13, url: 'edge:c.png@1200', nsfwLevel: PG13, caption: 'cap-0' }],
    });
    // Read through the WRITE client, like the rest of the review's media state.
    expect(redStatements.dbWrite).toBeGreaterThan(0);
  });
});

/**
 * P3 — the listing page's social image (`og:image`), through the real detail gates. Held to the
 * ANONYMOUS ceiling of the host, so no host ever gets a mature image, and chosen from the
 * listing's OWN media only: a civitai.red icon / cover override is never a candidate on any host
 * (design invariant I6). Extra fixtures: 31 (R own cover, `or.png`), 14 (PG screenshot, `s.png`).
 */
describe('P3 — the page’s social image is per host, never mature, never a red override', () => {
  const OWN_R = img(31, 'or.png', R);
  const SHOT_PG = img(14, 's.png', PG);
  const social = (redCapable: boolean) =>
    getListingSocialImage({ slug: 'red-seam' }, { redCapable, scope: 'full', floor: 'public' });

  it('🔴 civitai.com never emits a mature image: an R own cover falls to the next SFW image', async () => {
    row = { ...listingRow(), cover: OWN_R };
    // Not the R cover; the `g` listing's PG-13 screenshot is outside its own rating too; the
    // PG icon is what passes.
    expect(await social(false)).toEqual({ url: 'edge:a.png@256', nsfwLevel: PG });
    // Positive control: with a PG own cover, the cover is the image.
    row = listingRow();
    expect(await social(false)).toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
  });

  // 🔴 REGRESSION (I6): an override that WOULD pass the anonymous ceiling — PG, the one level any
  // host admits — is still never the og image. Each step of the own-media fallback is pinned.
  it('🔴 a SFW civitai.red cover override is never the og image on a red host: own cover, else the fallback', async () => {
    await split.setRedSlots(LISTING_ID, { cover: 23 });
    // Positive control: the page itself DOES show the override on this host, so the override is
    // live and readable — its absence below is the og rule, not a missing slot.
    expect((await detail(true, undefined)).coverUrl).toBe('edge:rp.png@1200');
    expect(await social(true), 'own cover').toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
    row = { ...listingRow({ cover: null }), screenshots: [{ caption: 'pg', image: SHOT_PG }] };
    expect(await social(true), 'first passing screenshot').toEqual({
      url: 'edge:s.png@1200',
      nsfwLevel: PG,
    });
    row = { ...listingRow({ cover: null }), screenshots: [] };
    expect(await social(true), 'own icon').toEqual({ url: 'edge:a.png@256', nsfwLevel: PG });
  });

  it('🔴 a SFW civitai.red icon override is never the og image on a red host: the own icon is', async () => {
    await split.setRedSlots(LISTING_ID, { icon: 23 });
    row = { ...listingRow({ cover: null }), screenshots: [] };
    expect(await social(true)).toEqual({ url: 'edge:a.png@256', nsfwLevel: PG });
  });

  it('🔴 the og read never reaches the override table, on either host', async () => {
    await split.setRedSlots(LISTING_ID, { cover: 23, icon: 23 });
    for (const redCapable of [true, false]) {
      redStatements.dbRead = 0;
      expect(await social(redCapable)).toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
      expect(redStatements.dbRead, `red=${redCapable}: og read the override table`).toBe(0);
    }
    // Positive control: the page's own detail read on a red host does reach it.
    await detail(true, undefined);
    expect(redStatements.dbRead, 'positive control: the detail reads the table').toBeGreaterThan(0);
  });

  it('civitai.red falls back to the SFW cover when an override is mature — even XXX', async () => {
    await split.setRedSlots(LISTING_ID, { cover: 22, icon: 21 });
    expect(await social(true)).toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
  });

  it('a listing the detail read would refuse yields no image (shared gates)', async () => {
    // A mature listing off a red host is not served at all, so it has no preview there either.
    row = listingRow({ contentRating: 'r' });
    expect(await social(false)).toBeNull();
    // Positive control: the same listing on a red host is served, with its SFW cover.
    expect(await social(true)).toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
  });

  it('🔴 the level travels with the image: a PG-13 cover on a pg13 listing carries PG-13', async () => {
    row = { ...listingRow({ contentRating: 'pg13', cover: OWN_PG13 }) };
    expect(await social(false)).toEqual({ url: 'edge:c.png@1200', nsfwLevel: PG13 });
  });

  it('a mature, Blocked or unrated civitai.red ICON override is not the og image: the own icon is', async () => {
    row = { ...listingRow({ cover: null }), screenshots: [] };
    for (const icon of [21, 24, 25]) {
      await split.setRedSlots(LISTING_ID, { icon });
      expect(await social(true), `red icon ${icon}`).toEqual({
        url: 'edge:a.png@256',
        nsfwLevel: PG,
      });
    }
  });

  it('with no cover that passes, the first screenshot that passes is the image', async () => {
    row = {
      ...listingRow({ cover: null }),
      screenshots: [
        { caption: 'pg13', image: OWN_PG13 },
        { caption: 'pg', image: SHOT_PG },
      ],
    };
    expect(await social(false)).toEqual({ url: 'edge:s.png@1200', nsfwLevel: PG });
  });

  // The og image follows the page's OWN choice order over the listing's OWN media — on either
  // host it is what an anonymous viewer of civitai.com (which never shows an override) sees as
  // the cover, else the icon. Pinned as a relationship, so a change to the page's cover fallback
  // cannot leave the preview on the old order. The override cases are where the red page and the
  // og image deliberately differ (I6).
  it('on either host, the og image is what an anonymous civitai.com viewer sees as the cover, else the icon', async () => {
    const cases: { label: string; set: () => Promise<void> }[] = [
      { label: 'own media', set: async () => void (row = listingRow()) },
      {
        label: 'R cover, PG screenshot',
        set: async () =>
          void (row = {
            ...listingRow({ cover: OWN_R }),
            screenshots: [{ caption: 'pg', image: SHOT_PG }],
          }),
      },
      {
        label: 'red cover override',
        set: async () => {
          row = listingRow();
          await split.setRedSlots(LISTING_ID, { cover: 23 });
        },
      },
      {
        label: 'no cover, red icon override',
        set: async () => {
          row = { ...listingRow({ cover: null }), screenshots: [] };
          await split.setRedSlots(LISTING_ID, { icon: 23 });
        },
      },
    ];
    for (const c of cases) {
      await split.db.exec(`TRUNCATE app_listing_red_media`);
      await c.set();
      const page = await detail(false, undefined);
      for (const redCapable of [false, true]) {
        expect((await social(redCapable))?.url ?? null, `${c.label} / red=${redCapable}`).toBe(
          page.coverUrl ?? page.iconUrl
        );
      }
    }
  });

  it('a listing with no image that passes yields none', async () => {
    row = { ...listingRow({ cover: OWN_R }), icon: OWN_R, screenshots: [] };
    expect(await social(false)).toBeNull();
    expect(await social(true)).toBeNull();
  });
});

describe('P3 — the listing page SSR wiring', () => {
  const VIEWER = { id: 77, username: 'viewer' } as never;
  // The page's resolver arguments, in the shape `createServerSideProps` hands them over.
  const page = (
    host: string | undefined,
    isClient = false,
    params: Record<string, unknown> = { slug: 'red-seam' }
  ) =>
    resolveListingPageSocialImage({
      ctx: { params: params as Record<string, string>, req: { headers: { host } } },
      session: { user: VIEWER },
      isClient,
    });

  // The host is observable through the detail gates: an `r` listing is served on civitai.red
  // only, so it has an og image there and none on civitai.com.
  it('🔴 the request host decides: an `r` listing has its own SFW cover on civitai.red, nothing on civitai.com', async () => {
    row = listingRow({ contentRating: 'r' });
    expect(await page('civitai.red')).toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
    expect(await page('civitai.com')).toBeNull();
  });

  it('🔴 civitai.red never offers its SFW cover override as the og image', async () => {
    await split.setRedSlots(LISTING_ID, { cover: 23 });
    expect(await page('civitai.red')).toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
  });

  it('the store scope is resolved for the request’s own session user', async () => {
    await page('civitai.com');
    expect(scopeCalls).toEqual([{ user: VIEWER }]);
  });

  it('no slug (or an array slug), no read', async () => {
    expect(await page('civitai.com', false, {})).toBeNull();
    expect(await page('civitai.com', false, { slug: ['a', 'b'] })).toBeNull();
    expect(dbMock.dbRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('a request with no host is not red-capable', async () => {
    row = listingRow({ contentRating: 'r' });
    expect(await page(undefined)).toBeNull();
    // Positive control: the same listing IS served on a red host.
    expect(await page('civitai.red')).toEqual({ url: 'edge:a.png@1200', nsfwLevel: PG });
  });

  it('a client-side navigation reads nothing', async () => {
    expect(await page('civitai.red', true)).toBeNull();
    expect(dbMock.dbRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('no store scope, no image', async () => {
    storeScope.current = 'none';
    expect(await page('civitai.com')).toBeNull();
    expect(dbMock.dbRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('a failing read is no image, never an error page', async () => {
    dbMock.dbRead.appListing.findFirst.mockRejectedValueOnce(new Error('connection reset'));
    expect(await page('civitai.com')).toBeNull();
  });
});
