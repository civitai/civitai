import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { NsfwLevel } from '~/server/common/enums';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * `listStoreListingsBySlugs` is what keeps an app index search inside what THIS viewer may see in
 * the store: the index answers slugs, and only the listings the store grid's own eligibility
 * predicate admits for this viewer come back, in the index's order. Executed on real rows: the
 * id read is the service's unmodified SQL, run on PGlite. Only the Prisma `findMany` of the card
 * hydration is answered by hand, from the same database.
 */
const holder = { db: null as unknown as PGlite };

dbMock.dbRead.$queryRaw.mockImplementation((query: { text: string; values: unknown[] }) =>
  holder.db.query(query.text, query.values).then((r) => r.rows)
);
dbMock.dbRead.appListing.findMany.mockImplementation(
  async (args: { where: { id: { in: string[] } } }) => {
    const { rows } = await holder.db.query<{
      id: string;
      slug: string;
      name: string;
      kind: string;
      category: string | null;
      content_rating: string | null;
      status: string;
      app_block_id: string | null;
      user_id: number;
      updated_at: Date;
    }>(
      `SELECT id, slug, name, kind, category, content_rating, status, app_block_id, user_id, updated_at
       FROM app_listings WHERE id = ANY($1)`,
      [args.where.id.in]
    );
    return rows.map((r) => ({
      id: r.id,
      serialId: 1,
      kind: r.kind,
      slug: r.slug,
      name: r.name,
      tagline: null,
      description: null,
      category: r.category,
      contentRating: r.content_rating,
      status: r.status,
      externalUrl: r.kind === 'offsite' ? 'https://apps.invalid/app' : null,
      connectClientId: null,
      appBlockId: r.app_block_id,
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

const { listStoreListingsBySlugs } = await import('~/server/services/blocks/app-listing.service');

const OWNER = 9101;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (
      "id" integer PRIMARY KEY, "username" text, "image" text,
      "bannedAt" timestamptz, "deletedAt" timestamptz
    );
    CREATE TABLE app_blocks (
      id text PRIMARY KEY, status text NOT NULL, current_version_deployed_at timestamptz
    );
    CREATE TABLE app_listings (
      id text PRIMARY KEY, kind text NOT NULL, slug text NOT NULL UNIQUE, name text NOT NULL,
      status text NOT NULL, visibility text, revision_of_id text, app_block_id text,
      category text, content_rating text, user_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
});

afterAll(async () => {
  await holder.db.close();
});

beforeEach(async () => {
  setEnv({ APPS_DOMAIN: 'apps.invalid' });
  await holder.db.exec(`
    TRUNCATE app_listings, app_blocks, "User";
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner');
    INSERT INTO app_blocks (id, status, current_version_deployed_at)
      VALUES ('ab_live', 'approved', now());
    INSERT INTO app_listings (id, kind, slug, name, status, app_block_id, category, content_rating, user_id) VALUES
      ('al_off', 'offsite', 'off-utility', 'Off Utility', 'approved', NULL, 'utility', 'g', ${OWNER}),
      ('al_on', 'onsite', 'on-utility', 'On Utility', 'approved', 'ab_live', 'utility', 'g', ${OWNER}),
      ('al_gen', 'offsite', 'off-generation', 'Off Generation', 'approved', NULL, 'generation', 'pg', ${OWNER}),
      ('al_draft', 'offsite', 'still-a-draft', 'Still A Draft', 'draft', NULL, 'utility', 'g', ${OWNER}),
      ('al_rated', 'offsite', 'rated-r-app', 'Rated R App', 'approved', NULL, 'utility', 'r', ${OWNER});
  `);
});

const SFW: ListAvailableListingsOpts = {
  scope: 'full',
  floor: 'public',
  redCapable: false,
  viewerBrowsingLevel: NsfwLevel.PG,
};

async function slugsFor(
  slugs: string[],
  input: { kind?: 'all' | 'onsite' | 'offsite'; category?: 'utility' | 'generation' } = {},
  opts: ListAvailableListingsOpts = SFW
): Promise<string[]> {
  const cards = await listStoreListingsBySlugs(
    slugs,
    { kind: input.kind ?? 'all', category: input.category },
    opts
  );
  return cards.map((c) => c.slug);
}

describe('listStoreListingsBySlugs on real rows', () => {
  it('returns the listings in the order of the slugs, not the rows', async () => {
    expect(await slugsFor(['off-generation', 'on-utility', 'off-utility'])).toEqual([
      'off-generation',
      'on-utility',
      'off-utility',
    ]);
    expect(await slugsFor(['off-utility', 'on-utility', 'off-generation'])).toEqual([
      'off-utility',
      'on-utility',
      'off-generation',
    ]);
  });

  it('drops a listing that is not approved', async () => {
    expect(await slugsFor(['still-a-draft', 'off-utility'])).toEqual(['off-utility']);
  });

  it('drops a mature listing off a mature-capable host, and above the viewer level on one', async () => {
    expect(await slugsFor(['rated-r-app', 'off-utility'])).toEqual(['off-utility']);
    expect(
      await slugsFor(['rated-r-app', 'off-utility'], {}, { ...SFW, redCapable: true })
    ).toEqual(['off-utility']);
    // Positive control: the same listing for a viewer whose level admits R on such a host.
    expect(
      await slugsFor(
        ['rated-r-app', 'off-utility'],
        {},
        { ...SFW, redCapable: true, viewerBrowsingLevel: NsfwLevel.PG | NsfwLevel.R }
      )
    ).toEqual(['rated-r-app', 'off-utility']);
  });

  it('drops an on-site listing under the public-external scope', async () => {
    expect(
      await slugsFor(['on-utility', 'off-utility'], {}, { ...SFW, scope: 'public-external' })
    ).toEqual(['off-utility']);
    expect(await slugsFor(['on-utility', 'off-utility'])).toEqual(['on-utility', 'off-utility']);
  });

  it('drops a listing of another kind', async () => {
    expect(await slugsFor(['on-utility', 'off-utility'], { kind: 'offsite' })).toEqual([
      'off-utility',
    ]);
    expect(await slugsFor(['on-utility', 'off-utility'], { kind: 'onsite' })).toEqual([
      'on-utility',
    ]);
  });

  it('drops a listing of another category', async () => {
    expect(await slugsFor(['off-generation', 'off-utility'], { category: 'generation' })).toEqual([
      'off-generation',
    ]);
  });

  // Invariant guard, not a regression test: a slug names a listing, never a sub-listing, so a
  // sub-listing id among the slugs matches nothing and no sub-listing card is returned.
  it('never returns a sub-listing', async () => {
    expect(await slugsFor(['asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z3B', 'off-utility'])).toEqual([
      'off-utility',
    ]);
  });

  it('ignores slugs it does not know, and reads nothing for none', async () => {
    expect(await slugsFor(['not-a-listing'])).toEqual([]);
    dbMock.dbRead.$queryRaw.mockClear();
    expect(await slugsFor([])).toEqual([]);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
