import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  TEXT_SCAN_HOLD_TABLE_SQL,
} from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { imageVersion } from '../csam-queue-set-aside';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A song flagged because its cover was flagged for csam is released when the moderator app closes
 * the cover's review as not csam (accept, queue dismissal, bulk flag clear), and only when this
 * mechanism set the song's flag and nothing else still holds it. Pins the decision of PR #10162.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, syncSearchIndex } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown, replica: null as unknown },
  syncSearchIndex: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.replica ?? dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../removal-hold', () => ({
  holdRemovals: vi.fn(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  })),
}));
vi.mock('../image-moderation-effects', () => ({
  applyBlockSideEffects: vi.fn(async () => undefined),
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  trackImageRestore: vi.fn(async () => undefined),
}));
vi.mock('../deferred-block-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deferred-block-effects')>()),
  fireDeferredBlockEffects: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mod-activity')>()),
  recordModActivity: vi.fn(async () => undefined),
}));
vi.mock('../search-index', () => ({ syncSearchIndex }));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));
vi.mock('../article-cover-reindex', () => ({
  queueArticlesForCoverImages: vi.fn(async () => undefined),
}));

const {
  acceptCsamReviewedImage,
  ConfirmedSongHoldError,
  dismissFromCsamQueue,
  dismissUserFromCsamQueue,
} = await import('../image-moderation.service');
const { clearUserCsamFlags, releaseHeldUserCsamFlags } = await import('../csam-flag-clear');
const { imagesVersion, removedNotDismissed } = await import('../csam-queue-set-aside');

const RELEASE_TABLE_SQL = readFileSync(
  new URL(
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261125120000_csam_flag_release/migration.sql',
    import.meta.url
  ),
  'utf8'
);

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "type" TEXT NOT NULL DEFAULT 'image',
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "scannedAt" TIMESTAMP(3),
  "scanJobs" JSONB
);
CREATE TYPE "CsamQueueSetAsideOutcome" AS ENUM ('AfterReport', 'Dismissed');
CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE, "genre" TEXT);
CREATE TABLE "CsamQueueSetAside" (
  "imageId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "outcome" "CsamQueueSetAsideOutcome" NOT NULL,
  "csamReportId" INTEGER,
  "moderatorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL
);
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
${TEXT_SCAN_HOLD_TABLE_SQL}
CREATE TABLE "Report" ("id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL, "reason" TEXT NOT NULL);
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER, "data" JSONB,
  PRIMARY KEY ("entityType", "entityId", "type"));
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "disabled" BOOLEAN);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL, "status" "AppealStatus" NOT NULL DEFAULT 'Pending'
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "CsamReport" ("id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}', "images" JSONB NOT NULL DEFAULT '[]', "reportSentAt" TIMESTAMP(3));
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP(3), "bannedAt" TIMESTAMP(3), "meta" JSONB);
CREATE TABLE "EvidenceHold" ("id" SERIAL PRIMARY KEY, "userId" INTEGER, "releaseAt" TIMESTAMP(3));
CREATE VIEW "EvidenceHeldUser" AS
  SELECT "userId" FROM "EvidenceHold" WHERE "releaseAt" IS NULL OR "releaseAt" > now() GROUP BY "userId";
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const OWNER = 990000010;
const MOD = 990000040;
const SONG = 990000101;
const COVER = 990000102;

let db: PGlite;
// A replica that has not seen the csam flags: the image row with no review on it.
let replica: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(RELEASE_TABLE_SQL);
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(db) });
  replica = await freshPglite();
  await replica.exec(SCHEMA);
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
  await replica.close();
});

/** Runs `fn` with reads that go to the replica seeing `imageId` unflagged. */
async function withStaleReplica(imageId: number, fn: () => Promise<unknown>) {
  await replica.exec(`TRUNCATE "Image";
    INSERT INTO "Image" ("id", "userId") VALUES (${imageId}, ${OWNER});`);
  dbHandle.replica = new Kysely<DB>({ dialect: pgliteDialect(replica) });
  try {
    return await fn();
  } finally {
    dbHandle.replica = null;
  }
}

/** A song held by its flagged cover (`marker`), the cover under review, live or removed. */
async function seed({
  marker = { cover: COVER } as Record<string, number> | null,
  removed = false,
} = {}) {
  await db.exec(`TRUNCATE "Image", "Track", "CsamQueueSetAside", "TextScanHold", "Report", "ImageReport",
    "ModActivity", "ImageDeferredBlockEffect", "User"`);
  await db.query(
    `INSERT INTO "Image" ("id", "type", "userId", "postId", "needsReview", "metadata") VALUES
      ($1, 'audio', $2, 1, 'csam', $3::jsonb)`,
    [SONG, OWNER, JSON.stringify(marker ? { csamHold: marker } : {})]
  );
  await db.query(`INSERT INTO "Track" ("imageId", "coverImageId") VALUES ($1, $2)`, [SONG, COVER]);
  await db.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion", "blockedFor", "nsfwLevel", "metadata") VALUES
      ($1, $2, 'csam', $3, $4, $5, $6::jsonb)`,
    [
      COVER,
      OWNER,
      removed ? 'Blocked' : 'Scanned',
      removed ? 'moderated' : null,
      removed ? 32 : 1,
      JSON.stringify({ parentId: SONG }),
    ]
  );
}

const song = async () =>
  (
    await db.query<{ needsReview: string | null; marker: unknown }>(
      `SELECT "needsReview", "metadata" -> 'csamHold' AS marker FROM "Image" WHERE id = $1`,
      [SONG]
    )
  ).rows[0];

const accept = () => acceptCsamReviewedImage({ imageId: COVER, userId: MOD });
const lyricsHold = (status: 'Pending' | 'Confirmed') =>
  db.query(`INSERT INTO "TextScanHold" VALUES ('TrackLyrics', $1, 'csam', $2)`, [SONG, status]);

describe("closing a song cover's csam review", () => {
  beforeEach(() => vi.clearAllMocks());

  it('releases the song on accept when the cover was all that held it, and re-indexes it', async () => {
    await seed();

    await accept();

    expect(await song()).toEqual({ needsReview: null, marker: null });
    expect(syncSearchIndex).toHaveBeenCalledWith({
      entityType: 'image',
      entityId: SONG,
      action: 'update',
    });
    expect(syncSearchIndex.mock.calls.filter(([call]) => call.entityId === SONG)).toHaveLength(1);
  });

  it('releases the song on accept when the replica has not yet seen the cover flagged', async () => {
    await seed();

    await withStaleReplica(COVER, accept);

    expect(await song()).toEqual({ needsReview: null, marker: null });
  });

  it('keeps the song held while its lyrics hold is pending, dropping only the cover', async () => {
    await seed({ marker: { lyrics: 5, cover: COVER } });
    await db.exec(`INSERT INTO "TextScanHold" VALUES ('TrackLyrics', ${SONG}, 'csam', 'Pending')`);

    await accept();

    expect(await song()).toEqual({ needsReview: 'csam', marker: { lyrics: 5 } });
  });

  it('keeps the song held while a user CSAM report on it is processing', async () => {
    await seed();
    await db.exec(`INSERT INTO "Report" VALUES (1, 'Processing', 'CSAM');
      INSERT INTO "ImageReport" VALUES (${SONG}, 1);`);

    await accept();

    expect((await song()).needsReview).toBe('csam');
  });

  it('never lifts a song a moderator flagged, with no marker', async () => {
    await seed({ marker: null });

    await accept();

    expect(await song()).toEqual({ needsReview: 'csam', marker: null });
  });

  it('releases the song when the removed cover is dismissed from the CSAM queue', async () => {
    await seed({ removed: true });
    const { v } = await (dbHandle.current as Kysely<DB>)
      .selectFrom('Image as i')
      .select(imageVersion('i').as('v'))
      .where('i.id', '=', COVER)
      .executeTakeFirstOrThrow();

    expect(await dismissFromCsamQueue({ imageId: COVER, userId: MOD, version: v })).toEqual({
      ok: true,
    });

    expect(await song()).toEqual({ needsReview: null, marker: null });
  });

  it("releases the song when the owner's removed flags are cleared", async () => {
    await seed({ removed: true });

    const result = await clearUserCsamFlags({ userId: OWNER, expectedCount: 1, moderatorId: MOD });

    expect(result).toMatchObject({ ok: true, cleared: 1 });
    expect(await song()).toEqual({ needsReview: null, marker: null });
  });

  it('keeps the song held through a cover accept while its lyrics hold is confirmed', async () => {
    await seed({ marker: { lyrics: 5, cover: COVER } });
    await lyricsHold('Confirmed');

    await accept();

    expect(await song()).toEqual({ needsReview: 'csam', marker: { lyrics: 5 } });
  });

  it('releases the song when a removed cover is dismissed with the rest of its owner', async () => {
    await seed({ removed: true });
    const { v } = await removedNotDismissed(dbHandle.current as Kysely<DB>, {
      table: true,
      writable: true,
    })
      .select(imagesVersion('i').as('v'))
      .where('i.userId', '=', OWNER)
      .executeTakeFirstOrThrow();

    const result = await dismissUserFromCsamQueue({
      userId: OWNER,
      expectedCount: 1,
      version: v as string,
      moderatorId: MOD,
    });

    expect(result).toMatchObject({ ok: true, dismissed: 1 });
    expect(await song()).toEqual({ needsReview: null, marker: null });
  });

  it('releases the song when an admin releases a banned owner’s removed flags', async () => {
    await seed({ removed: true });
    await db.query(`INSERT INTO "User" ("id", "bannedAt", "meta") VALUES ($1, now(), $2)`, [
      OWNER,
      JSON.stringify({ banDetails: { reasonCode: 'SexualMinor' } }),
    ]);

    const result = await releaseHeldUserCsamFlags({
      userId: OWNER,
      expectedCount: 1,
      approvalRef: '2026-01-31-120000-0123abcd',
      reason: 'cleared on review',
      moderatorId: MOD,
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(await song()).toEqual({ needsReview: null, marker: null });
  });
});

/** The statements `fn` sent to the database, in order. */
async function statementsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const spy = vi.spyOn(db, 'query');
  try {
    await fn().catch(() => undefined);
    return spy.mock.calls.map(([text]) => String(text));
  } finally {
    spy.mockRestore();
  }
}

/**
 * A lift whose refusal reads the song's lyrics hold runs in a transaction that locks its rows in an
 * earlier statement: an UPDATE that waited on the lock itself would re-check the row but read the
 * hold as it was before waiting. PGlite is one connection, so the race itself cannot run here; this
 * pins the order of statements that closes it.
 */
function expectLockedBeforeLift(statements: string[]) {
  const lift = statements.findIndex(
    (text) => text.startsWith('update "Image" set') && text.includes('"TextScanHold"')
  );
  expect(lift).toBeGreaterThan(-1);
  const begin = statements.lastIndexOf('begin', lift);
  expect(begin).toBeGreaterThan(-1);
  const inTransaction = statements.slice(begin + 1, lift);
  expect(inTransaction.some((text) => /^(commit|rollback)$/.test(text))).toBe(false);
  expect(
    inTransaction.some(
      (text) => text.startsWith('select "id" from "Image"') && text.endsWith('for update')
    )
  ).toBe(true);
}

describe('lifting the song itself', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks the song before an accept reads its lyrics hold', async () => {
    await seed({ marker: { lyrics: 5 } });
    await lyricsHold('Confirmed');

    expectLockedBeforeLift(
      await statementsOf(() => acceptCsamReviewedImage({ imageId: SONG, userId: MOD }))
    );
  });

  it("locks the owner's removed flagged rows before a bulk clear reads a lyrics hold", async () => {
    await seed({ marker: { lyrics: 5 } });
    await db.exec(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = ${SONG};`);
    await lyricsHold('Confirmed');

    expectLockedBeforeLift(
      await statementsOf(() =>
        clearUserCsamFlags({ userId: OWNER, expectedCount: 1, moderatorId: MOD })
      )
    );
  });

  it('refuses an accept while its lyrics hold is confirmed, as for a video removed for CSAM', async () => {
    await seed({ marker: { lyrics: 5 } });
    await lyricsHold('Confirmed');

    await expect(acceptCsamReviewedImage({ imageId: SONG, userId: MOD })).rejects.toBeInstanceOf(
      ConfirmedSongHoldError
    );

    expect((await song()).needsReview).toBe('csam');
  });

  it('refuses it whatever review the replica read', async () => {
    await seed({ marker: { lyrics: 5 } });
    await lyricsHold('Confirmed');

    await expect(
      withStaleReplica(SONG, () => acceptCsamReviewedImage({ imageId: SONG, userId: MOD }))
    ).rejects.toBeInstanceOf(ConfirmedSongHoldError);

    expect((await song()).needsReview).toBe('csam');
  });

  it('lets a moderator accept it while its lyrics hold is pending', async () => {
    await seed({ marker: { lyrics: 5 } });
    await lyricsHold('Pending');

    await acceptCsamReviewedImage({ imageId: SONG, userId: MOD });

    expect((await song()).needsReview).toBeNull();
  });

  it("leaves it flagged when the owner's removed flags are cleared while its hold is confirmed", async () => {
    await seed({ marker: { lyrics: 5 } });
    await db.exec(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = ${SONG};
      UPDATE "Image" SET "needsReview" = NULL WHERE id = ${COVER};`);
    await lyricsHold('Confirmed');

    const result = await clearUserCsamFlags({ userId: OWNER, expectedCount: 0, moderatorId: MOD });

    expect(result).toMatchObject({ ok: true, cleared: 0 });
    expect((await song()).needsReview).toBe('csam');
  });
});
