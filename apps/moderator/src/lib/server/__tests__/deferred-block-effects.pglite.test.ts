import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { DEFERRED_BLOCK_EFFECT_TABLE_SQL } from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { imageVersion } from '../csam-queue-set-aside';

/**
 * A block of an image under the review flag puts off its owner notice and report actioning until the
 * review closes. A close that is not a CSAM finding (a dismissal) runs them once, unless Legal holds
 * the owner's notices; an unblock drops them. Nothing reaches the owner while the review is open.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, createNotification, setReportStatus, logToAxiom } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  logToAxiom: vi.fn(async (_e: { name?: string; imageId?: number }) => undefined),
  createNotification: vi.fn(
    async (_n: { userId: number; details: { url: string; reason?: string } }) => undefined
  ),
  setReportStatus: vi.fn(
    async (_a: { id: number; status: string; noRewardFor?: readonly number[] }) => ({
      ok: true as const,
      changed: true,
    })
  ),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
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
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert: vi.fn(), query: vi.fn() }) }));
vi.mock('../reports.service', () => ({ setReportStatus }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({
  bustCacheTag: vi.fn(async () => undefined),
  bustCachedObject: vi.fn(async () => undefined),
}));
vi.mock('../redis', () => ({ getSysRedis: () => ({ del: vi.fn(), sRem: vi.fn() }) }));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(async () => undefined), logToAxiom }));

const { acceptImage, blockImage, dismissFromCsamQueue, dismissUserFromCsamQueue } = await import(
  '../image-moderation.service'
);

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "type" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TYPE "CsamQueueSetAsideOutcome" AS ENUM ('AfterReport', 'Dismissed');
CREATE TABLE "CsamQueueSetAside" (
  "imageId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "outcome" "CsamQueueSetAsideOutcome" NOT NULL,
  "csamReportId" INTEGER,
  "moderatorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL
);
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "Report" ("id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL);
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'Pending'
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "CsamReport" ("id" SERIAL PRIMARY KEY, "userId" INTEGER);
CREATE TABLE "EvidenceHold" ("id" SERIAL PRIMARY KEY, "userId" INTEGER, "releaseAt" TIMESTAMP(3));
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const OWNER = 8;
const FLAGGED = 71; // under review, not removed yet
const OTHER = 72; // another of the owner's images under review
const report = (imageId: number) => imageId + 1000;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`TRUNCATE "Image", "CsamQueueSetAside", "ImageDeferredBlockEffect", "Report",
    "ImageReport", "Appeal", "ModActivity", "CsamReport", "EvidenceHold"`);
  await db.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "postId") VALUES
      ($1, ${OWNER}, 'csam', NULL, 'Scanned', 4, 5), ($2, ${OWNER}, 'csam', NULL, 'Scanned', 4, 5)`,
    [FLAGGED, OTHER]
  );
  await db.exec(`
    INSERT INTO "Report" ("id", "status") SELECT id + 1000, 'Pending' FROM "Image";
    INSERT INTO "ImageReport" ("imageId", "reportId") SELECT id, id + 1000 FROM "Image";
  `);
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const kysely = () => dbHandle.current as Kysely<DB>;
const block = (imageId: number, violationType?: string) =>
  blockImage({ imageId, userId: 2, violationType, reportIds: [report(imageId)] });
const dismiss = async (imageId: number) => {
  const { v } = await kysely()
    .selectFrom('Image as i')
    .select(imageVersion('i').as('v'))
    .where('i.id', '=', imageId)
    .executeTakeFirstOrThrow();
  return dismissFromCsamQueue({ imageId, userId: 3, version: v });
};

const notices = () =>
  createNotification.mock.calls.map(([n]) => ({ url: n.details.url, reason: n.details.reason }));
const actioned = () =>
  setReportStatus.mock.calls
    .map(([a]) => a)
    .filter((a) => a.status === 'Actioned')
    .map((a) => ({ id: a.id, noRewardFor: a.noRewardFor }));
const logged = (name: string) =>
  logToAxiom.mock.calls
    .map(([e]) => e)
    .filter((e) => e.name === name)
    .map((e) => e.imageId);
const withheldRows = async () =>
  (
    await db.query<{ entityId: number; entityType: string; userId: number | null }>(
      `SELECT "entityId", "entityType", "userId" FROM "ModActivity" WHERE activity = 'deferredNoticeWithheld'`
    )
  ).rows;
const deferredRows = async () =>
  (await db.query<{ imageId: number }>(`SELECT "imageId" FROM "ImageDeferredBlockEffect"`)).rows;

describe('a block of an image under the review flag', () => {
  it('sends nothing and actions nothing while the review is open', async () => {
    await block(FLAGGED, 'realPerson');

    expect(notices()).toEqual([]);
    expect(actioned()).toEqual([]);
    expect(await deferredRows()).toEqual([{ imageId: FLAGGED }]);
  });

  it('writes its deferred row with the block, or not at all', async () => {
    await db.exec(`ALTER TABLE "ImageDeferredBlockEffect" RENAME TO "IDBE_gone"`);
    try {
      await expect(block(FLAGGED, 'realPerson')).rejects.toThrow();
      const { rows } = await db.query(`SELECT ingestion FROM "Image" WHERE id = $1`, [FLAGGED]);
      expect(rows).toEqual([{ ingestion: 'Scanned' }]);
    } finally {
      await db.exec(`ALTER TABLE "IDBE_gone" RENAME TO "ImageDeferredBlockEffect"`);
    }
  });
});

describe('dismissing it from the review queue', () => {
  it('sends the owner notice once, with the chosen reason, and actions its open reports', async () => {
    await block(FLAGGED, 'realPerson');
    expect(await dismiss(FLAGGED)).toEqual({ ok: true });

    expect(notices()).toEqual([{ url: `/images/${FLAGGED}`, reason: expect.any(String) }]);
    expect(notices()[0].reason).not.toEqual('');
    expect(actioned()).toEqual([{ id: report(FLAGGED), noRewardFor: [OWNER] }]);
    expect(await deferredRows()).toEqual([]);
  });

  it('logs the firing before the send and the send after it', async () => {
    const order: string[] = [];
    logToAxiom.mockImplementation(async (e) => {
      if (e.name) order.push(e.name);
    });
    createNotification.mockImplementation(async () => {
      order.push('send');
    });
    await block(FLAGGED);
    await dismiss(FLAGGED);

    expect(order.filter((n) => n.startsWith('deferred-notice') || n === 'send')).toEqual([
      'deferred-notice-firing',
      'send',
      'deferred-notice-sent',
    ]);
  });

  it('logs a send that throws as failed', async () => {
    createNotification.mockRejectedValueOnce(new Error('down'));
    await block(FLAGGED);
    await dismiss(FLAGGED);

    expect(logged('deferred-notice-firing')).toEqual([FLAGGED]);
    expect(logged('deferred-notice-sent')).toEqual([]);
    expect(logged('deferred-notice-failed')).toEqual([FLAGGED]);
  });

  it('states no reason when the block chose none', async () => {
    await block(FLAGGED);
    await dismiss(FLAGGED);

    expect(notices()).toEqual([{ url: `/images/${FLAGGED}`, reason: undefined }]);
  });

  it('also actions a report filed after the block', async () => {
    await block(FLAGGED);
    await db.exec(`
      INSERT INTO "Report" ("id", "status") VALUES (5000, 'Pending'), (5001, 'Actioned');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${FLAGGED}, 5000), (${FLAGGED}, 5001);
    `);
    await dismiss(FLAGGED);

    expect(
      actioned()
        .map((a) => a.id)
        .sort()
    ).toEqual([report(FLAGGED), 5000]);
  });

  it('fires once when the queue is closed twice', async () => {
    await block(FLAGGED);
    await dismiss(FLAGGED);
    await dismiss(FLAGGED);

    expect(notices()).toHaveLength(1);
  });

  it('fires nothing for an image blocked before deferred rows existed', async () => {
    await db.exec(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = ${FLAGGED}`
    );
    await dismiss(FLAGGED);

    expect(notices()).toEqual([]);
    expect(actioned()).toEqual([]);
  });

  it('fires for each image a by-user dismissal takes', async () => {
    await block(FLAGGED);
    await block(OTHER);
    const { imagesVersion, removedNotDismissed } = await import('../csam-queue-set-aside');
    const { v } = await removedNotDismissed(kysely(), { table: true, writable: true })
      .select(imagesVersion('i').as('v'))
      .where('i.userId', '=', OWNER)
      .executeTakeFirstOrThrow();
    const result = await dismissUserFromCsamQueue({
      userId: OWNER,
      expectedCount: 2,
      version: v,
      moderatorId: 3,
    });

    expect(result).toMatchObject({ ok: true, dismissed: 2 });
    expect(
      notices()
        .map((n) => n.url)
        .sort()
    ).toEqual([`/images/${FLAGGED}`, `/images/${OTHER}`]);
  });
});

describe('a dismissal for an owner Legal holds notices for', () => {
  it.each([
    ['a CSAM report', `INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`],
    [
      'a released evidence hold',
      `INSERT INTO "EvidenceHold" ("userId", "releaseAt") VALUES (${OWNER}, now() - interval '1 day')`,
    ],
  ])('%s: sends no notice and writes the withheld row, ids only', async (_, seed) => {
    await block(FLAGGED);
    await db.exec(seed);
    await dismiss(FLAGGED);

    expect(notices()).toEqual([]);
    expect(await withheldRows()).toEqual([{ entityId: FLAGGED, entityType: 'image', userId: 3 }]);
    expect(logged('deferred-notice-withheld')).toEqual([FLAGGED]);
    const withheldLog = logToAxiom.mock.calls
      .map(([e]) => e)
      .find((e) => e.name === 'deferred-notice-withheld');
    expect(Object.keys(withheldLog ?? {}).sort()).toEqual(['imageId', 'name', 'type']);
  });

  it('still actions its reports, without paying the owner', async () => {
    await block(FLAGGED);
    await db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`);
    await dismiss(FLAGGED);

    expect(actioned()).toEqual([{ id: report(FLAGGED), noRewardFor: [OWNER] }]);
  });

  it('withholds when the check itself fails', async () => {
    await block(FLAGGED);
    await db.exec(`ALTER TABLE "EvidenceHold" RENAME TO "EvidenceHold_gone"`);
    try {
      await dismiss(FLAGGED);
    } finally {
      await db.exec(`ALTER TABLE "EvidenceHold_gone" RENAME TO "EvidenceHold"`);
    }

    expect(notices()).toEqual([]);
    expect(await withheldRows()).toHaveLength(1);
  });

  it('is not applied to an owner neither row names', async () => {
    await block(FLAGGED);
    await db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (999)`);
    await dismiss(FLAGGED);

    expect(notices()).toHaveLength(1);
    expect(await withheldRows()).toEqual([]);
  });
});

describe('an unblock of it', () => {
  it('drops its deferred effects unfired', async () => {
    await block(FLAGGED);
    await acceptImage({ imageId: FLAGGED, userId: 2, restoreRemoved: true });

    expect(await deferredRows()).toEqual([]);
    expect(notices()).toEqual([]);
    expect(actioned()).toEqual([]);
  });
});
