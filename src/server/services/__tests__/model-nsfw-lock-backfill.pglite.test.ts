import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

/** ClickHouse at its boundary: what the attribution read gets back. */
const clickhouseQuery = vi.hoisted(() => vi.fn());
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: clickhouseQuery } }));
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type { Attribution } from '~/server/api-routes/admin/temp/model-nsfw-lock-backfill';

/**
 * The backfill's own selector, UPDATEs and dry-run gate against PGlite: which scan-locked models it may
 * unlock, what the unlock writes, and what a revert puts back, over stand-ins for the tables it reads. Ids are invented. The policy they pin (lock only for sexual
 * intent; lift the text scan's locks, keep the rating) is described on civitai/civitai#10228.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** What follows a write run, passed in: the cache bust and a profanity unlock's forced text scan. */
const scanModelText = vi.fn<(id: number) => Promise<string>>(async () => 'submitted');
const updateModelNsfwLevels = vi.fn();
/** The entity-change log's attribution the profanity bucket reads; set per test below. */
const readProfanityAttribution = vi.fn<() => Promise<Attribution>>();
const effects = {
  bustPublicModelResponseCache: vi.fn(),
  readProfanityAttribution,
  scanModelText,
  updateModelNsfwLevels,
};

const {
  backfillSchema,
  countLocks,
  exclusionsFor,
  NO_ATTRIBUTION,
  readProfanityAttribution: readAttributionFromClickhouse,
  PROFANITY_ATTRIBUTION_QUERY,
  nextRevertBatch,
  nextUnlockBatch,
  ratingChangedSinceUnlock,
  recordScans,
  revertLocks,
  runBackfill,
  unlockLocks,
} = await import('~/server/api-routes/admin/temp/model-nsfw-lock-backfill');

const SCAN = 'scan-locks';
const PROFANITY = 'profanity-locks';
const countScanLocks = () => countLocks(SCAN);
const nextScanLockBatch = (afterId: number, limit: number) => nextUnlockBatch(SCAN, afterId, limit);
const unlockScanLocks = (ids: number[]) => unlockLocks(SCAN, ids);
const revertScanLocks = (ids: number[]) => revertLocks(SCAN, ids);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, nsfw boolean NOT NULL DEFAULT true,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "sfwOnly" boolean NOT NULL DEFAULT false,
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
    CREATE TABLE "Report" (id serial PRIMARY KEY, status text NOT NULL);
    CREATE TABLE "ModelReport" ("modelId" int NOT NULL, "reportId" int NOT NULL);
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
    'DELETE FROM "Model"; DELETE FROM "ModelVersion"; DELETE FROM "ModelFile"; DELETE FROM "ModelFileHash"; DELETE FROM "ModelOwnership"; DELETE FROM "ModActivity"; DELETE FROM "Appeal"; DELETE FROM "CsamReport"; DELETE FROM "User"; DELETE FROM "Image"; DELETE FROM "Report"; DELETE FROM "ModelReport";'
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

/** The scan outcome an unlock recorded on model `id`. */
const scanOf = async (id: number) =>
  ((await row(id)).meta.nsfwLockBackfill as { scan?: unknown } | undefined)?.scan;

const ALL_ELIGIBLE = [ELIGIBLE, ELIGIBLE_RULED_BEFORE, ELIGIBLE_SYSTEM_RULED, ELIGIBLE_TRANSFERRED];

describe('model nsfw lock backfill: scan locks', () => {
  it('selects only scan-locked models no exclusion applies to', async () => {
    expect(await nextScanLockBatch(0, 100)).toEqual(ALL_ELIGIBLE);
  });

  it.each(excluded)(
    'keeps the lock when %s, by that exclusion alone',
    async (_reason, id, _f, leg) => {
      expect(await exclusionsFor(id, SCAN)).toEqual([leg]);
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
    expect(await nextRevertBatch(SCAN, 0, 100)).toEqual([ELIGIBLE]);
    expect(await revertScanLocks([ELIGIBLE])).toEqual([ELIGIBLE]);

    const after = await row(ELIGIBLE);
    expect(after.lockedProperties).toEqual(['nsfw', 'tags', 'name']);
    expect(after.meta.nsfwLockBackfill).toMatchObject({ revertedAt: expect.any(String) });
    expect(await nextScanLockBatch(0, 100)).not.toContain(ELIGIBLE);
    expect(await revertScanLocks([ELIGIBLE])).toEqual([]);
  });

  it.each([
    ['minor', `minor = true`],
    ['poi', `poi = true`],
    ['SFW-only', `"sfwOnly" = true`],
  ])('leaves a model flagged %s since the unlock', async (_flag, set) => {
    await unlockScanLocks([ELIGIBLE]);
    await db.exec(`UPDATE "Model" SET ${set} WHERE id = ${ELIGIBLE}`);
    const before = await row(ELIGIBLE);
    expect(await nextRevertBatch(SCAN, 0, 100)).toEqual([]);
    expect(await revertScanLocks([ELIGIBLE])).toEqual([]);
    expect(await row(ELIGIBLE)).toEqual(before);
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
    expect(await nextRevertBatch(SCAN, 0, 100)).toEqual([]);
    expect(await revertScanLocks([ELIGIBLE])).toEqual([]);
    expect(await row(ELIGIBLE)).toEqual(before);
  });

  it('touches no model an unlock never changed', async () => {
    const before = await row(ELIGIBLE_RULED_BEFORE);
    expect(await nextRevertBatch(SCAN, 0, 100)).toEqual([]);
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

/** The profanity filter's marker as it stores it: the reason fields ride along and must come back intact. */
const profanityMarker = {
  source: 'profanity-filter',
  at: LOCKED_AT,
  category: 'sexual',
  fields: ['name'],
  textHash: 'abc123',
};

/** What the save-time profanity filter wrote before it stamped a marker: its matches, nothing else. */
const legacyMatches = { profanityMatches: ['word'], profanityEvaluation: { reason: 'matched' } };

const UNMARKED = 60; // a legacy profanity lock: nsfw lock + profanityMatches, no marker
const UNMARKED_SYSTEM_ACTED = 61; // the same, with only the system user's activity on record
const UNATTRIBUTED = 67; // unmarked, matches, but no filter record in the entity-change log
const MODERATOR_LOCK_OLD_MATCHES = 68; // a moderator's unlogged lock on a model with old matches
const SUPERSEDED = 69; // the filter's record, then a later change by someone else
const OWNER_UNPUBLISHED = 75; // attributed; its owner unpublished it (control for moderatorSignal)
const UNACTIONED_REPORT = 76; // attributed; a report a moderator did not action (control)

/** The log as the tests read it: every unmarked fixture attributed but the three above. */
const ATTR: Attribution = {
  attributed: [
    UNMARKED,
    UNMARKED_SYSTEM_ACTED,
    62,
    63,
    64,
    65,
    66,
    70,
    71,
    72,
    73,
    74,
    OWNER_UNPUBLISHED,
    UNACTIONED_REPORT,
  ],
  superseded: [SUPERSEDED],
};

/** Legacy profanity locks the selector takes: [reason, id, model fields]. */
const unmarked: [string, number, ModelFields][] = [
  [
    'an attributed lock its owner unpublished',
    OWNER_UNPUBLISHED,
    { meta: { ...legacyMatches, unpublishedBy: OWNER_UNPUBLISHED } },
  ],
  [
    'an attributed lock with a report no moderator actioned',
    UNACTIONED_REPORT,
    {
      meta: legacyMatches,
      sql: `INSERT INTO "Report" (id, status) VALUES ($ID, 'Unactioned');
        INSERT INTO "ModelReport" VALUES ($ID, $ID);`,
    },
  ],
  ['an unmarked legacy profanity lock', UNMARKED, { meta: legacyMatches }],
  [
    'an unmarked lock with only system activity',
    UNMARKED_SYSTEM_ACTED,
    {
      meta: legacyMatches,
      sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (-1, 'unlockProperty:nsfw', 'model', $ID, '2026-10-21')`,
    },
  ],
];

/** Legacy profanity locks one exclusion keeps locked: [reason, id, model fields, the one exclusion]. */
const unmarkedExcluded: [string, number, ModelFields, string][] = [
  [
    // Any activity, ever: not only an nsfw ruling, and not only since a lock time these rows lack.
    'a moderator ever acted on the unmarked model, on anything',
    62,
    {
      meta: legacyMatches,
      sql: `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'review', 'model', $ID, '2020-01-01')`,
    },
    'moderatorActed',
  ],
  [
    'the unmarked model holds another lock beside nsfw',
    63,
    { meta: legacyMatches, locks: ['nsfw', 'tags'] },
    'otherLocks',
  ],
  [
    // Matches recorded, lock and no marker, but no record of the filter setting the lock.
    'the log does not attribute the unmarked lock to the filter',
    UNATTRIBUTED,
    { meta: legacyMatches },
    'unattributed',
  ],
  [
    // A moderator's lock (unlogged before 2026-10-20) on a model the filter once matched.
    'a moderator set the unmarked lock on a model with old matches',
    MODERATOR_LOCK_OLD_MATCHES,
    {
      meta: { profanityMatches: ['word'], profanityEvaluation: { reason: 'matched' }, other: 1 },
    },
    'unattributed',
  ],
  [
    'someone changed the lock or rating since the filter set it',
    SUPERSEDED,
    { meta: legacyMatches },
    'attributionSuperseded',
  ],
  // Attributed, but a moderator's mark on the model: what a dropped log event would hide.
  [
    'the attributed model has an actioned report',
    70,
    {
      meta: legacyMatches,
      sql: `INSERT INTO "Report" (id, status) VALUES ($ID, 'Actioned');
        INSERT INTO "ModelReport" VALUES ($ID, $ID);`,
    },
    'moderatorSignal',
  ],
  [
    'the attributed model was declined',
    71,
    { meta: { ...legacyMatches, declinedAt: 'x' } },
    'moderatorSignal',
  ],
  [
    'the attributed model needs review',
    72,
    { meta: { ...legacyMatches, needsReview: true } },
    'moderatorSignal',
  ],
  [
    'someone other than the owner unpublished the attributed model',
    73,
    { meta: { ...legacyMatches, unpublishedBy: 7 } },
    'moderatorSignal',
  ],
  [
    'the attributed model has an unreadable unpublisher',
    74,
    { meta: { ...legacyMatches, unpublishedBy: 'mod' } },
    'moderatorSignal',
  ],
];

/** Models a legacy-lock reading must not take: [reason, id, model fields]. */
const unmarkedOutside: [string, number, ModelFields][] = [
  ['its profanityMatches is empty', 64, { meta: { profanityMatches: [] } }],
  [
    // Fail closed: a marker key of any value is a marker, so the row is not an unmarked lock.
    'it carries a null marker beside its matches',
    65,
    { meta: { ...legacyMatches, systemNsfwLock: null } },
  ],
  [
    "it has matches but the lock is the text scan's",
    66,
    { meta: { ...legacyMatches, ...scanMarker } },
  ],
];

/**
 * The profanity bucket's own exclusions for the shared fixtures: a moderator's activity counts over
 * all time (`moderatorActed`), so the model ruled on before its lock is excluded too; a marker with
 * no readable time is a malformed row, kept by its own reason (`markerUnreadable`).
 */
const MARKER_NO_TIME = 12;
const profanityExcluded: [string, number, ModelFields, string][] = [
  ...excluded.map(([reason, id, f, leg]): [string, number, ModelFields, string] => [
    reason,
    id,
    f,
    id === MARKER_NO_TIME ? 'markerUnreadable' : leg === 'moderatorRuled' ? 'moderatorActed' : leg,
  ]),
  ['a moderator ruled on its nsfw before the lock', ELIGIBLE_RULED_BEFORE, {}, 'moderatorActed'],
];

const PROFANITY_ELIGIBLE = [
  ELIGIBLE,
  ELIGIBLE_SYSTEM_RULED,
  ELIGIBLE_TRANSFERRED,
  UNMARKED,
  UNMARKED_SYSTEM_ACTED,
  OWNER_UNPUBLISHED,
  UNACTIONED_REPORT,
];

/** The row's meta without the unlock's record: what a relock or revert must give back exactly. */
const metaWithoutRecord = (meta: Record<string, unknown>) => {
  const { nsfwLockBackfill: _record, ...rest } = meta;
  return rest;
};

describe('model nsfw lock backfill: profanity locks', () => {
  // The same models under the other marker: each scan lock becomes a profanity lock and the one
  // profanity lock (model 23) becomes a scan lock, outside this bucket.
  beforeEach(async () => {
    await db.query(
      `UPDATE "Model" SET meta = jsonb_set(meta, '{systemNsfwLock}',
         CASE WHEN meta->'systemNsfwLock'->>'source' = 'text-scan'
           THEN (meta->'systemNsfwLock') || ($1::jsonb - 'at')
           ELSE (meta->'systemNsfwLock') || '{"source": "text-scan"}'::jsonb END)
       WHERE meta->'systemNsfwLock'->>'source' IN ('text-scan', 'profanity-filter')`,
      [JSON.stringify(profanityMarker)]
    );
    // A profanity lock with any other lock beside it is excluded (`otherLocks`): these hold nsfw alone.
    await db.query(
      `UPDATE "Model" SET "lockedProperties" = ARRAY['nsfw']
       WHERE meta->'systemNsfwLock'->>'source' = 'profanity-filter' AND 'nsfw' = ANY("lockedProperties")`
    );
    for (const [, id, fields] of [...unmarked, ...unmarkedExcluded, ...unmarkedOutside])
      await model(id, { locks: ['nsfw'], ...fields });
    scanModelText.mockReset();
    readProfanityAttribution.mockReset();
    readProfanityAttribution.mockResolvedValue(ATTR);
    effects.bustPublicModelResponseCache.mockClear();
    updateModelNsfwLevels.mockClear();
    scanModelText.mockResolvedValue('submitted');
  });

  it('selects only profanity-locked models no exclusion applies to', async () => {
    expect(await nextUnlockBatch(PROFANITY, 0, 100, ATTR)).toEqual(PROFANITY_ELIGIBLE);
    // Model 23 is a scan lock now, and so is 66: matches under a text-scan marker are the scan's lock.
    expect(await nextUnlockBatch(SCAN, 0, 100)).toEqual([23, 66]);
  });

  it.each([...profanityExcluded, ...unmarkedExcluded])(
    'keeps the lock when %s, by that exclusion alone',
    async (_reason, id, _f, leg) => {
      expect(await exclusionsFor(id, PROFANITY, ATTR)).toEqual([leg]);
      const before = await row(id);
      expect(await unlockLocks(PROFANITY, [id], ATTR)).toEqual([]);
      expect(await row(id)).toEqual(before);
    }
  );

  it('keeps the lock on a model not rated mature, by that exclusion alone', async () => {
    await db.query(`UPDATE "Model" SET nsfw = false WHERE id = $1`, [ELIGIBLE]);
    expect(await exclusionsFor(ELIGIBLE, PROFANITY, ATTR)).toEqual(['notMature']);
    const before = await row(ELIGIBLE);
    expect(await unlockLocks(PROFANITY, [ELIGIBLE], ATTR)).toEqual([]);
    expect(await row(ELIGIBLE)).toEqual(before);
  });

  const outsideProfanity: [string, number][] = [
    ...outside.filter(([, id]) => id !== 23).map(([reason, id]): [string, number] => [reason, id]),
    ["the lock is the text scan's", 23],
    ...unmarkedOutside.map(([reason, id]): [string, number] => [reason, id]),
  ];
  it.each(outsideProfanity)('leaves the model as it was when %s', async (_reason, id) => {
    const before = await row(id);
    expect(await unlockLocks(PROFANITY, [id], ATTR)).toEqual([]);
    expect(await row(id)).toEqual(before);
  });

  it('lifts the nsfw lock, keeps the rating, and parks the marker with the prior state', async () => {
    expect(await unlockLocks(PROFANITY, [ELIGIBLE], ATTR)).toEqual([ELIGIBLE]);
    const after = await row(ELIGIBLE);
    expect(after.nsfw).toBe(true);
    expect(after.lockedProperties).toEqual([]);
    expect(after.meta.systemNsfwLock).toBeUndefined();
    expect(after.meta.nsfwLockBackfill).toMatchObject({
      bucket: PROFANITY,
      priorLockedProperties: ['nsfw'],
      priorNsfw: true,
      priorSystemNsfwLock: profanityMarker,
    });
    expect(await nextUnlockBatch(PROFANITY, 0, 100, ATTR)).not.toContain(ELIGIBLE);
  });

  // The bucket's exclusion policy is the Moderation Lead's, recorded on civitai/civitai#10527.
  it('counts the bucket, each exclusion and the models not rated mature', async () => {
    await db.query(`UPDATE "Model" SET nsfw = false WHERE id = $1`, [ELIGIBLE]);
    const counts = await countLocks(PROFANITY, ATTR);
    expect(counts).toMatchObject({
      eligible: PROFANITY_ELIGIBLE.length - 1,
      notMature: 1,
      // Models 10 and 11, ELIGIBLE_RULED_BEFORE and the unmarked one a moderator acted on.
      moderatorActed: 4,
      otherLocks: 1,
      markerUnreadable: 1,
      unattributed: 2,
      attributionSuperseded: 1,
      moderatorSignal: 5,
      eligibleByProfanityMatches: unmarked.length,
      pendingDetection: 4,
      ownerCsamReport: 4,
      byMarker: ALL_ELIGIBLE.length + excluded.length,
      byProfanityMatches: unmarked.length + unmarkedExcluded.length,
    });
    expect(counts).not.toHaveProperty('moderatorRuled');
    expect(counts.profanityLocked).toBe(
      ALL_ELIGIBLE.length + excluded.length + unmarked.length + unmarkedExcluded.length
    );
  });

  it('writes nothing for a bare request: a dry run of unlock with the counts', async () => {
    const before = await row(ELIGIBLE);
    const result = await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
    expect(result).toMatchObject({ action: 'unlock', dryRun: true, ids: PROFANITY_ELIGIBLE });
    expect(result.counts).toMatchObject({ eligible: PROFANITY_ELIGIBLE.length });
    expect(await row(ELIGIBLE)).toEqual(before);
  });

  describe('revert', () => {
    it('puts back the lock and the exact marker', async () => {
      await unlockLocks(PROFANITY, [ELIGIBLE], ATTR);
      expect(await nextRevertBatch(PROFANITY, 0, 100)).toEqual([ELIGIBLE]);
      expect(await nextRevertBatch(SCAN, 0, 100)).toEqual([]);

      const result = await runBackfill(
        backfillSchema.parse({ bucket: PROFANITY, action: 'revert', dryRun: false }),
        effects
      );
      expect(result).toMatchObject({ changed: [ELIGIBLE], skippedRatingChanged: { count: 0 } });
      expect(effects.bustPublicModelResponseCache).toHaveBeenCalledTimes(1);
      expect(effects.bustPublicModelResponseCache).toHaveBeenCalledWith([ELIGIBLE]);
      const after = await row(ELIGIBLE);
      expect(after.nsfw).toBe(true);
      expect(after.lockedProperties).toEqual(['nsfw']);
      expect(after.meta.systemNsfwLock).toEqual(profanityMarker);
      expect(after.meta.nsfwLockBackfill).toMatchObject({ revertedAt: expect.any(String) });
      expect(await nextUnlockBatch(PROFANITY, 0, 100, ATTR)).not.toContain(ELIGIBLE);
      expect(await revertLocks(PROFANITY, [ELIGIBLE])).toEqual([]);
    });

    // A moderator who changes only the rating logs no ModActivity, so any change since the unlock wins.
    it('leaves a model whose rating changed since the unlock, and reports it', async () => {
      await unlockLocks(PROFANITY, [ELIGIBLE], ATTR);
      await db.query(`UPDATE "Model" SET nsfw = false WHERE id = $1`, [ELIGIBLE]);
      const before = await row(ELIGIBLE);
      const result = await runBackfill(
        backfillSchema.parse({ bucket: PROFANITY, action: 'revert', dryRun: false }),
        effects
      );
      expect(result).toMatchObject({
        changed: [],
        skippedRatingChanged: { count: 1, ids: [ELIGIBLE] },
      });
      // Nothing changed, so no cache is busted; a later page of the pass skips the bucket-wide count.
      expect(effects.bustPublicModelResponseCache).not.toHaveBeenCalled();
      const later = await runBackfill(
        backfillSchema.parse({ bucket: PROFANITY, action: 'revert', dryRun: false, afterId: 1 }),
        effects
      );
      expect(later.skippedRatingChanged).toBeUndefined();
      expect(await revertLocks(PROFANITY, [ELIGIBLE])).toEqual([]);
      expect(await row(ELIGIBLE)).toEqual(before);
    });

    it("reverts over the text scan's marker its re-scan stamped after the unlock", async () => {
      await unlockLocks(PROFANITY, [ELIGIBLE], ATTR);
      await db.query(
        `UPDATE "Model" SET meta = meta || jsonb_build_object('systemNsfwLock',
           jsonb_build_object('source', 'text-scan', 'at', now() + interval '1 second')) WHERE id = $1`,
        [ELIGIBLE]
      );
      expect(await revertLocks(PROFANITY, [ELIGIBLE])).toEqual([ELIGIBLE]);
      expect((await row(ELIGIBLE)).meta.systemNsfwLock).toEqual(profanityMarker);
    });

    it.each([
      [
        'a moderator ruled on its nsfw since the unlock',
        `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
          VALUES (7, 'lockProperty:nsfw', 'model', $ID, now() + interval '1 minute')`,
      ],
      [
        'the intent check locked it since',
        `UPDATE "Model" SET "lockedProperties" = array_append("lockedProperties", 'nsfw'),
           meta = meta || '{"systemNsfwLock": {"source": "com-face-intent", "at": "2030-01-01T00:00:00Z"}}'
         WHERE id = $ID`,
      ],
      [
        'it carries a text-scan marker from before the unlock',
        `UPDATE "Model" SET meta = meta || '{"systemNsfwLock": {"source": "text-scan", "at": "2020-01-01T00:00:00Z"}}'
         WHERE id = $ID`,
      ],
      [
        'it was locked again since, with no marker and no moderator activity',
        `UPDATE "Model" SET "lockedProperties" = array_append("lockedProperties", 'nsfw') WHERE id = $ID`,
      ],
      [
        // As applyRaisedRestrictions writes an owner's minor flag on a model with no lock or marker.
        'the owner flagged it minor since',
        `UPDATE "Model" SET minor = true, nsfw = false, "sfwOnly" = true WHERE id = $ID`,
      ],
      [
        'it is minor now, with the rating unchanged',
        `UPDATE "Model" SET minor = true WHERE id = $ID`,
      ],
      ['it is poi now, with the rating unchanged', `UPDATE "Model" SET poi = true WHERE id = $ID`],
      [
        'it is SFW-only now, with the rating unchanged',
        `UPDATE "Model" SET "sfwOnly" = true WHERE id = $ID`,
      ],
      [
        'its text-scan marker has no readable time',
        `UPDATE "Model" SET meta = meta || '{"systemNsfwLock": {"source": "text-scan", "at": "soon"}}'
         WHERE id = $ID`,
      ],
    ])('leaves the model as it is when %s', async (_reason, sql) => {
      await unlockLocks(PROFANITY, [ELIGIBLE], ATTR);
      await db.exec(sql.replaceAll('$ID', String(ELIGIBLE)));
      const before = await row(ELIGIBLE);
      expect(await nextRevertBatch(PROFANITY, 0, 100)).toEqual([]);
      expect(await revertLocks(PROFANITY, [ELIGIBLE])).toEqual([]);
      expect(await row(ELIGIBLE)).toEqual(before);
    });
  });

  describe('the forced scan in the unlock call', () => {
    const unlockRun = (limit?: number) =>
      runBackfill(
        backfillSchema.parse({ bucket: PROFANITY, dryRun: false, ...(limit ? { limit } : {}) }),
        effects
      );

    it('submits one forced scan per changed id and records each on the row', async () => {
      const result = await unlockRun();
      expect(result.changed).toEqual(PROFANITY_ELIGIBLE);
      expect(scanModelText.mock.calls.map(([id]) => id).sort()).toEqual(
        [...PROFANITY_ELIGIBLE].sort()
      );
      expect(result.scans).toEqual({
        byStatus: { submitted: PROFANITY_ELIGIBLE.length },
        notSubmitted: [],
        relocked: [],
        relockedCount: 0,
        ratingRestored: [],
        ratingRestoredCount: 0,
      });
      expect(effects.bustPublicModelResponseCache).toHaveBeenCalledTimes(1);
      expect(effects.bustPublicModelResponseCache).toHaveBeenCalledWith(result.changed);
      for (const id of PROFANITY_ELIGIBLE)
        expect(await scanOf(id)).toMatchObject({ status: 'submitted' });
    });

    it('locks again, in the same call, a changed id whose scan was not submitted', async () => {
      const before = await row(ELIGIBLE);
      scanModelText.mockImplementation(async (id: number) => {
        if (id === ELIGIBLE) throw new Error('orchestrator down');
        if (id === ELIGIBLE_TRANSFERRED) return 'not-active/shadow';
        return 'submitted';
      });
      const result = await unlockRun();
      expect(result.changed).toEqual(PROFANITY_ELIGIBLE);
      const failed = [ELIGIBLE, ELIGIBLE_TRANSFERRED].sort();
      expect(result.scans?.notSubmitted.sort()).toEqual(failed);
      expect(result.scans?.relocked.sort()).toEqual(failed);
      expect(result.scans?.relockedCount).toBe(2);
      // No owner change in the window: no rating comes back (control for the case below).
      expect(result.scans?.ratingRestoredCount).toBe(0);
      expect(updateModelNsfwLevels).not.toHaveBeenCalled();
      // Locked again with the filter's exact marker, so its rating is held as before the unlock.
      const after = await row(ELIGIBLE);
      expect(after.lockedProperties).toEqual(before.lockedProperties);
      expect(after.nsfw).toBe(before.nsfw);
      expect(after.meta.systemNsfwLock).toEqual(profanityMarker);
      expect(await scanOf(ELIGIBLE)).toMatchObject({
        status: 'failed-relocked',
        reason: 'threw',
      });
      expect(await scanOf(ELIGIBLE_TRANSFERRED)).toMatchObject({
        status: 'failed-relocked',
        reason: 'not-active/shadow',
      });
      // Never reverted while locked.
      expect(await nextRevertBatch(PROFANITY, 0, 100)).not.toContain(ELIGIBLE);
      // A later run from the start picks both up again; the submitted ones stay unlocked.
      expect(await nextUnlockBatch(PROFANITY, 0, 100, ATTR)).toEqual(failed);
      // Nor reported as a revert skipped for its rating: it is locked, not waiting on a revert.
      await db.query(`UPDATE "Model" SET nsfw = false WHERE id = $1`, [ELIGIBLE]);
      expect((await ratingChangedSinceUnlock()).ids).not.toContain(ELIGIBLE);
    });

    it('puts the prior rating back when the owner unticked mature before a failed scan', async () => {
      scanModelText.mockImplementation(async (id: number) => {
        if (id !== ELIGIBLE) return 'submitted';
        // The owner saves inside the window the unlock opened.
        await db.query(`UPDATE "Model" SET nsfw = false WHERE id = $1`, [ELIGIBLE]);
        return 'skipped/in-flight';
      });
      const result = await unlockRun();
      expect(result.scans).toMatchObject({
        relocked: [ELIGIBLE],
        ratingRestored: [ELIGIBLE],
        ratingRestoredCount: 1,
      });
      const after = await row(ELIGIBLE);
      expect(after.nsfw).toBe(true);
      expect(after.lockedProperties).toEqual(['nsfw']);
      expect(after.meta.systemNsfwLock).toEqual(profanityMarker);
      expect(await scanOf(ELIGIBLE)).toMatchObject({
        status: 'relocked-nsfw-restored',
        reason: 'skipped/in-flight',
      });
      expect(updateModelNsfwLevels).toHaveBeenCalledWith([ELIGIBLE]);
      const dry = await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
      expect(dry.counts).toMatchObject({ unlockedUnscanned: 0 });
    });

    it('counts unlocks a call left with no scan outcome', async () => {
      await unlockLocks(PROFANITY, [ELIGIBLE], ATTR);
      const dry = await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
      expect(dry.counts).toMatchObject({ unlockedUnscanned: 1 });
      // A scan that failed but was never locked again (the relock died) counts too; a relocked one not.
      await unlockLocks(PROFANITY, [ELIGIBLE_TRANSFERRED], ATTR);
      await recordScans([
        { id: ELIGIBLE, status: 'threw' },
        { id: ELIGIBLE_TRANSFERRED, status: 'submitted' },
      ]);
      const again = await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
      expect(again.counts).toMatchObject({ unlockedUnscanned: 1 });
      await db.query(
        `UPDATE "Model" SET meta = jsonb_set(meta, '{nsfwLockBackfill,scan,status}', '"failed-relocked"') WHERE id = $1`,
        [ELIGIBLE]
      );
      const relocked = await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
      expect(relocked.counts).toMatchObject({ unlockedUnscanned: 0 });
    });

    it('scans nothing on a scan-locks unlock or a dry run', async () => {
      await runBackfill(backfillSchema.parse({ bucket: SCAN, dryRun: false }), effects);
      await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
      expect(scanModelText).not.toHaveBeenCalled();
    });

    it('takes at most 200 ids a call', async () => {
      // 205 more copies of the eligible model, so a cap not applied to the batch query shows.
      await db.exec(`INSERT INTO "Model" (id, "userId", nsfw, minor, poi, "sfwOnly", status, "deletedAt", "lockedProperties", meta)
        SELECT 10000 + g, "userId", nsfw, minor, poi, "sfwOnly", status, "deletedAt", "lockedProperties", meta
        FROM "Model", generate_series(1, 205) g WHERE id = ${ELIGIBLE}`);
      const result = await runBackfill(
        backfillSchema.parse({ bucket: PROFANITY, limit: 500 }),
        effects
      );
      expect(result.limit).toBe(200);
      expect(result.ids).toHaveLength(200);
      expect(
        (await runBackfill(backfillSchema.parse({ bucket: SCAN, limit: 500 }), effects)).limit
      ).toBe(500);
    });
  });
  describe('the attribution query (ClickHouse, never run here, so pinned)', () => {
    const query = PROFANITY_ATTRIBUTION_QUERY.replace(/\s+/g, ' ').trim();
    it('is the reviewed text, byte for byte up to whitespace', () => {
      expect(query).toBe(
        "WITH filter AS ( SELECT entityId, max(createdAt) AS at FROM entityChangeEvents WHERE entityType = 'Model' AND field = 'lockedProperties' AND actorRole = 'system' AND reason = 'profanity-filter' AND has(JSONExtract(newValue, 'Array(String)'), 'nsfw') AND NOT has(JSONExtract(oldValue, 'Array(String)'), 'nsfw') GROUP BY entityId ), later AS ( SELECT DISTINCT e.entityId FROM entityChangeEvents e INNER JOIN filter f ON f.entityId = e.entityId WHERE e.entityType = 'Model' AND e.field IN ('lockedProperties', 'nsfw') AND e.createdAt >= f.at AND NOT (e.actorRole = 'system' AND e.reason = 'profanity-filter') ) SELECT entityId AS id, entityId IN (SELECT entityId FROM later) AS superseded FROM filter"
      );
    });
    it('supersedes on a change at or after the record, never before it', () => {
      expect(query).toContain('e.createdAt >= f.at');
      expect(query).not.toMatch(/e\.createdAt\s*(<|<=|>(?!=))\s*f\.at/);
    });
    it('attributes only a record that added nsfw, by the filter', () => {
      expect(query).toContain("has(JSONExtract(newValue, 'Array(String)'), 'nsfw')");
      expect(query).toContain("AND NOT has(JSONExtract(oldValue, 'Array(String)'), 'nsfw')");
      expect(query).toContain("actorRole = 'system' AND reason = 'profanity-filter'");
    });
    it('interpolates nothing', () => {
      expect(PROFANITY_ATTRIBUTION_QUERY).not.toContain('${');
    });
    it('maps rows to attributed and superseded ids, dropping any id that is not a positive integer', async () => {
      clickhouseQuery.mockResolvedValueOnce([
        { id: '5', superseded: 1 },
        { id: 6, superseded: 0 },
        { id: 7, superseded: false },
        { id: '8', superseded: true },
        { id: -1, superseded: 0 },
        { id: 'x', superseded: 0 },
        { id: 2.5, superseded: 0 },
      ]);
      expect(await readAttributionFromClickhouse()).toEqual({
        attributed: [6, 7],
        superseded: [5, 8],
      });
      expect(clickhouseQuery).toHaveBeenCalledWith(PROFANITY_ATTRIBUTION_QUERY);
    });
    it('throws when ClickHouse fails, so the call writes nothing', async () => {
      clickhouseQuery.mockRejectedValueOnce(new Error('timeout'));
      await expect(readAttributionFromClickhouse()).rejects.toThrow('timeout');
    });
  });

  describe('unmarked legacy locks (lock + profanityMatches, no marker)', () => {
    it('lifts the lock, keeps the rating and the matches, and records that there was no marker', async () => {
      const before = await row(UNMARKED);
      expect(await unlockLocks(PROFANITY, [UNMARKED], ATTR)).toEqual([UNMARKED]);
      const after = await row(UNMARKED);
      expect(after.nsfw).toBe(true);
      expect(after.lockedProperties).toEqual([]);
      expect(after.meta).not.toHaveProperty('systemNsfwLock');
      expect(metaWithoutRecord(after.meta)).toEqual(before.meta);
      expect(after.meta.nsfwLockBackfill).toMatchObject({
        bucket: PROFANITY,
        priorLockedProperties: ['nsfw'],
        priorNsfw: true,
        priorSystemNsfwLock: null,
      });
    });

    it('locks again, to exactly the prior meta, when its forced scan was not submitted', async () => {
      const before = await row(UNMARKED);
      scanModelText.mockImplementation(async (id: number) =>
        id === UNMARKED ? 'not-active/shadow' : 'submitted'
      );
      const result = await runBackfill(
        backfillSchema.parse({ bucket: PROFANITY, dryRun: false }),
        effects
      );
      expect(result.changed).toContain(UNMARKED);
      expect(result.scans?.relocked).toEqual([UNMARKED]);
      const after = await row(UNMARKED);
      expect(after.lockedProperties).toEqual(['nsfw']);
      expect(after.nsfw).toBe(true);
      // No marker came back where there was none: not even a null one.
      expect(after.meta).not.toHaveProperty('systemNsfwLock');
      expect(metaWithoutRecord(after.meta)).toEqual(before.meta);
      expect(await scanOf(UNMARKED)).toMatchObject({
        status: 'failed-relocked',
        reason: 'not-active/shadow',
      });
      // Not reported as a call that left it unlocked and unscanned.
      const dry = await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
      expect(dry.counts).toMatchObject({ unlockedUnscanned: 0 });
      expect(dry.ids).toContain(UNMARKED);
    });

    it('reverts to the lock and exactly the prior meta, over a marker its re-scan stamped', async () => {
      const before = await row(UNMARKED);
      await unlockLocks(PROFANITY, [UNMARKED], ATTR);
      await db.query(
        `UPDATE "Model" SET meta = meta || jsonb_build_object('systemNsfwLock',
           jsonb_build_object('source', 'text-scan', 'at', now() + interval '1 second')) WHERE id = $1`,
        [UNMARKED]
      );
      expect(await nextRevertBatch(PROFANITY, 0, 100)).toEqual([UNMARKED]);
      expect(await revertLocks(PROFANITY, [UNMARKED])).toEqual([UNMARKED]);
      const after = await row(UNMARKED);
      expect(after.lockedProperties).toEqual(['nsfw']);
      expect(after.nsfw).toBe(true);
      expect(after.meta).not.toHaveProperty('systemNsfwLock');
      expect(metaWithoutRecord(after.meta)).toEqual(before.meta);
      expect(after.meta.nsfwLockBackfill).toMatchObject({ revertedAt: expect.any(String) });
      expect(await nextUnlockBatch(PROFANITY, 0, 100, ATTR)).not.toContain(UNMARKED);
    });

    it('does not revert an unlock whose record lost its prior marker entry', async () => {
      await unlockLocks(PROFANITY, [UNMARKED], ATTR);
      await db.query(
        `UPDATE "Model" SET meta = meta #- '{nsfwLockBackfill,priorSystemNsfwLock}' WHERE id = $1`,
        [UNMARKED]
      );
      const before = await row(UNMARKED);
      expect(await revertLocks(PROFANITY, [UNMARKED])).toEqual([]);
      expect(await row(UNMARKED)).toEqual(before);
    });

    it('takes no unmarked lock when no attribution is passed: fail closed', async () => {
      const ids = await nextUnlockBatch(PROFANITY, 0, 100);
      expect(ids).not.toContain(UNMARKED);
      expect(await exclusionsFor(UNMARKED, PROFANITY)).toEqual(['unattributed']);
      expect(await exclusionsFor(UNMARKED, PROFANITY, NO_ATTRIBUTION)).toEqual(['unattributed']);
      const before = await row(UNMARKED);
      expect(await unlockLocks(PROFANITY, [UNMARKED])).toEqual([]);
      expect(await row(UNMARKED)).toEqual(before);
      // A marked lock does not need the log.
      expect(ids).toContain(ELIGIBLE);
    });

    it('reads the attribution in the call and writes nothing when it cannot', async () => {
      readProfanityAttribution.mockRejectedValue(new Error('ClickHouse is not configured'));
      const before = await row(UNMARKED);
      const marked = await row(ELIGIBLE);
      await expect(
        runBackfill(backfillSchema.parse({ bucket: PROFANITY, dryRun: false }), effects)
      ).rejects.toThrow('ClickHouse');
      expect(await row(UNMARKED)).toEqual(before);
      expect(await row(ELIGIBLE)).toEqual(marked);
      expect(scanModelText).not.toHaveBeenCalled();
    });

    it('re-checks the attribution in the UPDATE: one the dry run saw but the write call does not is kept', async () => {
      const dry = await runBackfill(backfillSchema.parse({ bucket: PROFANITY }), effects);
      expect(dry.ids).toContain(UNMARKED);
      expect(dry.counts).toMatchObject({
        attributionRecords: { attributed: ATTR.attributed.length, superseded: 1 },
      });
      readProfanityAttribution.mockResolvedValue({
        attributed: ATTR.attributed.filter((id) => id !== UNMARKED),
        superseded: [...ATTR.superseded, UNMARKED],
      });
      const before = await row(UNMARKED);
      expect(await unlockLocks(PROFANITY, [UNMARKED], await readProfanityAttribution())).toEqual(
        []
      );
      expect(await row(UNMARKED)).toEqual(before);
    });

    it('a moderator acting on it after the dry run keeps the write from unlocking it', async () => {
      expect(await nextUnlockBatch(PROFANITY, 0, 100, ATTR)).toContain(UNMARKED);
      await db.query(
        `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
         VALUES (7, 'review', 'model', $1, now())`,
        [UNMARKED]
      );
      const before = await row(UNMARKED);
      expect(await unlockLocks(PROFANITY, [UNMARKED], ATTR)).toEqual([]);
      expect(await row(UNMARKED)).toEqual(before);
    });
  });
});
