import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      dbMock.dbRead.$queryRaw(sql),
  bustCacheTag: vi.fn(async () => undefined),
}));
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type { ListingSort } from '~/server/schema/blocks/app-listing-read.schema';
// The beta columns are a separate manual-apply concern; these stand-in tables do not carry them.
vi.mock('~/server/services/blocks/app-listing-beta.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BetaService>()),
  readListingBetaManyForRender: vi.fn(async () => new Map()),
}));
import type * as BetaService from '~/server/services/blocks/app-listing-beta.service';

/**
 * The store's SORT ORDERS, executed on real rows (the catalog statement, unmodified, on
 * PGlite) — including keyset paging across every page boundary.
 *
 * The regression this pins: "Most popular" ranked by `install_count`, which is ~0 for nearly
 * every app, and "Top rated" ties on almost every app because few have reviews; both then fell
 * through to the id, so every sort read like "Newest". The cards show PLAYS (`open_count`), so
 * that is what "Most popular" must rank by, with installs only as a tie-break, and "Top rated"
 * must break a rating tie on plays.
 *
 * Fixture values are chosen so each sort key orders the rows DIFFERENTLY: plays, installs,
 * creation time, name and rating each give a distinct permutation, so a statement ranking by
 * the wrong column cannot produce the expected order by accident.
 */
const holder = { db: null as unknown as PGlite };

const runSql = (query: Prisma.Sql) =>
  holder.db.query(query.text, query.values as unknown[]).then((r) => r.rows);
dbMock.dbRead.$queryRaw.mockImplementation(runSql);

type ListingRow = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  category: string | null;
  app_block_id: string | null;
  updated_at: Date;
  current_version_deployed_at: Date | null;
};

// Card hydration is a Prisma `findMany`; answer it from the same database.
dbMock.dbRead.appListing.findMany.mockImplementation(
  async (args: { where: { id: { in: string[] } } }) => {
    const rows = (await holder.db.query(
      `SELECT al.id, al.kind, al.slug, al.name, al.category, al.app_block_id, al.updated_at,
              ab.current_version_deployed_at
       FROM app_listings al LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
       WHERE al.id = ANY($1)`,
      [args.where.id.in]
    )) as { rows: ListingRow[] };
    return rows.rows.map((r) => ({
      id: r.id,
      serialId: 1,
      kind: r.kind,
      slug: r.slug,
      name: r.name,
      tagline: null,
      description: null,
      category: r.category,
      contentRating: 'g',
      externalUrl: null,
      connectClientId: null,
      appBlockId: r.app_block_id,
      icon: null,
      cover: null,
      user: { id: 1, username: 'owner', image: null },
      updatedAt: r.updated_at,
      metric: null,
      appBlock: r.app_block_id
        ? {
            manifest: { page: {} },
            currentVersionDeployedAt: r.current_version_deployed_at,
            approvedScopes: [],
          }
        : null,
      screenshots: [],
    }));
  }
);

const { listAvailableListings } = await import('~/server/services/blocks/app-listing.service');

/**
 * Seven approved listings. Per sort, the order each column alone would give:
 *   plays    (open_count, on-site)  A 500 > B 40 > D 25 > C 12
 *   installs (install_count)        D 90 > B 30 > E 25 > C 7 > A 1 > F 0 = G 0
 *   created  (newest first)         A > B > C > D > E > F > G
 *   name     (A→Z)                  B alpha, D bravo, C charlie, A delta, E echo, F foxtrot, G golf
 *   rating                          B (3 up) > A = D = E = F = G (no reviews) > C (2 down)
 * E, F and G are OFF-SITE: no play count (their `open_count` column is the NOT NULL default
 * 0), so they rank on installs in the plays position. E's 25 installs put it above C (12
 * plays, 7 installs) and below B (40 plays); it ties D's 25 plays and loses on installs.
 * F and G tie on every metric, so only the id can order them.
 */
const LISTINGS = [
  { id: 'apl_A', kind: 'onsite', name: 'Delta', days: 1, open: 500, install: 1, up: 0, down: 0 },
  { id: 'apl_B', kind: 'onsite', name: 'alpha', days: 2, open: 40, install: 30, up: 3, down: 0 },
  { id: 'apl_C', kind: 'onsite', name: 'Charlie', days: 3, open: 12, install: 7, up: 0, down: 2 },
  { id: 'apl_D', kind: 'onsite', name: 'bravo', days: 4, open: 25, install: 90, up: 0, down: 0 },
  { id: 'apl_E', kind: 'offsite', name: 'Echo', days: 5, open: 0, install: 25, up: 0, down: 0 },
  { id: 'apl_F', kind: 'offsite', name: 'foxtrot', days: 6, open: 0, install: 0, up: 0, down: 0 },
  { id: 'apl_G', kind: 'offsite', name: 'golf', days: 7, open: 0, install: 0, up: 0, down: 0 },
] as const;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, "bannedAt" timestamptz, "deletedAt" timestamptz);
    INSERT INTO "User" ("id") VALUES (1);
    CREATE TABLE app_blocks (
      id text PRIMARY KEY, status text NOT NULL, current_version_deployed_at timestamptz
    );
    CREATE TABLE app_listings (
      id text PRIMARY KEY, kind text NOT NULL, slug text NOT NULL UNIQUE, name text NOT NULL,
      status text NOT NULL, visibility text, revision_of_id text, app_block_id text,
      category text, content_rating text, user_id integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app_listing_metrics (
      app_listing_id text PRIMARY KEY, thumbs_up_count integer NOT NULL DEFAULT 0,
      thumbs_down_count integer NOT NULL DEFAULT 0, install_count integer NOT NULL DEFAULT 0,
      open_count integer NOT NULL DEFAULT 0
    );
  `);
  for (const l of LISTINGS) {
    const block = l.kind === 'onsite' ? `ab_${l.id}` : null;
    if (block) {
      await holder.db.query(
        `INSERT INTO app_blocks (id, status, current_version_deployed_at) VALUES ($1, 'approved', now())`,
        [block]
      );
    }
    await holder.db.query(
      `INSERT INTO app_listings (id, kind, slug, name, status, app_block_id, category, content_rating, user_id, created_at)
       VALUES ($1, $2, $3, $4, 'approved', $5, 'utility', 'g', 1, now() - make_interval(days => $6))`,
      [l.id, l.kind, `slug-${l.id}`, l.name, block, l.days]
    );
    await holder.db.query(
      `INSERT INTO app_listing_metrics (app_listing_id, thumbs_up_count, thumbs_down_count, install_count, open_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [l.id, l.up, l.down, l.install, l.open]
    );
  }
});

afterAll(async () => {
  await holder.db.close();
});

const OPTS = { scope: 'full', floor: 'public', redCapable: false } as const;

async function order(sort: ListingSort, limit = 50) {
  const res = await listAvailableListings({ kind: 'all', sort, limit }, OPTS);
  return res.items.map((i) => i.id);
}

/** Every page at `limit`, following `nextCursor` until it runs out (bounded). */
async function pagedOrder(sort: ListingSort, limit: number) {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 20; pageNo++) {
    const res = await listAvailableListings({ kind: 'all', sort, limit, cursor }, OPTS);
    out.push(...res.items.map((i) => i.id));
    cursor = res.nextCursor;
    if (!cursor) return { ids: out, pages: pageNo + 1 };
  }
  return { ids: out, pages: 20 };
}

// Plays (installs for off-site), then installs, then id DESC.
const POPULAR = ['apl_A', 'apl_B', 'apl_D', 'apl_E', 'apl_C', 'apl_G', 'apl_F'];
// Rating, then the popular key.
const TOP_RATED = ['apl_B', 'apl_A', 'apl_D', 'apl_E', 'apl_G', 'apl_F', 'apl_C'];

describe('store sort orders, executed', () => {
  it('🔴 "Most popular" ranks by plays, then installs, then id', async () => {
    // An installs-first key puts D first; a plays-only key pins E below C.
    expect(await order('popular')).toEqual(POPULAR);
  });

  it('🔴 an off-site app ranks on its installs, not last', async () => {
    const ids = await order('popular');
    // E (off-site, 25 installs) outranks C (12 plays, 7 installs)…
    expect(ids.indexOf('apl_E')).toBeLessThan(ids.indexOf('apl_C'));
    // …and loses to B (40 plays).
    expect(ids.indexOf('apl_B')).toBeLessThan(ids.indexOf('apl_E'));
  });

  it('🔴 "Top rated" ranks by rating, then plays, then installs, then id', async () => {
    // A, D, E, F and G sit at the unreviewed mid-pack score, ordered by the popular key.
    expect(await order('top-rated')).toEqual(TOP_RATED);
  });

  it('"Newest" is unchanged: creation time, newest first (invariant guard)', async () => {
    expect(await order('newest')).toEqual([
      'apl_A',
      'apl_B',
      'apl_C',
      'apl_D',
      'apl_E',
      'apl_F',
      'apl_G',
    ]);
  });

  it('"Name" is unchanged: case-insensitive A→Z (invariant guard)', async () => {
    expect(await order('name')).toEqual([
      'apl_B',
      'apl_D',
      'apl_C',
      'apl_A',
      'apl_E',
      'apl_F',
      'apl_G',
    ]);
  });

  it('🔴 a cursor minted before the key changed shape restarts at page 1, not mid-list', async () => {
    // The old encoding: no version field and a 20-digit installs-only popular key — here
    // the boundary after B (30 installs). Compared against the new 40-digit key it would
    // land at an arbitrary row; it must be read as "no cursor" instead.
    const oldCursor = Buffer.from(
      `${'30'.padStart(20, '0')}${String.fromCharCode(31)}apl_B`,
      'utf8'
    ).toString('base64url');
    const res = await listAvailableListings(
      { kind: 'all', sort: 'popular', limit: 2, cursor: oldCursor },
      OPTS
    );
    const first = await listAvailableListings({ kind: 'all', sort: 'popular', limit: 2 }, OPTS);
    expect(res.items.map((i) => i.id)).toEqual(['apl_A', 'apl_B']);
    expect(res.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
    expect(res.nextCursor).toBe(first.nextCursor);
  });

  // Page size 2: three boundaries. Size 3: the boundary falls between D and E, which tie on
  // the plays position (25) and are split by installs. Size 6: between G and F, which tie on
  // every metric, so only the id half of the keyset places the cursor.
  it.each([
    ['popular', 2, 4, POPULAR],
    ['popular', 3, 3, POPULAR],
    ['popular', 6, 2, POPULAR],
    ['top-rated', 2, 4, TOP_RATED],
    ['top-rated', 3, 3, TOP_RATED],
  ] as const)(
    '🔴 %s at page size %i pages through every row exactly once, in order',
    async (sort, size, expectedPages, expected) => {
      const { ids, pages } = await pagedOrder(sort, size);
      expect(pages).toBe(expectedPages);
      expect(ids).toEqual(expected);
    }
  );
});
