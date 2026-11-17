import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
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
    async (sql: Prisma.Sql): Promise<unknown[]> => {
      holder.statements.push(sql);
      return dbMock.dbRead.$queryRaw(sql);
    },
  bustCacheTag: vi.fn(async () => undefined),
}));
import type * as CacheHelpers from '~/server/utils/cache-helpers';
// The beta columns are a separate manual-apply concern; these stand-in tables do not carry them.
vi.mock('~/server/services/blocks/app-listing-beta.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BetaService>()),
  readListingBetaManyForRender: vi.fn(async () => new Map()),
}));
import type * as BetaService from '~/server/services/blocks/app-listing-beta.service';

/**
 * The store grid hides a listing whose OWNER is banned or deleted — executed on real rows (the
 * catalog statement, unmodified, on PGlite), for both statements the grid can run: parents
 * only, and the parents + sub-listings union.
 *
 * The bug this pins: only the sub-listing arm joined `User`, and only for the sub-listing's
 * AUTHOR, so a banned or deleted user's own app stayed on `/apps`, in the related rails and in
 * `GET /api/v1/apps`. Every listing below differs from the visible one in its owner alone.
 */
const holder = {
  db: null as unknown as PGlite,
  /** Every catalog statement `listAvailableListings` sent to the cache layer, in order. */
  statements: [] as Prisma.Sql[],
};

const runSql = (query: Prisma.Sql) =>
  holder.db.query(query.text, query.values as unknown[]).then((r) => r.rows);
dbMock.dbRead.$queryRaw.mockImplementation(runSql);

// Card hydration is a Prisma `findMany`; answer it from the same database.
dbMock.dbRead.appListing.findMany.mockImplementation(
  async (args: { where: { id: { in: string[] } } }) => {
    const { rows } = await holder.db.query<{
      id: string;
      slug: string;
      name: string;
      user_id: number;
      updated_at: Date;
    }>(`SELECT id, slug, name, user_id, updated_at FROM app_listings WHERE id = ANY($1)`, [
      args.where.id.in,
    ]);
    return rows.map((r) => ({
      id: r.id,
      serialId: 1,
      kind: 'offsite',
      slug: r.slug,
      name: r.name,
      tagline: null,
      description: null,
      category: 'utility',
      contentRating: 'g',
      externalUrl: 'https://example.com/app',
      connectClientId: null,
      appBlockId: null,
      icon: null,
      cover: null,
      user: { id: r.user_id, username: `owner-${r.user_id}`, image: null },
      updatedAt: r.updated_at,
      metric: null,
      appBlock: null,
      screenshots: [],
    }));
  }
);

const { listAvailableListings, storeOwnerEligibleWhere } = await import(
  '~/server/services/blocks/app-listing.service'
);

const ACTIVE_OWNER = 8101;
const BANNED_OWNER = 8202;
const DELETED_OWNER = 8303;
const ACTIVE_AUTHOR = 8404;

const VISIBLE = 'apl_owner_active';
const OF_BANNED = 'apl_owner_banned';
const OF_DELETED = 'apl_owner_deleted';
const CHILD_OF_BANNED = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z3B';

const SUB_LISTINGS_MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261010120000_app_sub_listings/migration.sql'
);

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
      category text, content_rating text, icon_id integer, cover_id integer,
      user_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app_listing_metrics (
      app_listing_id text PRIMARY KEY, thumbs_up_count integer NOT NULL DEFAULT 0,
      thumbs_down_count integer NOT NULL DEFAULT 0, install_count integer NOT NULL DEFAULT 0,
      open_count integer NOT NULL DEFAULT 0
    );
  `);
  await holder.db.exec(readFileSync(SUB_LISTINGS_MIGRATION, 'utf8'));
  // An off-site child is listed only under a parent link template (a later migration's column).
  await holder.db.exec(`ALTER TABLE app_sub_listing_parents ADD COLUMN link_template text`);
});

afterAll(async () => {
  await holder.db.close();
});

beforeEach(async () => {
  holder.statements.length = 0;
  await holder.db.exec(`
    TRUNCATE app_sub_listings, app_sub_listing_parents, app_listing_metrics, app_listings,
             app_blocks, "Image", "Post", "User" CASCADE;
    INSERT INTO "User" (id, username, "bannedAt", "deletedAt") VALUES
      (${ACTIVE_OWNER}, 'active', NULL, NULL),
      (${BANNED_OWNER}, 'banned', now() - interval '1 hour', NULL),
      (${DELETED_OWNER}, 'deleted', NULL, now() - interval '1 hour'),
      (${ACTIVE_AUTHOR}, 'author', NULL, NULL);
    INSERT INTO app_listings (id, kind, slug, name, status, category, content_rating, user_id) VALUES
      ('${VISIBLE}', 'offsite', 'active-app', 'Active App', 'approved', 'utility', 'g', ${ACTIVE_OWNER}),
      ('${OF_BANNED}', 'offsite', 'banned-app', 'Banned App', 'approved', 'utility', 'g', ${BANNED_OWNER}),
      ('${OF_DELETED}', 'offsite', 'deleted-app', 'Deleted App', 'approved', 'utility', 'g', ${DELETED_OWNER});
    -- An approved child, by an ACTIVE author, of the banned owner's listing: only the parent's
    -- owner can keep it off the page.
    INSERT INTO app_sub_listing_parents (parent_listing_id, enabled, link_template)
      VALUES ('${OF_BANNED}', true, 'https://example.com/?item={id}');
    INSERT INTO app_sub_listings (id, parent_listing_id, item_key, author_user_id, title, sub_path, status, approved_at)
      VALUES ('${CHILD_OF_BANNED}', '${OF_BANNED}', 'item-1', ${ACTIVE_AUTHOR}, 'Item', 'item-1', 'approved', now());
  `);
});

async function gridIds(includeSubListings: boolean) {
  const { items } = await listAvailableListings(
    { kind: 'all', sort: 'name', limit: 50 },
    { scope: 'full', floor: 'public', redCapable: false, includeSubListings }
  );
  return items.map((i) => i.id).sort();
}

describe('store grid: a banned or deleted owner takes their listings with them', () => {
  it.each([
    ['parents only', false],
    ['parents + sub-listings', true],
  ] as const)(
    '%s: only the active owner’s listing is on the page',
    async (_name, includeSubListings) => {
      expect(await gridIds(includeSubListings)).toEqual([VISIBLE]);
    }
  );

  it('the banned owner’s listing returns once the ban is lifted', async () => {
    await holder.db.exec(`UPDATE "User" SET "bannedAt" = NULL WHERE id = ${BANNED_OWNER}`);
    expect(await gridIds(true)).toEqual([CHILD_OF_BANNED, OF_BANNED, VISIBLE].sort());
  });
});

/**
 * The owner rule is stated ONCE (`storeOwnerEligibleWhere`) and every arm of the catalog
 * statement uses it. This counts the rule's rendered SQL in the statements the grid actually
 * sends, so it fails when an arm stops using it (the bug above: the parent arm never had it)
 * and when a second, hand-spelled `"bannedAt"` check appears next to it (the old sub-listing
 * `JOIN "User"`), which could drift from the shared rule. The behaviour cases above cannot see
 * the second shape: a duplicate spelling that agrees today passes them.
 */
describe('owner-eligibility ledger', () => {
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it.each([
    // Parents only: the listing owner, once.
    ['parents only', false, { owner: 1, author: 0 }],
    // The union: the parent arm's listing owner, the child arm's parent owner, the child's author.
    ['parents + sub-listings', true, { owner: 2, author: 1 }],
  ] as const)('%s', async (_name, includeSubListings, expected) => {
    await gridIds(includeSubListings);
    expect(holder.statements).toHaveLength(1);
    const text = holder.statements[0].text;
    const owner = storeOwnerEligibleWhere(Prisma.sql`al.user_id`).text;
    const author = storeOwnerEligibleWhere(Prisma.sql`s.author_user_id`).text;
    expect(occurrences(text, owner)).toBe(expected.owner);
    expect(occurrences(text, author)).toBe(expected.author);
    expect(occurrences(text, '"bannedAt"')).toBe(expected.owner + expected.author);
    expect(occurrences(text, '"deletedAt"')).toBe(expected.owner + expected.author);
  });
});
