import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  OfficialWriteClient,
  OfficialWriteTx,
} from '~/server/services/blocks/app-listing-official.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// `dbWrite` is only the default argument (the canonical db mock from the global setup); every
// call here passes its own client.

const {
  OFFICIAL_NOT_FOUND_MESSAGE,
  OFFICIAL_UNAVAILABLE_MESSAGE,
  SET_OFFICIAL_ACTION,
  officialChangeReason,
  readListingOfficialForRender,
  readListingOfficialMany,
  readListingOfficialManyForRender,
  setListingOfficialAsModerator,
} = await import('~/server/services/blocks/app-listing-official.service');

/**
 * The moderator-set Official flag, EXECUTED against an in-process Postgres carrying the real
 * migration. Every read and write in `app-listing-official.service` is raw SQL over a column
 * the Prisma client does not know (stripped on purpose), so a mocked client could not see the
 * properties that matter: the column default, the action CHECK the event insert must pass, the
 * revision guard, and that a rejected event rolls the flag back.
 *
 * The tables are cut down to the columns these statements touch. The moderation-events table
 * carries the action CHECK as it stood BEFORE this migration, so the widen is exercised too.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261224120200_app_listing_official/migration.sql'
);

const PRE_FEATURE_ACTIONS = [
  'delist',
  'relist',
  'claim',
  'purge',
  'report-resolve',
  'report-dismiss',
  'reset-to-pending',
  'owner-unpublish',
  'owner-republish',
  'message-owner',
  'purge-user-storage',
  'set-visibility',
  'rating-change',
  'storage-doc-hide',
  'storage-doc-unhide',
  'storage-doc-delete',
  'storage-doc-dismiss',
  'moderator-edit',
];

const BASE_SCHEMA = `
  CREATE TABLE "app_listings" (
    "id" TEXT PRIMARY KEY,
    "slug" TEXT NOT NULL UNIQUE,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision_of_id" TEXT REFERENCES "app_listings"("id") ON DELETE CASCADE,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT '2026-01-01T00:00:00Z'
  );
  CREATE TABLE "app_listing_moderation_events" (
    "id" TEXT PRIMARY KEY,
    "seq" SERIAL,
    "app_listing_id" TEXT,
    "slug" TEXT NOT NULL,
    "actor_user_id" INTEGER,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    CONSTRAINT "app_listing_mod_events_action_check"
      CHECK ("action" IN (${PRE_FEATURE_ACTIONS.map((a) => `'${a}'`).join(', ')}))
  );
`;

// Pairwise-distinct fixture ids, distinct from every constant an assertion names.
const LIVE = 'apl_live_0001';
const OTHER = 'apl_other_0002';
const SHADOW = 'apl_shadow_0003';
const MOD = 4242;

async function seed(pg: PGlite) {
  await pg.exec(`
    TRUNCATE "app_listings", "app_listing_moderation_events" CASCADE;
    INSERT INTO "app_listings" ("id", "slug", "status", "revision_of_id") VALUES
      ('${LIVE}', 'live-app', 'approved', NULL),
      ('${OTHER}', 'other-app', 'approved', NULL),
      ('${SHADOW}', 'rev-live-app', 'draft', '${LIVE}');
  `);
}

/** A transaction double over PGlite: real BEGIN/COMMIT/ROLLBACK, raw SQL through Prisma's
 *  tagged-template encoding, and the event delegate as a real INSERT (so the CHECK binds). */
function writeClient(pg: PGlite): OfficialWriteClient {
  const raw = pgliteRaw(pg);
  const tx: OfficialWriteTx = {
    $queryRaw: raw.queryRaw,
    $executeRaw: raw.executeRaw,
    appListingModerationEvent: {
      create: async ({ data }) =>
        pg.query(
          `INSERT INTO "app_listing_moderation_events"
            ("id", "app_listing_id", "slug", "actor_user_id", "action", "reason", "before", "after")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            data.id,
            data.appListingId,
            data.slug,
            data.actorUserId,
            data.action,
            data.reason,
            JSON.stringify(data.before),
            JSON.stringify(data.after),
          ]
        ),
    },
  };
  return {
    $transaction: async <T>(fn: (t: OfficialWriteTx) => Promise<T>): Promise<T> => {
      await pg.exec('BEGIN');
      try {
        const result = await fn(tx);
        await pg.exec('COMMIT');
        return result;
      } catch (err) {
        await pg.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

async function officialOf(pg: PGlite, id: string): Promise<boolean | null> {
  const res = await pg.query<{ is_official: boolean }>(
    `SELECT "is_official" FROM "app_listings" WHERE "id" = $1`,
    [id]
  );
  return res.rows[0]?.is_official ?? null;
}

async function events(pg: PGlite) {
  const res = await pg.query<{
    app_listing_id: string;
    slug: string;
    actor_user_id: number;
    action: string;
    reason: string;
    before: unknown;
    after: unknown;
  }>(
    `SELECT "app_listing_id", "slug", "actor_user_id", "action", "reason", "before", "after"
     FROM "app_listing_moderation_events" ORDER BY "seq"`
  );
  return res.rows;
}

describe('before the migration is applied', () => {
  const pg = new PGlite();
  const raw = pgliteRaw(pg);
  const db = { $queryRaw: raw.queryRaw };

  beforeAll(async () => {
    await pg.exec(BASE_SCHEMA);
    await seed(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  it('the batch read degrades to "none official" instead of throwing', async () => {
    await expect(readListingOfficialMany([LIVE, OTHER], db)).resolves.toEqual(new Set());
  });

  it('the render reads degrade too', async () => {
    await expect(readListingOfficialManyForRender([LIVE], db)).resolves.toEqual(new Set());
    await expect(readListingOfficialForRender(LIVE, db)).resolves.toBe(false);
  });

  it('the moderator write refuses with PRECONDITION_FAILED and records nothing', async () => {
    await expect(
      setListingOfficialAsModerator(
        { appListingId: LIVE, isOfficial: true, moderatorUserId: MOD },
        writeClient(pg)
      )
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: OFFICIAL_UNAVAILABLE_MESSAGE });
    expect(await events(pg)).toEqual([]);
  });
});

describe('a half-applied environment (column present, action CHECK not widened)', () => {
  const pg = new PGlite();

  beforeAll(async () => {
    await pg.exec(BASE_SCHEMA);
    await pg.exec(
      `ALTER TABLE "app_listings" ADD COLUMN "is_official" BOOLEAN NOT NULL DEFAULT false`
    );
    await seed(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  it('🔴 a rejected audit event rolls the flag write back — no unrecorded change', async () => {
    await expect(
      setListingOfficialAsModerator(
        { appListingId: LIVE, isOfficial: true, moderatorUserId: MOD },
        writeClient(pg)
      )
    ).rejects.toMatchObject({ code: '23514' });
    expect(await officialOf(pg, LIVE)).toBe(false);
    expect(await events(pg)).toEqual([]);
  });
});

describe('with the migration applied', () => {
  const pg = new PGlite();
  const raw = pgliteRaw(pg);
  const db = { $queryRaw: raw.queryRaw };
  let preExisting: boolean | null = null;

  beforeAll(async () => {
    await pg.exec(BASE_SCHEMA);
    // Rows that exist BEFORE the column is added must read the default.
    await seed(pg);
    const sql = readFileSync(MIGRATION, 'utf8');
    await pg.exec(sql);
    // Idempotent: a second application is a no-op, not an error.
    await pg.exec(sql);
    preExisting = await officialOf(pg, LIVE);
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await seed(pg);
  });

  it('a row that existed BEFORE the column was added reads NOT official (NOT NULL DEFAULT false)', async () => {
    expect(preExisting).toBe(false);
    await expect(readListingOfficialMany([LIVE, OTHER], db)).resolves.toEqual(new Set());
  });

  it('a moderator can SET the flag: written, read back, and audited', async () => {
    const res = await setListingOfficialAsModerator(
      { appListingId: LIVE, isOfficial: true, moderatorUserId: MOD },
      writeClient(pg)
    );
    expect(res).toEqual({ appListingId: LIVE, isOfficial: true, changed: true });
    expect(await officialOf(pg, LIVE)).toBe(true);
    // Only the targeted listing — not its neighbour.
    await expect(readListingOfficialMany([LIVE, OTHER], db)).resolves.toEqual(new Set([LIVE]));
    await expect(readListingOfficialForRender(LIVE, db)).resolves.toBe(true);
    await expect(readListingOfficialForRender(OTHER, db)).resolves.toBe(false);
    expect(await events(pg)).toEqual([
      {
        app_listing_id: LIVE,
        slug: 'live-app',
        actor_user_id: MOD,
        action: SET_OFFICIAL_ACTION,
        reason: officialChangeReason(true),
        before: { isOfficial: false },
        after: { isOfficial: true },
      },
    ]);
    expect(SET_OFFICIAL_ACTION).toBe('set-official');
  });

  it('a moderator can CLEAR the flag, and the clear is audited too', async () => {
    const client = writeClient(pg);
    await setListingOfficialAsModerator(
      { appListingId: LIVE, isOfficial: true, moderatorUserId: MOD },
      client
    );
    const res = await setListingOfficialAsModerator(
      { appListingId: LIVE, isOfficial: false, moderatorUserId: MOD },
      client
    );
    expect(res).toEqual({ appListingId: LIVE, isOfficial: false, changed: true });
    expect(await officialOf(pg, LIVE)).toBe(false);
    const rows = await events(pg);
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [{ isOfficial: false }, { isOfficial: true }],
      [{ isOfficial: true }, { isOfficial: false }],
    ]);
    expect(rows[1].reason).toBe(officialChangeReason(false));
    expect(officialChangeReason(false)).not.toBe(officialChangeReason(true));
  });

  it('setting the value it already has is an idempotent success that records nothing', async () => {
    const res = await setListingOfficialAsModerator(
      { appListingId: LIVE, isOfficial: false, moderatorUserId: MOD },
      writeClient(pg)
    );
    expect(res).toEqual({ appListingId: LIVE, isOfficial: false, changed: false });
    expect(await events(pg)).toEqual([]);
  });

  it('does not touch updated_at (a label, not a content change)', async () => {
    const before = await pg.query<{ updated_at: Date }>(
      `SELECT "updated_at" FROM "app_listings" WHERE "id" = $1`,
      [LIVE]
    );
    await setListingOfficialAsModerator(
      { appListingId: LIVE, isOfficial: true, moderatorUserId: MOD },
      writeClient(pg)
    );
    const after = await pg.query<{ updated_at: Date }>(
      `SELECT "updated_at" FROM "app_listings" WHERE "id" = $1`,
      [LIVE]
    );
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
  });

  it('a shadow revision id is refused as NOT_FOUND and nothing is written', async () => {
    await expect(
      setListingOfficialAsModerator(
        { appListingId: SHADOW, isOfficial: true, moderatorUserId: MOD },
        writeClient(pg)
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: OFFICIAL_NOT_FOUND_MESSAGE });
    expect(await officialOf(pg, SHADOW)).toBe(false);
    expect(await officialOf(pg, LIVE)).toBe(false);
    expect(await events(pg)).toEqual([]);
  });

  it('an unknown id is refused as NOT_FOUND', async () => {
    await expect(
      setListingOfficialAsModerator(
        { appListingId: 'apl_missing_0099', isOfficial: true, moderatorUserId: MOD },
        writeClient(pg)
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an empty id list issues no query', async () => {
    const spy = vi.fn();
    await expect(readListingOfficialMany([], { $queryRaw: spy })).resolves.toEqual(new Set());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('read postures on a NON-column failure', () => {
  const outage = Object.assign(new Error('relation "app_listings" does not exist'), {
    code: '42P01',
  });
  const failing = { $queryRaw: vi.fn(async () => Promise.reject(outage)) };

  it('the batch read PROPAGATES anything that is not a missing column', async () => {
    await expect(readListingOfficialMany([LIVE], failing)).rejects.toBe(outage);
  });

  it('the render reads degrade on ANY error, so a badge never takes a page down', async () => {
    await expect(readListingOfficialManyForRender([LIVE], failing)).resolves.toEqual(new Set());
    await expect(readListingOfficialForRender(LIVE, failing)).resolves.toBe(false);
  });

  it('a row is official only when its column says so, not merely because it came back', async () => {
    const lying = {
      $queryRaw: vi.fn(async () => [{ id: LIVE, isOfficial: false }, { id: OTHER }]),
    };
    await expect(readListingOfficialMany([LIVE, OTHER], lying)).resolves.toEqual(new Set());
  });
});
