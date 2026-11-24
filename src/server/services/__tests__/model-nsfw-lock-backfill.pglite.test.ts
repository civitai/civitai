import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The backfill's own selector, UPDATEs and dry-run gate against PGlite: which scan-locked models it may
 * unlock, what the unlock writes, and what a revert puts back, over stand-ins for the tables it reads. Ids are invented. The policy they pin (lock only for sexual
 * intent; lift the text scan's locks, keep the rating) is described on civitai/civitai#10228.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const {
  backfillSchema,
  countScanLocks,
  exclusionsFor,
  nextRevertBatch,
  nextScanLockBatch,
  revertScanLocks,
  runBackfill,
  unlockScanLocks,
} = await import('~/server/api-routes/admin/temp/model-nsfw-lock-backfill');

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, nsfw boolean NOT NULL DEFAULT true,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'Published',
      "deletedAt" timestamp(3), "lockedProperties" text[], meta jsonb
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "ModelFile" (
      id int PRIMARY KEY, "modelVersionId" int NOT NULL, type text NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "ModelFileHash" ("fileId" int NOT NULL, type text NOT NULL, hash text NOT NULL);
    CREATE TABLE "ModelOwnership" (
      id serial PRIMARY KEY, "modelId" int NOT NULL, "userId" int NOT NULL, reason text NOT NULL,
      "actorId" int, "createdAt" timestamp(3) NOT NULL DEFAULT now()
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
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb);
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

const LOCKED_AT = '2026-10-20T00:00:00.000Z';
const scanMarker = { systemNsfwLock: { source: 'text-scan', at: LOCKED_AT } };
/** The owner a transferred model has now: clean, so only its previous owner (the model's id) is held. */
const NEW_OWNER = 5000;

type ModelFields = { meta?: unknown; locks?: string[]; sql?: string; transferred?: boolean };

/**
 * A scan-locked model owned by user `id`, so an owner row touches only that model. `transferred`
 * moves it to the clean NEW_OWNER, keeping user `id` on record as its first owner.
 */
async function model(id: number, fields: ModelFields = {}) {
  const owner = fields.transferred ? NEW_OWNER : id;
  await db.query(
    `INSERT INTO "Model" (id, "userId", "lockedProperties", meta) VALUES ($1, $2, $3, $4)`,
    [id, owner, fields.locks ?? ['nsfw', 'tags'], fields.meta ?? scanMarker]
  );
  await db.query(`INSERT INTO "User" (id, meta) VALUES ($1, '{}')`, [id]);
  await db.query(
    `INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES ($1, $1, 'create')`,
    [id]
  );
  if (fields.transferred)
    await db.query(
      `INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES ($1, $2, 'transfer')`,
      [id, NEW_OWNER]
    );
  if (fields.sql) await db.exec(fields.sql.replaceAll('$ID', String(id)));
}

const ELIGIBLE = 1;
const ELIGIBLE_RULED_BEFORE = 2; // a moderator ruled before the lock
const ELIGIBLE_SYSTEM_RULED = 3; // the system's own ruling since the lock
const ELIGIBLE_TRANSFERRED = 4; // moved from a clean owner to a clean owner

// The owner holds, each set on user $ID: the model's owner, or its previous owner when transferred.
// The CSAM reports were sent over a year ago and archived, so the account hold (which reads only a
// report still holding) misses them and only the CSAM-report leg, which reads every report, sees them.
const ownerHolds: [string, string, string][] = [
  [
    'is the subject of a CSAM report',
    'ownerCsamReport',
    `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES ($ID, '2024-01-01', '2024-01-02')`,
  ],
  [
    "is a CSAM report's secondary user",
    'ownerCsamReport',
    `INSERT INTO "CsamReport" ("userId", details, "reportSentAt", "archivedAt")
      VALUES (999, '{"secondaryUserId": "$ID"}', '2024-01-01', '2024-01-02')`,
  ],
  [
    'has a SexualMinor ban',
    'ownerSexualMinorBan',
    `UPDATE "User" SET meta = '{"banDetails": {"reasonCode": "SexualMinorGenerator"}}' WHERE id = $ID`,
  ],
];

/** Scan-locked models one exclusion keeps locked: [reason, id, model fields, the one exclusion]. */
const excluded: [string, number, ModelFields, string][] = [
  [
    'a moderator ruled on its nsfw since the lock',
    10,
    {
      sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'unlockProperty:nsfw', 'model', $ID, '2026-10-21')`,
    },
    'moderatorRuled',
  ],
  [
    'a moderator rejected a lock review since the lock',
    11,
    {
      sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'rejectLockReview', 'model', $ID, '2026-10-21')`,
    },
    'moderatorRuled',
  ],
  [
    'its marker has no readable time',
    12,
    { meta: { systemNsfwLock: { source: 'text-scan' } } },
    'moderatorRuled',
  ],
  [
    'a lock review is pending',
    13,
    {
      sql: `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Model', $ID, 'Pending')`,
    },
    'pendingLockReview',
  ],
  [
    'it is a minor model',
    14,
    { sql: `UPDATE "Model" SET minor = true WHERE id = $ID` },
    'minorOrPoi',
  ],
  ['it is a poi model', 15, { sql: `UPDATE "Model" SET poi = true WHERE id = $ID` }, 'minorOrPoi'],
  [
    'the text scan raised its poi flag again',
    50,
    { meta: { ...scanMarker, textScanFlags: { poi: 'redetected' } } },
    'pendingDetection',
  ],
  [
    'the text scan raised its minor flag again',
    51,
    { meta: { ...scanMarker, textScanFlags: { minor: 'redetected' } } },
    'pendingDetection',
  ],
  [
    'a poi hash match waits for a moderator',
    52,
    { meta: { ...scanMarker, poiHashMatch: { at: LOCKED_AT } } },
    'pendingDetection',
  ],
  [
    'its file matches a minor model and waits on the review queue',
    53,
    {
      // A moderator-flagged minor model (another uploader) with the same file hash.
      sql: `INSERT INTO "Model" (id, "userId", minor, "lockedProperties", meta) VALUES ($ID + 500, 900, true, ARRAY['minor'], '{}');
        INSERT INTO "ModelVersion" VALUES ($ID + 500, $ID + 500), ($ID, $ID);
        INSERT INTO "ModelFile" (id, "modelVersionId", type) VALUES ($ID + 500, $ID + 500, 'Model'), ($ID, $ID, 'Model');
        INSERT INTO "ModelFileHash" VALUES ($ID + 500, 'SHA256', 'h$ID'), ($ID, 'SHA256', 'h$ID');`,
    },
    'pendingDetection',
  ],
  [
    'a revert already put its lock back',
    16,
    {
      meta: {
        ...scanMarker,
        nsfwLockBackfill: { bucket: 'scan-locks', revertedAt: '2026-11-25T00:00:00Z' },
      },
    },
    'reverted',
  ],
  ...ownerHolds.flatMap(([reason, leg, sql], i): [string, number, ModelFields, string][] => [
    [`its owner ${reason}`, 30 + i, { sql }, leg],
    [`its previous owner ${reason}`, 40 + i, { sql, transferred: true }, leg],
  ]),
];

/** Models outside the bucket: never selected, whatever the exclusions. */
const outside: [string, number, ModelFields][] = [
  ['it is deleted', 21, { sql: `UPDATE "Model" SET "deletedAt" = now() WHERE id = $ID` }],
  [
    "the lock is the intent check's",
    22,
    { meta: { systemNsfwLock: { source: 'com-face-intent', at: LOCKED_AT } } },
  ],
  [
    "the lock is the profanity filter's",
    23,
    { meta: { systemNsfwLock: { source: 'profanity-filter', at: LOCKED_AT } } },
  ],
  ['the lock has no origin marker', 24, { meta: {} }],
  ['it has no nsfw lock', 25, { locks: ['tags'] }],
];

beforeEach(async () => {
  await db.exec(
    'DELETE FROM "Model"; DELETE FROM "ModelVersion"; DELETE FROM "ModelFile"; DELETE FROM "ModelFileHash"; DELETE FROM "ModelOwnership"; DELETE FROM "ModActivity"; DELETE FROM "Appeal"; DELETE FROM "CsamReport"; DELETE FROM "User"; DELETE FROM "Image";'
  );
  await db.query(`INSERT INTO "User" (id, meta) VALUES ($1, '{}')`, [NEW_OWNER]);
  await model(ELIGIBLE);
  await model(ELIGIBLE_RULED_BEFORE, {
    sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'lockProperty:nsfw', 'model', $ID, '2026-10-01')`,
  });
  await model(ELIGIBLE_SYSTEM_RULED, {
    sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (-1, 'unlockProperty:nsfw', 'model', $ID, '2026-10-21')`,
  });
  await model(ELIGIBLE_TRANSFERRED, { transferred: true });
  for (const [, id, fields] of [...excluded, ...outside]) await model(id, fields);
});

const row = async (id: number) =>
  (
    await db.query<{ nsfw: boolean; lockedProperties: string[]; meta: Record<string, unknown> }>(
      'SELECT nsfw, "lockedProperties", meta FROM "Model" WHERE id = $1',
      [id]
    )
  ).rows[0];

const ALL_ELIGIBLE = [ELIGIBLE, ELIGIBLE_RULED_BEFORE, ELIGIBLE_SYSTEM_RULED, ELIGIBLE_TRANSFERRED];

describe('model nsfw lock backfill: scan locks', () => {
  it('selects only scan-locked models no exclusion applies to', async () => {
    expect(await nextScanLockBatch(0, 100)).toEqual(ALL_ELIGIBLE);
  });

  it.each(excluded)(
    'keeps the lock when %s, by that exclusion alone',
    async (_reason, id, _f, leg) => {
      expect(await exclusionsFor(id)).toEqual([leg]);
      const before = await row(id);
      expect(await unlockScanLocks([id])).toEqual([]);
      expect(await row(id)).toEqual(before);
    }
  );

  it.each(outside)('leaves the model as it was when %s', async (_reason, id) => {
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
    expect(counts).toMatchObject({
      eligible: ALL_ELIGIBLE.length,
      moderatorRuled: 3,
      pendingLockReview: 1,
      minorOrPoi: 2,
      pendingDetection: 4,
      reverted: 1,
      ownerCsamReport: 4,
      ownerSexualMinorBan: 2,
    });
    expect(counts.scanLocked).toBe(ALL_ELIGIBLE.length + excluded.length);
  });
});

describe('model nsfw lock backfill: revert', () => {
  it('puts back the prior locks, keeps any lock set since, and a later unlock run skips the model', async () => {
    await unlockScanLocks([ELIGIBLE]);
    await db.query(
      `UPDATE "Model" SET "lockedProperties" = array_append("lockedProperties", 'name') WHERE id = $1`,
      [ELIGIBLE]
    );
    expect(await nextRevertBatch(0, 100)).toEqual([ELIGIBLE]);
    expect(await revertScanLocks([ELIGIBLE])).toEqual([ELIGIBLE]);

    const after = await row(ELIGIBLE);
    expect(after.lockedProperties).toEqual(['nsfw', 'tags', 'name']);
    expect(after.meta.nsfwLockBackfill).toMatchObject({ revertedAt: expect.any(String) });
    expect(await nextScanLockBatch(0, 100)).not.toContain(ELIGIBLE);
    expect(await revertScanLocks([ELIGIBLE])).toEqual([]);
  });

  it('reverts a model a moderator ruled on only before the unlock (control)', async () => {
    await unlockScanLocks([ELIGIBLE_RULED_BEFORE]);
    expect(await revertScanLocks([ELIGIBLE_RULED_BEFORE])).toEqual([ELIGIBLE_RULED_BEFORE]);
  });

  it.each([
    [
      'a moderator ruled on its nsfw since the unlock',
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
        VALUES (7, 'lockProperty:nsfw', 'model', $ID, now() + interval '1 minute')`,
    ],
    ['its scan marker is gone', `UPDATE "Model" SET meta = meta - 'systemNsfwLock' WHERE id = $ID`],
  ])('leaves the model as it is when %s', async (_reason, sql) => {
    await unlockScanLocks([ELIGIBLE]);
    await db.exec(sql.replaceAll('$ID', String(ELIGIBLE)));
    const before = await row(ELIGIBLE);
    expect(await nextRevertBatch(0, 100)).toEqual([]);
    expect(await revertScanLocks([ELIGIBLE])).toEqual([]);
    expect(await row(ELIGIBLE)).toEqual(before);
  });

  it('touches no model an unlock never changed', async () => {
    const before = await row(ELIGIBLE_RULED_BEFORE);
    expect(await nextRevertBatch(0, 100)).toEqual([]);
    expect(await revertScanLocks([ELIGIBLE_RULED_BEFORE])).toEqual([]);
    expect(await row(ELIGIBLE_RULED_BEFORE)).toEqual(before);
  });
});

describe('model nsfw lock backfill: the endpoint', () => {
  it('writes nothing for a bare request: a dry run of unlock', async () => {
    const before = await row(ELIGIBLE);
    const result = await runBackfill(backfillSchema.parse({ bucket: 'scan-locks' }));
    expect(result).toMatchObject({ action: 'unlock', dryRun: true, ids: ALL_ELIGIBLE });
    expect(await row(ELIGIBLE)).toEqual(before);
  });

  it('writes nothing for a revert unless dryRun is false', async () => {
    await unlockScanLocks([ELIGIBLE]);
    const before = await row(ELIGIBLE);
    const result = await runBackfill(
      backfillSchema.parse({ bucket: 'scan-locks', action: 'revert' })
    );
    expect(result).toMatchObject({ action: 'revert', dryRun: true, ids: [ELIGIBLE] });
    expect(await row(ELIGIBLE)).toEqual(before);
  });
});
