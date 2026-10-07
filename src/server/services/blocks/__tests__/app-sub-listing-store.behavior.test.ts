import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      dbMock.dbRead.$queryRaw(sql),
  bustCacheTag: vi.fn(async () => undefined),
}));
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

const { listAvailableListings } = await import('~/server/services/blocks/app-listing.service');

const OWNER = 7001;
const AUTHOR = 7002;
const PARENT = 'apl_PARENT';
const OTHER = 'apl_OTHER';
const CHILD_A = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A';
const CHILD_B = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2B';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261010120000_app_sub_listings/migration.sql'
);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, "username" text, "image" text);
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "url" text NOT NULL, "userId" integer NOT NULL,
      "nsfwLevel" integer NOT NULL DEFAULT 0, "ingestion" text NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "poi" boolean NOT NULL DEFAULT false, "minor" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false, "acceptableMinor" boolean NOT NULL DEFAULT false,
      "blockedFor" text
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
             app_blocks, "Image", "User" CASCADE;
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner'), (${AUTHOR}, 'author');
    INSERT INTO "Image" (id, url, "userId", "nsfwLevel") VALUES
      (1, 'parent-cover', ${OWNER}, 1), (2, 'item-a', ${AUTHOR}, 1);
    INSERT INTO app_blocks (id, status, current_version_deployed_at) VALUES
      ('ab_PARENT', 'approved', now()), ('ab_OTHER', 'approved', now());
    INSERT INTO app_listings (id, kind, slug, name, status, app_block_id, category, content_rating, cover_id, user_id, created_at) VALUES
      ('${PARENT}', 'onsite', 'custom-generators', 'Custom Generators', 'approved', 'ab_PARENT', 'generation', 'pg', 1, ${OWNER}, now() - interval '2 days'),
      ('${OTHER}', 'onsite', 'other-app', 'Other App', 'approved', 'ab_OTHER', 'tools', 'g', NULL, ${OWNER}, now() - interval '3 days');
    INSERT INTO app_listing_metrics (app_listing_id, install_count) VALUES ('${PARENT}', 50), ('${OTHER}', 10);
    INSERT INTO app_sub_listing_parents (parent_listing_id, enabled) VALUES ('${PARENT}', true);
    INSERT INTO app_sub_listings (id, parent_listing_id, item_key, author_user_id, title, tagline, image_id, sub_path, status, approved_at) VALUES
      ('${CHILD_A}', '${PARENT}', 'gen-a', ${AUTHOR}, 'Gen Alpha', 'first', 2, 'g/A', 'approved', now()),
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

async function page(opts: Partial<NonNullable<ListOpts>> = {}, sort = 'name' as const) {
  const res = await listAvailableListings(
    { kind: 'all', sort, limit: 50 },
    { ...BASE_OPTS, ...opts }
  );
  return res.items;
}
const ids = (items: { id: string }[]) => items.map((i) => i.id);
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

  it('covers every parent state the design names', () => {
    expect(PARENT_STATES).toHaveLength(11);
  });

  it.each(PARENT_STATES)('hides the children when the parent is $name', async (state) => {
    if (state.sql) await holder.db.exec(state.sql);
    const items = await page(state.opts);
    if (state.name !== 'the external-only scope') expect(ids(items)).toContain(OTHER);
    expect(childIds(items)).toEqual([]);
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

  it('falls back to the parent cover while the item image is still scanning', async () => {
    await holder.db.exec(
      `UPDATE "Image" SET "ingestion" = 'Pending', "nsfwLevel" = 0 WHERE id = 2`
    );
    expect((await page()).find((i) => i.id === CHILD_A)?.coverUrl).toBe('parent-cover');
  });

  it('orders a parent before its children on a tied sort key, and pages through them', async () => {
    const all = ids(await page({}, 'popular'));
    const p = all.indexOf(PARENT);
    // Children share the parent's popularity key; `tb` puts the parent first, then id DESC.
    expect(all.slice(p, p + 3)).toEqual([PARENT, CHILD_B, CHILD_A]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await listAvailableListings(
        { kind: 'all', sort: 'popular', limit: 1, cursor },
        BASE_OPTS
      );
      seen.push(...ids(res.items));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(seen).toEqual(all);
  });

  it('serves parents only while the sub-listing tables are absent', async () => {
    await holder.db.exec(`ALTER TABLE app_sub_listings RENAME TO app_sub_listings_hidden`);
    try {
      const items = await page();
      expect(ids(items).sort()).toEqual([OTHER, PARENT].sort());
    } finally {
      await holder.db.exec(`ALTER TABLE app_sub_listings_hidden RENAME TO app_sub_listings`);
    }
  });

  it('a staged edit to an approved child does not change the rendered card', async () => {
    await holder.db.exec(`
      UPDATE app_sub_listings
         SET pending_title = 'Gen Alpha v2', pending_tagline = 'second', pending_sub_path = 'g/A2',
             pending_image_id = NULL, pending_submitted_at = now()
       WHERE id = '${CHILD_A}'`);
    const card = (await page()).find((i) => i.id === CHILD_A);
    expect(card).toMatchObject({ name: 'Gen Alpha', tagline: 'first', coverUrl: 'item-a' });
    expect(card && 'runHref' in card && card.runHref).toBe(
      `/apps/run/custom-generators/g/A?sl=${CHILD_A}`
    );
  });
});
