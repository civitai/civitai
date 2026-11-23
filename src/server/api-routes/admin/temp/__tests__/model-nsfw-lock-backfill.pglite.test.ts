import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The backfill's own selector and UPDATE against PGlite: which scan-locked models it may unlock, and
 * what the unlock writes. The account hold is the real `ownerHeldSql` over stand-ins for the tables it reads. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { countScanLocks, nextScanLockBatch, unlockScanLocks } = await import(
  '~/server/api-routes/admin/temp/model-nsfw-lock-backfill'
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, nsfw boolean NOT NULL DEFAULT true,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "deletedAt" timestamp(3), "lockedProperties" text[], meta jsonb
    );
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text NOT NULL,
      "entityId" int NOT NULL, "createdAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL, status text NOT NULL
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]', "reportSentAt" timestamp(3), "archivedAt" timestamp(3)
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text);
    CREATE TABLE "EvidenceHeldUser" ("userId" int NOT NULL);
    CREATE TABLE "EvidenceHold" (id serial PRIMARY KEY, "userId" int NOT NULL, "releasedAt" timestamp(3));
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb);
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

const LOCKED_AT = '2026-10-20T00:00:00.000Z';
const scanMarker = { systemNsfwLock: { source: 'text-scan', at: LOCKED_AT } };

/** A scan-locked model owned by its own user, so an owner row touches only that model. */
async function model(id: number, fields: { meta?: unknown; locks?: string[]; sql?: string } = {}) {
  await db.query(
    `INSERT INTO "Model" (id, "userId", "lockedProperties", meta) VALUES ($1, $1, $2, $3)`,
    [id, fields.locks ?? ['nsfw', 'tags'], fields.meta ?? scanMarker]
  );
  await db.query(`INSERT INTO "User" (id, meta) VALUES ($1, '{}')`, [id]);
  if (fields.sql) await db.exec(fields.sql.replaceAll('$ID', String(id)));
}

const ELIGIBLE = 1;
const ELIGIBLE_RULED_BEFORE = 2; // a moderator ruled before the lock
const ELIGIBLE_SYSTEM_RULED = 3; // the system's own ruling since the lock
const excluded: [string, number, Parameters<typeof model>[1]][] = [
  [
    'a moderator ruled on its nsfw since the lock',
    10,
    {
      sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'unlockProperty:nsfw', 'model', $ID, '2026-10-21')`,
    },
  ],
  [
    'a moderator rejected a lock review since the lock',
    11,
    {
      sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'rejectLockReview', 'model', $ID, '2026-10-21')`,
    },
  ],
  ['its marker has no readable time', 12, { meta: { systemNsfwLock: { source: 'text-scan' } } }],
  [
    'a lock review is pending',
    13,
    {
      sql: `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Model', $ID, 'Pending')`,
    },
  ],
  ['it is a minor model', 14, { sql: `UPDATE "Model" SET minor = true WHERE id = $ID` }],
  ['it is a poi model', 15, { sql: `UPDATE "Model" SET poi = true WHERE id = $ID` }],
  [
    'its owner is the subject of a CSAM report',
    16,
    {
      sql: `INSERT INTO "CsamReport" ("userId") VALUES ($ID)`,
    },
  ],
  [
    "its owner is a CSAM report's secondary user",
    17,
    {
      sql: `INSERT INTO "CsamReport" ("userId", details) VALUES (999, '{"secondaryUserId": "$ID"}')`,
    },
  ],
  [
    'its owner had an evidence hold, even a released one',
    18,
    {
      sql: `INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES ($ID, '2026-01-01')`,
    },
  ],
  [
    'its owner has a SexualMinor ban',
    19,
    {
      sql: `UPDATE "User" SET meta = '{"banDetails": {"reasonCode": "SexualMinorGenerator"}}' WHERE id = $ID`,
    },
  ],
  [
    'its owner is under an account hold',
    20,
    {
      sql: `INSERT INTO "Image" (id, "userId", "needsReview") VALUES ($ID, $ID, 'csam')`,
    },
  ],
  ['it is deleted', 21, { sql: `UPDATE "Model" SET "deletedAt" = now() WHERE id = $ID` }],
  [
    "the lock is the intent check's",
    22,
    {
      meta: { systemNsfwLock: { source: 'com-face-intent', at: LOCKED_AT } },
    },
  ],
  [
    "the lock is the profanity filter's",
    23,
    {
      meta: { systemNsfwLock: { source: 'profanity-filter', at: LOCKED_AT } },
    },
  ],
  ['the lock has no origin marker', 24, { meta: {} }],
  ['it has no nsfw lock', 25, { locks: ['tags'] }],
];

beforeEach(async () => {
  await db.exec(
    'DELETE FROM "Model"; DELETE FROM "ModActivity"; DELETE FROM "Appeal"; DELETE FROM "CsamReport"; DELETE FROM "EvidenceHold"; DELETE FROM "User"; DELETE FROM "Image"; DELETE FROM "EvidenceHeldUser";'
  );
  await model(ELIGIBLE);
  await model(ELIGIBLE_RULED_BEFORE, {
    sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'lockProperty:nsfw', 'model', $ID, '2026-10-01')`,
  });
  await model(ELIGIBLE_SYSTEM_RULED, {
    sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (-1, 'unlockProperty:nsfw', 'model', $ID, '2026-10-21')`,
  });
  for (const [, id, fields] of excluded) await model(id, fields);
});

const row = async (id: number) =>
  (
    await db.query<{ nsfw: boolean; lockedProperties: string[]; meta: Record<string, unknown> }>(
      'SELECT nsfw, "lockedProperties", meta FROM "Model" WHERE id = $1',
      [id]
    )
  ).rows[0];

describe('model nsfw lock backfill: scan locks', () => {
  it('selects only scan-locked models no exclusion applies to', async () => {
    expect(await nextScanLockBatch(0, 100)).toEqual([
      ELIGIBLE,
      ELIGIBLE_RULED_BEFORE,
      ELIGIBLE_SYSTEM_RULED,
    ]);
  });

  it.each(excluded)('leaves the model as it was when %s', async (_reason, id) => {
    const before = await row(id);
    expect(await unlockScanLocks([id])).toEqual([]);
    expect(await row(id)).toEqual(before);
  });

  it('lifts only the nsfw lock, keeps the rating and the marker, and records what it replaced', async () => {
    expect(await unlockScanLocks([ELIGIBLE])).toEqual([ELIGIBLE]);
    const after = await row(ELIGIBLE);
    expect(after.nsfw).toBe(true);
    expect(after.lockedProperties).toEqual(['tags']);
    expect(after.meta.systemNsfwLock).toEqual(scanMarker.systemNsfwLock);
    expect(after.meta.nsfwLockBackfill).toMatchObject({
      bucket: 'scan-locks',
      priorLockedProperties: ['nsfw', 'tags'],
    });
  });

  it('pages by id and a second run finds nothing left', async () => {
    expect(await nextScanLockBatch(ELIGIBLE, 1)).toEqual([ELIGIBLE_RULED_BEFORE]);
    await unlockScanLocks(await nextScanLockBatch(0, 100));
    expect(await nextScanLockBatch(0, 100)).toEqual([]);
  });

  it('counts the bucket and each exclusion', async () => {
    const counts = await countScanLocks();
    // Scan-marked, nsfw-locked and not deleted: the 3 eligible and 10-20.
    expect(counts).toMatchObject({
      eligible: 3,
      moderatorRuled: 3,
      pendingLockReview: 1,
      minorOrPoi: 2,
      ownerCsamReport: 2,
      ownerEvidenceHold: 1,
      ownerSexualMinorBan: 1,
      // The account hold reads unsent CSAM reports too: 16 and 17 as well as 20.
      ownerAccountHold: 3,
    });
    expect(counts.scanLocked).toBe(14);
  });
});
