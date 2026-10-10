import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * The store catalog statement, unmodified, executed on real rows.
 *
 * The REQUIRED regression for sub-listings: a child may only be visible while its parent is.
 * The SQL-string tests elsewhere cannot tell `AND` from `OR` or notice a condition applied to
 * the wrong arm; only running the statement can. The sub-listing tables come from the real
 * migration file, so this also proves that file applies.
 */
const holder = {
  db: null as unknown as PGlite,
  /** Runs once, right after the next moderator read: simulates a write racing the decision. */
  afterRead: null as null | (() => Promise<void>),
};

const runSql = (query: Prisma.Sql) =>
  holder.db.query(query.text, query.values as unknown[]).then((r) => r.rows);
dbMock.dbRead.$queryRaw.mockImplementation(runSql);

type ListingRow = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  category: string | null;
  content_rating: string | null;
  app_block_id: string | null;
  updated_at: Date;
  current_version_deployed_at: Date | null;
};

// Parent hydration is a Prisma `findMany`; answer it from the same database.
dbMock.dbRead.appListing.findMany.mockImplementation(
  async (args: { where: { id: { in: string[] } } }) => {
    const rows = (await holder.db.query(
      `SELECT al.id, al.kind, al.slug, al.name, al.category, al.content_rating, al.app_block_id,
              al.updated_at, ab.current_version_deployed_at
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
      contentRating: r.content_rating,
      externalUrl: null,
      connectClientId: null,
      appBlockId: r.app_block_id,
      icon: null,
      cover: null,
      user: { id: OWNER, username: 'owner', image: null },
      updatedAt: r.updated_at,
      metric: null,
      appBlock: {
        manifest: { page: {} },
        currentVersionDeployedAt: r.current_version_deployed_at,
        approvedScopes: [],
      },
      screenshots: [],
    }));
  }
);

// The moderator write path is Prisma; bridge the two calls it makes onto the same database so
// an approved edit is applied by the real service and then read back by the real store SQL.
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
dbMock.dbWrite.appSubListing.findUnique.mockImplementation(
  async (args: { where: { id: string } }) => {
    const { rows } = await holder.db.query<Record<string, unknown>>(
      'SELECT * FROM app_sub_listings WHERE id = $1',
      [args.where.id]
    );
    const row = rows[0];
    const race = holder.afterRead;
    holder.afterRead = null;
    if (race) await race();
    return row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])) : null;
  }
);
dbMock.dbWrite.appSubListing.updateMany.mockImplementation(
  async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const values: unknown[] = [];
    const set = Object.entries(args.data).map(([k, v]) => {
      values.push(v);
      return `${snake(k)} = $${values.length}`;
    });
    const where = Object.entries(args.where).flatMap(([k, v]) => {
      if (v === null) return [`${snake(k)} IS NULL`];
      // The compare-and-set's millisecond window: `{ gte, lt }`.
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const ops: Record<string, string> = { gte: '>=', lt: '<' };
        return Object.entries(v as Record<string, unknown>).map(([op, bound]) => {
          if (!ops[op]) throw new Error(`bridge: unsupported operator ${op}`);
          values.push(bound);
          return `${snake(k)} ${ops[op]} $${values.length}`;
        });
      }
      values.push(v);
      return [`${snake(k)} = $${values.length}`];
    });
    const res = await holder.db.query(
      `UPDATE app_sub_listings SET ${set.join(', ')} WHERE ${where.join(' AND ')}`,
      values
    );
    return { count: res.affectedRows ?? 0 };
  }
);

const { listAvailableListings } = await import('~/server/services/blocks/app-listing.service');
const { listAppListingsSchema, getAppListingsListQuery } = await import(
  '~/server/schema/blocks/app-listing-read.schema'
);
const { moderateSubListing } = await import('~/server/services/blocks/app-sub-listing.service');
const { hydrateSubListingCards } = await import(
  '~/server/services/blocks/app-sub-listing-store.service'
);

const OWNER = 7001;
const AUTHOR = 7002;
const PARENT = 'apl_PARENT';
const OTHER = 'apl_OTHER';
const OFFSITE = 'apl_OFFSITE';
const CHILD_A = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A';
const CHILD_B = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2B';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261010120000_app_sub_listings/migration.sql'
);
const CATALOG_MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261015120000_app_sub_listing_catalog_sync/migration.sql'
);
const GAME = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2G';
const TEMPLATE = 'https://games.example.com/?game={id}';

/** An approved child of the off-site listing, with an enabled parent row (no template yet). */
async function seedOffsiteChild() {
  await holder.db.exec(`
    INSERT INTO app_sub_listing_parents (parent_listing_id, enabled) VALUES ('${OFFSITE}', true);
    INSERT INTO app_sub_listings (id, parent_listing_id, item_key, author_user_id, title, sub_path, status, approved_at) VALUES
      ('${GAME}', '${OFFSITE}', 'neon-drift', ${AUTHOR}, 'Neon Drift', 'neon-drift', 'approved', now());
  `);
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (
      "id" integer PRIMARY KEY, "username" text, "image" text,
      "bannedAt" timestamptz, "deletedAt" timestamptz
    );
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "url" text NOT NULL, "userId" integer NOT NULL,
      "nsfwLevel" integer NOT NULL DEFAULT 0, "ingestion" text NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "poi" boolean NOT NULL DEFAULT false, "minor" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false, "acceptableMinor" boolean NOT NULL DEFAULT false,
      "blockedFor" text, "postId" integer
    );
    CREATE TABLE "Post" (
      "id" integer PRIMARY KEY, "publishedAt" timestamptz, "availability" text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE app_blocks (
      id text PRIMARY KEY, status text NOT NULL, current_version_deployed_at timestamptz
    );
    CREATE TABLE app_listings (
      id text PRIMARY KEY, kind text NOT NULL, slug text NOT NULL UNIQUE, name text NOT NULL,
      status text NOT NULL, visibility text, revision_of_id text, app_block_id text,
      category text, content_rating text, icon_id integer, cover_id integer, user_id integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app_listing_metrics (
      app_listing_id text PRIMARY KEY, thumbs_up_count integer NOT NULL DEFAULT 0,
      thumbs_down_count integer NOT NULL DEFAULT 0, install_count integer NOT NULL DEFAULT 0
    );
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await holder.db.close();
});

/** A visible parent with two approved children, plus an unrelated visible listing. */
async function seed() {
  await holder.db.exec(`
    TRUNCATE app_sub_listings, app_sub_listing_parents, app_listing_metrics, app_listings,
             app_blocks, "Image", "Post", "User" CASCADE;
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner'), (${AUTHOR}, 'author');
    INSERT INTO "Post" (id, "publishedAt") VALUES (1, now() - interval '1 day');
    INSERT INTO "Image" (id, url, "userId", "nsfwLevel", "postId") VALUES
      (1, 'parent-cover', ${OWNER}, 1, NULL), (2, 'item-a', ${AUTHOR}, 1, 1);
    INSERT INTO app_blocks (id, status, current_version_deployed_at) VALUES
      ('ab_PARENT', 'approved', now()), ('ab_OTHER', 'approved', now());
    INSERT INTO app_listings (id, kind, slug, name, status, app_block_id, category, content_rating, cover_id, user_id, created_at) VALUES
      ('${PARENT}', 'onsite', 'custom-generators', 'Custom Generators', 'approved', 'ab_PARENT', 'generation', 'pg', 1, ${OWNER}, now() - interval '2 days'),
      ('${OTHER}', 'onsite', 'other-app', 'Other App', 'approved', 'ab_OTHER', 'tools', 'g', NULL, ${OWNER}, now() - interval '3 days'),
      ('${OFFSITE}', 'offsite', 'zeta-offsite', 'Zeta Offsite', 'approved', NULL, 'tools', 'g', NULL, ${OWNER}, now() - interval '4 days');
    INSERT INTO app_listing_metrics (app_listing_id, install_count) VALUES ('${PARENT}', 50), ('${OTHER}', 10);
    INSERT INTO app_sub_listing_parents (parent_listing_id, enabled) VALUES ('${PARENT}', true);
    INSERT INTO app_sub_listings (id, parent_listing_id, item_key, author_user_id, title, tagline, image_id, sub_path, status, approved_at) VALUES
      ('${CHILD_A}', '${PARENT}', 'gen-a', ${AUTHOR}, 'Gen Alpha', 'first', 2, 'g/A', 'approved', now() - interval '1 day'),
      ('${CHILD_B}', '${PARENT}', 'gen-b', ${AUTHOR}, 'Gen Beta', NULL, NULL, 'g/B', 'approved', now());
  `);
}

type ListOpts = Parameters<typeof listAvailableListings>[1];
const BASE_OPTS = {
  scope: 'full',
  floor: 'public',
  redCapable: false,
  includeSubListings: true,
} as const satisfies ListOpts;

async function page(opts: Partial<NonNullable<ListOpts>> = {}, sort: ListingSort = 'name') {
  const res = await listAvailableListings(
    { kind: 'all', sort, limit: 50 },
    { ...BASE_OPTS, ...opts }
  );
  return res.items;
}
const ids = (items: { id: string }[]) => items.map((i) => i.id);
async function versionOf(id: string) {
  const { rows } = await holder.db.query<{ updated_at: Date }>(
    'SELECT updated_at FROM app_sub_listings WHERE id = $1',
    [id]
  );
  return rows[0].updated_at.toISOString();
}
const childIds = (items: { id: string }[]) => ids(items).filter((id) => id.startsWith('asl_'));

beforeEach(seed);

describe('store catalog with sub-listings, executed', () => {
  it('shows both approved children of an approved parent', async () => {
    const items = await page();
    expect(childIds(items).sort()).toEqual([CHILD_A, CHILD_B]);
    expect(ids(items)).toContain(PARENT);
  });

  it('renders the child card from the live columns, linked under the parent', async () => {
    const card = (await page()).find((i) => i.id === CHILD_A);
    expect(card).toMatchObject({
      cardType: 'sub-listing',
      name: 'Gen Alpha',
      tagline: 'first',
      kind: 'onsite',
      category: 'generation',
      contentRating: 'pg',
      coverUrl: 'item-a',
      creator: { id: AUTHOR, username: 'author' },
      parent: { id: PARENT, slug: 'custom-generators', name: 'Custom Generators' },
      runHref: `/apps/run/custom-generators/g/A?sl=${CHILD_A}`,
    });
  });

  it('shows nothing extra when the flag is off', async () => {
    expect(childIds(await page({ includeSubListings: false }))).toEqual([]);
  });

  /**
   * Each case breaks exactly ONE parent condition. The unrelated listing must stay visible in
   * every case (so an empty page cannot pass) and the parent's children must vanish.
   */
  const PARENT_STATES: { name: string; sql?: string; opts?: Partial<NonNullable<ListOpts>> }[] = [
    { name: 'removed', sql: `UPDATE app_listings SET status = 'removed' WHERE id = '${PARENT}'` },
    { name: 'rejected', sql: `UPDATE app_listings SET status = 'rejected' WHERE id = '${PARENT}'` },
    { name: 'pending', sql: `UPDATE app_listings SET status = 'pending' WHERE id = '${PARENT}'` },
    {
      name: 'visibility private',
      sql: `UPDATE app_listings SET visibility = 'private' WHERE id = '${PARENT}'`,
    },
    {
      name: 'moderators-only under the public floor',
      sql: `UPDATE app_listings SET visibility = 'moderators' WHERE id = '${PARENT}'`,
    },
    {
      name: 'a shadow revision',
      sql: `UPDATE app_listings SET revision_of_id = '${OTHER}' WHERE id = '${PARENT}'`,
    },
    {
      name: 'undeployed',
      sql: `UPDATE app_blocks SET current_version_deployed_at = NULL WHERE id = 'ab_PARENT'`,
    },
    {
      name: 'suspended block',
      sql: `UPDATE app_blocks SET status = 'suspended' WHERE id = 'ab_PARENT'`,
    },
    {
      name: 'too mature for the host',
      sql: `UPDATE app_listings SET content_rating = 'r' WHERE id = '${PARENT}'`,
    },
    { name: 'the external-only scope', opts: { scope: 'public-external' } },
    {
      name: 'parent switch disabled',
      sql: `UPDATE app_sub_listing_parents SET enabled = false WHERE parent_listing_id = '${PARENT}'`,
    },
  ];

  it.each(PARENT_STATES)('hides the children when the parent is $name', async (state) => {
    if (state.sql) await holder.db.exec(state.sql);
    const items = await page(state.opts);
    // A listing that must still show under this state, so an empty page cannot pass.
    expect(ids(items)).toContain(state.opts?.scope === 'public-external' ? OFFSITE : OTHER);
    expect(childIds(items)).toEqual([]);
  });

  it.each(['bannedAt', 'deletedAt'])('hides the items of an author with %s set', async (col) => {
    await holder.db.exec(`UPDATE "User" SET "${col}" = now() WHERE id = ${AUTHOR}`);
    const items = await page();
    expect(ids(items)).toContain(PARENT);
    expect(childIds(items)).toEqual([]);
  });

  it('a banned author’s items take no slot on the page', async () => {
    await holder.db.exec(`UPDATE "User" SET "bannedAt" = now() WHERE id = ${AUTHOR}`);
    const res = await listAvailableListings({ kind: 'all', sort: 'name', limit: 2 }, BASE_OPTS);
    expect(ids(res.items)).toEqual([PARENT, OTHER]);
  });

  it.each([
    [{ kind: 'onsite' }, true],
    [{ kind: 'offsite' }, false],
    [{ category: 'generation' }, true],
    [{ category: 'tools' }, false],
  ] as const)('follows the parent through the filter %o', async (filter, shown) => {
    const res = await listAvailableListings(
      { kind: 'all', sort: 'name', limit: 50, ...filter },
      BASE_OPTS
    );
    expect(childIds(res.items).length).toBe(shown ? 2 : 0);
  });

  it('a moderator floor sees the children of a moderators-only parent', async () => {
    await holder.db.exec(
      `UPDATE app_listings SET visibility = 'moderators' WHERE id = '${PARENT}'`
    );
    expect(childIds(await page({ floor: 'moderators' })).sort()).toEqual([CHILD_A, CHILD_B]);
  });

  it.each(['pending', 'hidden', 'withdrawn'])('hides a %s child', async (status) => {
    await holder.db.exec(
      `UPDATE app_sub_listings SET status = '${status}' WHERE id = '${CHILD_A}'`
    );
    expect(childIds(await page())).toEqual([CHILD_B]);
  });

  // Hydration also drops non-approved rows, so only a short page can show the id query
  // admitting one: it would take a slot and the page would come back one card short.
  it('a non-approved child takes no slot on the page', async () => {
    await holder.db.exec(`UPDATE app_sub_listings SET status = 'pending' WHERE id = '${CHILD_A}'`);
    const res = await listAvailableListings({ kind: 'all', sort: 'name', limit: 2 }, BASE_OPTS);
    expect(ids(res.items)).toEqual([PARENT, CHILD_B]);
  });

  it('applies the mature filter to the child itself', async () => {
    await holder.db.exec(
      `UPDATE app_sub_listings SET content_rating = 'x' WHERE id = '${CHILD_A}'`
    );
    expect(childIds(await page())).toEqual([CHILD_B]);
    expect(childIds(await page({ redCapable: true })).sort()).toEqual([CHILD_A, CHILD_B]);
  });

  it('shows the stricter of parent and child rating', async () => {
    await holder.db.exec(
      `UPDATE app_sub_listings SET content_rating = 'pg13' WHERE id = '${CHILD_A}'`
    );
    const card = (await page()).find((i) => i.id === CHILD_A);
    expect(card?.contentRating).toBe('pg13');
    const other = (await page()).find((i) => i.id === CHILD_B);
    expect(other?.contentRating).toBe('pg');
  });

  it('falls back to the parent cover when the item image is not cleared for the viewer', async () => {
    await holder.db.exec(`UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = 2`);
    const card = (await page()).find((i) => i.id === CHILD_A);
    expect(card?.coverUrl).toBe('parent-cover');
  });

  // Publicity is checked at submit, and re-checked here on every render: a post made private,
  // unpublished or deleted after the card was approved stops showing its image.
  it.each([
    ['made private', `UPDATE "Post" SET availability = 'Private' WHERE id = 1`],
    ['unpublished', `UPDATE "Post" SET "publishedAt" = NULL WHERE id = 1`],
    ['scheduled', `UPDATE "Post" SET "publishedAt" = now() + interval '1 day' WHERE id = 1`],
    ['deleted', `UPDATE "Image" SET "postId" = NULL WHERE id = 2; DELETE FROM "Post" WHERE id = 1`],
  ])('falls back to the parent cover when the image post is %s', async (_l, sql) => {
    // Positive control: the image shows while its post is public.
    expect((await page()).find((i) => i.id === CHILD_A)?.coverUrl).toBe('item-a');
    await holder.db.exec(sql);
    expect((await page()).find((i) => i.id === CHILD_A)?.coverUrl).toBe('parent-cover');
  });

  it('falls back to the parent cover while the item image is still scanning', async () => {
    await holder.db.exec(
      `UPDATE "Image" SET "ingestion" = 'Pending', "nsfwLevel" = 0 WHERE id = 2`
    );
    expect((await page()).find((i) => i.id === CHILD_A)?.coverUrl).toBe('parent-cover');
  });

  it('orders a parent before its children on a tied sort key', async () => {
    const all = ids(await page({}, 'popular'));
    const p = all.indexOf(PARENT);
    // Children share the parent's popularity key; `tb` puts the parent first, then id DESC.
    expect(all.slice(p, p + 3)).toEqual([PARENT, CHILD_B, CHILD_A]);
  });

  it.each(['name', 'newest', 'popular', 'top-rated'] as const)(
    'pages through every card exactly once under the %s sort',
    async (sort) => {
      const all = ids(await page({}, sort));
      expect(all).toHaveLength(5);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await listAvailableListings({ kind: 'all', sort, limit: 1, cursor }, BASE_OPTS);
        seen.push(...ids(res.items));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeUndefined();
      expect(seen).toEqual(all);
    }
  );

  // The name sort key is 64 CHARACTERS, and a character can be 4 bytes of UTF-8, so a page
  // ending on a long non-ASCII title produced a cursor longer than the input schema accepted:
  // the next page failed validation and paging stopped there.
  it.each([
    ['CJK', '漢'.repeat(70)],
    ['emoji', '🎨'.repeat(70)],
  ])(
    'a page ending on a long %s title yields a cursor the input schema accepts',
    async (_l, title) => {
      await holder.db.query(`UPDATE app_sub_listings SET title = $1 WHERE id = $2`, [
        title,
        CHILD_A,
      ]);
      await holder.db.query(`UPDATE app_listings SET name = $1 WHERE id = $2`, [title, OTHER]);
      const all = ids(await page({}, 'name'));
      expect(all).toHaveLength(5);
      const seen: string[] = [];
      let cursor: string | undefined;
      let boundaries = 0;
      for (let i = 0; i < 10; i++) {
        // Through the real input schemas (tRPC and REST), as a client's next request would be.
        const input = listAppListingsSchema.parse({ kind: 'all', sort: 'name', limit: 1, cursor });
        getAppListingsListQuery().parse({ sort: 'name', limit: '1', cursor });
        const res = await listAvailableListings(input, BASE_OPTS);
        seen.push(...ids(res.items));
        if (res.items.some((it) => it.name === title)) boundaries++;
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      // Positive control: both long-titled cards (a child and a parent) ended a page.
      expect(boundaries).toBe(2);
      expect(seen).toEqual(all);
    }
  );

  // A cursor taken on a child row carries an `asl_` id. If the next page runs the parents-only
  // statement (the flag turned off, or the tables went missing, between two pages), every parent
  // on that sort key was already served, so none may come back.
  it('a child cursor resumed on the parents-only path does not repeat a parent', async () => {
    const first = await listAvailableListings(
      { kind: 'all', sort: 'popular', limit: 2 },
      BASE_OPTS
    );
    // Children tie with the parent on `popular`, and the parent sorts first.
    expect(ids(first.items)).toEqual([PARENT, CHILD_B]);
    const next = await listAvailableListings(
      { kind: 'all', sort: 'popular', limit: 50, cursor: first.nextCursor },
      { ...BASE_OPTS, includeSubListings: false }
    );
    expect(ids(next.items)).not.toContain(PARENT);
    // Positive control: the rest of the catalog is still served.
    expect(ids(next.items)).toEqual([OTHER, OFFSITE]);
  });

  it('shows the item image only within the viewer level, on a red host, under its rating', async () => {
    await holder.db.exec(`
      UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = 2;
      UPDATE app_sub_listings SET content_rating = 'r' WHERE id = '${CHILD_A}'`);
    const cover = async (opts: Partial<NonNullable<ListOpts>>) =>
      (await page(opts)).find((i) => i.id === CHILD_A)?.coverUrl;
    expect(await cover({ redCapable: true, viewerBrowsingLevel: 7 })).toBe('item-a');
    expect(await cover({ redCapable: true, viewerBrowsingLevel: 1 })).toBe('parent-cover');
    expect(await cover({ redCapable: true })).toBe('parent-cover');
  });

  it('hydration renders only approved items by authors in good standing', async () => {
    const viewer = { redCapable: false };
    const both = await hydrateSubListingCards(dbMock.dbRead, [CHILD_A, CHILD_B], viewer);
    expect([...both.keys()].sort()).toEqual([CHILD_A, CHILD_B]);
    await holder.db.exec(`UPDATE app_sub_listings SET status = 'hidden' WHERE id = '${CHILD_A}'`);
    const one = await hydrateSubListingCards(dbMock.dbRead, [CHILD_A, CHILD_B], viewer);
    expect([...one.keys()]).toEqual([CHILD_B]);
    await holder.db.exec(`UPDATE "User" SET "bannedAt" = now() WHERE id = ${AUTHOR}`);
    expect((await hydrateSubListingCards(dbMock.dbRead, [CHILD_B], viewer)).size).toBe(0);
  });

  it('serves parents only while the sub-listing tables are absent', async () => {
    await holder.db.exec(`
      ALTER TABLE app_sub_listings RENAME TO app_sub_listings_hidden;
      ALTER TABLE app_sub_listing_parents RENAME TO app_sub_listing_parents_hidden`);
    try {
      const items = await page();
      expect(ids(items).sort()).toEqual([OFFSITE, OTHER, PARENT].sort());
    } finally {
      await holder.db.exec(`
        ALTER TABLE app_sub_listings_hidden RENAME TO app_sub_listings;
        ALTER TABLE app_sub_listing_parents_hidden RENAME TO app_sub_listing_parents`);
    }
  });

  it('a half-applied schema surfaces instead of degrading to parents only', async () => {
    await holder.db.exec(`ALTER TABLE app_sub_listing_parents RENAME COLUMN enabled TO enabled_x`);
    try {
      await expect(page()).rejects.toThrow(/enabled/);
    } finally {
      await holder.db.exec(
        `ALTER TABLE app_sub_listing_parents RENAME COLUMN enabled_x TO enabled`
      );
    }
  });

  it('a staged edit does not change the rendered card, and approving it does', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, url, "userId", "nsfwLevel", "postId") VALUES (3, 'item-a-v2', ${AUTHOR}, 1, 1);
      UPDATE app_sub_listings
         SET pending_title = 'Gen Alpha v2', pending_tagline = 'second', pending_sub_path = 'g/A2',
             pending_image_id = 3, pending_content_rating = 'pg13',
             pending_submitted_at = date_trunc('milliseconds', now()),
             updated_at = date_trunc('milliseconds', now())
       WHERE id = '${CHILD_A}'`);
    const card = async () => (await page()).find((i) => i.id === CHILD_A);

    expect(await card()).toMatchObject({
      name: 'Gen Alpha',
      tagline: 'first',
      coverUrl: 'item-a',
      contentRating: 'pg',
      runHref: `/apps/run/custom-generators/g/A?sl=${CHILD_A}`,
    });

    await moderateSubListing({
      input: { id: CHILD_A, action: 'approve-edit', version: await versionOf(CHILD_A) },
      moderatorId: OWNER,
    });

    expect(await card()).toMatchObject({
      name: 'Gen Alpha v2',
      tagline: 'second',
      coverUrl: 'item-a-v2',
      contentRating: 'pg13',
      runHref: `/apps/run/custom-generators/g/A2?sl=${CHILD_A}`,
    });
    const { rows } = await holder.db.query<Record<string, unknown>>(
      `SELECT status, pending_submitted_at, moderated_by_id FROM app_sub_listings WHERE id = $1`,
      [CHILD_A]
    );
    expect(rows[0]).toEqual({
      status: 'approved',
      pending_submitted_at: null,
      moderated_by_id: OWNER,
    });
  });

  it('an author edit landing between the moderator’s read and write is not approved unseen', async () => {
    await holder.db.exec(`
      UPDATE app_sub_listings
         SET pending_title = 'Seen edit', pending_sub_path = 'g/A',
             pending_submitted_at = date_trunc('milliseconds', now()),
             updated_at = date_trunc('milliseconds', now()) - interval '1 second'
       WHERE id = '${CHILD_A}'`);
    const version = await versionOf(CHILD_A);
    holder.afterRead = async () => {
      await holder.db.exec(`
        UPDATE app_sub_listings
           SET pending_title = 'Unseen edit', updated_at = date_trunc('milliseconds', now())
         WHERE id = '${CHILD_A}'`);
    };
    await expect(
      moderateSubListing({
        input: { id: CHILD_A, action: 'approve-edit', version },
        moderatorId: OWNER,
      })
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const { rows } = await holder.db.query<{ title: string; pending_title: string }>(
      `SELECT title, pending_title FROM app_sub_listings WHERE id = $1`,
      [CHILD_A]
    );
    expect(rows[0]).toEqual({ title: 'Gen Alpha', pending_title: 'Unseen edit' });
  });

  it('a decision on an out-of-date version is refused before anything is written', async () => {
    await holder.db.exec(
      `UPDATE app_sub_listings SET status = 'pending', updated_at = date_trunc('milliseconds', now()) WHERE id = '${CHILD_A}'`
    );
    await expect(
      moderateSubListing({
        input: { id: CHILD_A, action: 'approve', version: '2020-01-01T00:00:00.000Z' },
        moderatorId: OWNER,
      })
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(childIds(await page())).toEqual([CHILD_B]);
  });

  it('a row whose updated_at Postgres wrote at microsecond precision can still be moderated', async () => {
    // Not truncated: the column default and hand edits write microseconds.
    await holder.db.exec(`
      UPDATE app_sub_listings
         SET status = 'pending',
             updated_at = date_trunc('milliseconds', clock_timestamp()) + interval '357 microseconds'
       WHERE id = '${CHILD_A}'`);
    const { rows } = await holder.db.query<{ us: number }>(
      `SELECT (extract(microseconds FROM updated_at)::int % 1000) AS us FROM app_sub_listings WHERE id = $1`,
      [CHILD_A]
    );
    // Positive control: the fixture really carries sub-millisecond digits.
    expect(rows[0].us).toBe(357);
    await expect(
      moderateSubListing({
        input: { id: CHILD_A, action: 'approve', version: await versionOf(CHILD_A) },
        moderatorId: OWNER,
      })
    ).resolves.toMatchObject({ status: 'approved' });
    expect(childIds(await page()).sort()).toEqual([CHILD_A, CHILD_B]);
  });
});

describe('an off-site parent before the link_template migration', () => {
  it('serves on-site children as before and no off-site child', async () => {
    await seedOffsiteChild();
    const items = await page();
    expect(childIds(items).sort()).toEqual([CHILD_A, CHILD_B]);
    expect(ids(items)).toContain(OFFSITE);
    const viewer = { redCapable: false };
    expect((await hydrateSubListingCards(dbMock.dbRead, [GAME], viewer)).size).toBe(0);
  });
});

describe('an off-site parent with a link template', () => {
  beforeAll(async () => {
    const sql = readFileSync(CATALOG_MIGRATION, 'utf8');
    await holder.db.exec(sql);
    // Idempotent: a re-run is a no-op.
    await holder.db.exec(sql);
  });

  const setTemplate = (id: string, template: string | null) =>
    holder.db.query(
      'UPDATE app_sub_listing_parents SET link_template = $1 WHERE parent_listing_id = $2',
      [template, id]
    );

  it('shows its approved child, linked out through the template', async () => {
    await seedOffsiteChild();
    await setTemplate(OFFSITE, TEMPLATE);
    const items = await page();
    expect(childIds(items).sort()).toEqual([CHILD_A, CHILD_B, GAME]);
    expect(items.find((i) => i.id === GAME)).toMatchObject({
      cardType: 'sub-listing',
      name: 'Neon Drift',
      kind: 'offsite',
      runHref: 'https://games.example.com/?game=neon-drift',
      external: true,
      parent: { id: OFFSITE, slug: 'zeta-offsite' },
    });
    // On-site children keep their run-route link and are not marked external.
    const onsite = items.find((i) => i.id === CHILD_A) as Record<string, unknown>;
    expect(onsite.runHref).toBe(`/apps/run/custom-generators/g/A?sl=${CHILD_A}`);
    expect(onsite).not.toHaveProperty('external');
  });

  it('hides the child while the parent has no template', async () => {
    await seedOffsiteChild();
    expect(childIds(await page()).sort()).toEqual([CHILD_A, CHILD_B]);
  });

  it('a child of a parent without a template takes no slot on the page', async () => {
    await seedOffsiteChild();
    const all = ids(await page());
    expect(all).not.toContain(GAME);
    const res = await listAvailableListings(
      { kind: 'all', sort: 'name', limit: all.length - 1 },
      BASE_OPTS
    );
    expect(ids(res.items)).toEqual(all.slice(0, -1));
    // Positive control: with a template the same page does give the child a slot.
    await setTemplate(OFFSITE, TEMPLATE);
    const withTemplate = await listAvailableListings(
      { kind: 'all', sort: 'name', limit: all.length - 1 },
      BASE_OPTS
    );
    expect(ids(withTemplate.items)).toContain(GAME);
  });

  it('hides the child when the parent switch is off, even with a template', async () => {
    await seedOffsiteChild();
    await setTemplate(OFFSITE, TEMPLATE);
    await holder.db.exec(
      `UPDATE app_sub_listing_parents SET enabled = false WHERE parent_listing_id = '${OFFSITE}'`
    );
    expect(childIds(await page()).sort()).toEqual([CHILD_A, CHILD_B]);
  });

  it('still hides an on-site child whose block is not approved, even with a template set', async () => {
    await seedOffsiteChild();
    await setTemplate(OFFSITE, TEMPLATE);
    await setTemplate(PARENT, TEMPLATE);
    await holder.db.exec(`UPDATE app_blocks SET status = 'suspended' WHERE id = 'ab_PARENT'`);
    // Positive control in the same page: the off-site child is served.
    expect(childIds(await page())).toEqual([GAME]);
  });

  it.each([
    ['http, not https', 'http://games.example.com/?game={id}'],
    ['no placeholder', 'https://games.example.com/'],
    ['two placeholders', 'https://games.example.com/{id}?g={id}'],
    ['a placeholder in the host', 'https://{id}.example.com/'],
  ])('the column refuses a template with %s', async (_name, template) => {
    await seedOffsiteChild();
    await expect(setTemplate(OFFSITE, template)).rejects.toThrow(/link_template_check/);
  });
});
