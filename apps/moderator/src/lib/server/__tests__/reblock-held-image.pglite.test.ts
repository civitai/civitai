import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Blocking a held image (removed with its CSAM reason kept, or under the review flag and not
 * dismissed) writes the block and nothing the owner or a reporter would see: no owner notice, no
 * report actioned (so no reward), and a CSAM blocklist entry. Any other image still gets all of them.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, createNotification, clickhouseInsert, setReportStatus, logToAxiom } = vi.hoisted(
  () => ({
    dbHandle: { current: null as unknown },
    logToAxiom: vi.fn(
      async (_e: { name?: string; imageId?: number; userId?: number }) => undefined
    ),
    createNotification: vi.fn(async (_n: { details: { url: string } }) => undefined),
    clickhouseInsert: vi.fn(
      async (_a: { table: string; values: { hash: string; reason: string }[] }) => undefined
    ),
    setReportStatus: vi.fn(async (_a: { id: number; status: string }) => ({
      ok: true as const,
      changed: true,
    })),
  })
);

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
  // No approved appeals here; the hold itself is covered by image-removal-confirmation.pglite.test.ts.
  holdRemovals: vi.fn(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  })),
  heldRemovalMessage: () => '',
  approvedAppealOf: () => undefined,
}));
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ insert: clickhouseInsert, query: vi.fn() }),
}));
vi.mock('../reports.service', () => ({ setReportStatus }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../mod-activity', () => ({
  recordModActivity: vi.fn(async () => undefined),
  insertModActivityBatch: vi.fn(async () => undefined),
}));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({
  bustCacheTag: vi.fn(async () => undefined),
  bustCachedObject: vi.fn(async () => undefined),
}));
vi.mock('../redis', () => ({ getSysRedis: () => ({ del: vi.fn(), sRem: vi.fn() }) }));
vi.mock('../user-actions.service', () => ({ setImageFlag: vi.fn() }));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(async () => undefined), logToAxiom }));

const { acceptImage, RemovedImageNotRestorableError } = await import('../image-moderation.service');
const { imageQueueActions } = await import('../image-queue');

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
${SET_ASIDE_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedMessage" TEXT,
  "resolvedReason" TEXT,
  "internalNotes" TEXT,
  "buzzTransactionId" TEXT,
  "entityRemovedAt" TIMESTAMP(3)
);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "email" TEXT, "username" TEXT);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

// Each image's own report has the image's id plus 1000.
const HELD = 61; // removed, block reason kept
const FLAG_ONLY = 62; // removed with only the review flag left
const FLAGGED_LIVE = 63; // under review, not removed yet
const OTHER_REASON = 64; // removed for another reason
const HELD_FLAGGED = 65; // removed with its block reason kept and the review flag
const report = (imageId: number) => imageId + 1000;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(
    `TRUNCATE "Image", "ImageReport", "Appeal", "User", "CsamQueueSetAside", "ImageDeferredBlockEffect"`
  );
  await db.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "pHash") VALUES
      ($1, 7, NULL, 'CSAM', 'Blocked', 32, 101),
      ($2, 7, 'csam', 'moderated', 'Blocked', 32, 102),
      ($3, 7, 'csam', NULL, 'Scanned', 4, 103),
      ($4, 7, NULL, 'AiNotVerified', 'Blocked', 32, 104),
      ($5, 7, 'csam', 'CSAM', 'Blocked', 32, 105)`,
    [HELD, FLAG_ONLY, FLAGGED_LIVE, OTHER_REASON, HELD_FLAGGED]
  );
  await db.query(
    `INSERT INTO "ImageReport" ("imageId", "reportId") SELECT id, id + 1000 FROM "Image"`
  );
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const event = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: new Request('https://mod.example/reports/image', { method: 'POST', body: form }),
    locals: { user: { id: 2 }, grants: {} },
    getClientAddress: () => '127.0.0.1',
  } as never;
};
const block = (imageId: number) =>
  imageQueueActions.block(event({ imageId: String(imageId), reportId: String(report(imageId)) }));

const notifiedImages = () => createNotification.mock.calls.map(([n]) => n.details.url);
const actionedReports = () =>
  setReportStatus.mock.calls
    .map(([a]) => a)
    .filter((a) => a.status === 'Actioned')
    .map((a) => a.id);
const blocklistReasons = () =>
  Object.fromEntries(
    clickhouseInsert.mock.calls
      .map(([a]) => a)
      .filter((a) => a.table === 'blocked_images')
      .flatMap((a) => a.values.map((v) => [String(v.hash), v.reason]))
  );
const row = async (id: number) =>
  (
    await db.query<{ ingestion: string; blockedFor: string | null; needsReview: string | null }>(
      `SELECT ingestion, "blockedFor", "needsReview" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const underReviewNotices = () =>
  logToAxiom.mock.calls
    .map(([e]) => e)
    .filter((e) => e.name === 'image-notice-under-review')
    .map((e) => [e.imageId, e.userId]);

const deferredImages = async () =>
  (
    await db.query<{ imageId: number }>(
      `SELECT "imageId" FROM "ImageDeferredBlockEffect" ORDER BY "imageId"`
    )
  ).rows.map((r) => r.imageId);

describe('blocking an image removed with only the review flag left', () => {
  it('sends no owner notice, and defers its report, not a notice, to the review', async () => {
    await block(FLAG_ONLY);

    expect(notifiedImages()).toEqual([]);
    expect(actionedReports()).toEqual([]);
    const { rows } = await db.query(
      `SELECT "imageId", "notifyOwner" FROM "ImageDeferredBlockEffect"`
    );
    expect(rows).toEqual([{ imageId: FLAG_ONLY, notifyOwner: false }]);
  });

  it('once dismissed from the review queue, actions its report, as before', async () => {
    await db.query(
      `INSERT INTO "CsamQueueSetAside" ("imageId", "userId", outcome, "moderatorId") VALUES ($1, 7, 'Dismissed', 2)`,
      [FLAG_ONLY]
    );
    await block(FLAG_ONLY);

    expect(notifiedImages()).toEqual([]);
    expect(actionedReports()).toEqual([report(FLAG_ONLY)]);
  });
});

describe('blocking an image already removed with its block reason kept', () => {
  it('sends no owner notice, leaves its report open and defers nothing', async () => {
    await block(HELD);

    expect(await deferredImages()).toEqual([]);
    expect(await row(HELD)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
    expect(notifiedImages()).toEqual([]);
    expect(actionedReports()).toEqual([]);
  });

  it('leaves its report open when the review flag is on it too', async () => {
    await block(HELD_FLAGGED);

    expect(await row(HELD_FLAGGED)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
    expect(blocklistReasons()).toEqual({});
    expect(notifiedImages()).toEqual([]);
    expect(actionedReports()).toEqual([]);
  });

  it('keeps its blocklist entry at CSAM', async () => {
    await block(HELD);

    expect(blocklistReasons()).toEqual({ '101': 'CSAM' });
  });
});

describe('blocking an image under review that is not removed yet', () => {
  it('removes it and keeps the flag, with a CSAM blocklist entry', async () => {
    await block(FLAGGED_LIVE);

    expect(await row(FLAGGED_LIVE)).toMatchObject({ ingestion: 'Blocked', needsReview: 'csam' });
    expect(blocklistReasons()).toEqual({ '103': 'CSAM' });
  });

  it('never replaces its CSAM blocklist entry with a TOS one when blocked again', async () => {
    await block(FLAGGED_LIVE);
    await block(FLAGGED_LIVE);

    const reasons = clickhouseInsert.mock.calls
      .map(([a]) => a)
      .filter((a) => a.table === 'blocked_images')
      .flatMap((a) => a.values.filter((v) => String(v.hash) === '103').map((v) => v.reason));
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(['CSAM']));
  });

  it('sends no notice and leaves its report open, deferring both to the review', async () => {
    await block(FLAGGED_LIVE);

    expect(notifiedImages()).toEqual([]);
    expect(actionedReports()).toEqual([]);
    expect(underReviewNotices()).toEqual([]);
    expect(await deferredImages()).toEqual([FLAGGED_LIVE]);
  });
});

describe('blocking any other image', () => {
  it('notifies the owner, actions the report and adds a TOS blocklist entry', async () => {
    await block(OTHER_REASON);

    expect(await row(OTHER_REASON)).toMatchObject({ blockedFor: 'moderated' });
    expect(notifiedImages()).toEqual([`/images/${OTHER_REASON}`]);
    expect(actionedReports()).toEqual([report(OTHER_REASON)]);
    expect(blocklistReasons()).toEqual({ '104': 'TOS' });
    expect(underReviewNotices()).toEqual([]);
    expect(await deferredImages()).toEqual([]);
  });
});

describe('a bulk block over held and other images', () => {
  it('acts on the other images only', async () => {
    const ids = [HELD, FLAG_ONLY, FLAGGED_LIVE, OTHER_REASON];
    await imageQueueActions.bulkBlock(
      event({ imageIds: ids.join(','), reportIds: ids.map(report).join(',') })
    );

    expect(notifiedImages()).toEqual([`/images/${OTHER_REASON}`]);
    expect(actionedReports()).toEqual([report(OTHER_REASON)]);
    expect(await deferredImages()).toEqual([FLAG_ONLY, FLAGGED_LIVE]);
    // The image removed with only its flag left is not blocked again, so it adds no entry.
    expect(blocklistReasons()).toEqual({ '101': 'CSAM', '103': 'CSAM', '104': 'TOS' });
  });
});

describe('accepting from a review queue', () => {
  it('does not put an image removed with its block reason kept back live', async () => {
    await expect(acceptImage({ imageId: HELD, userId: 2 })).rejects.toBeInstanceOf(
      RemovedImageNotRestorableError
    );

    expect(await row(HELD)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
  });

  it('still puts an image removed for another reason back live', async () => {
    await acceptImage({ imageId: OTHER_REASON, userId: 2 });

    expect(await row(OTHER_REASON)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
  });

  it('is overridden by an explicit unblock', async () => {
    await acceptImage({ imageId: HELD, userId: 2, restoreRemoved: true });

    expect(await row(HELD)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
  });
});

describe('a bulk appeal approval over an image blocked for CSAM and another', () => {
  it(
    'restores the other image and leaves the held one removed with its appeal pending',
    { timeout: 10_000 },
    async () => {
      await db.query(
        `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES (7, 'Image', $1), (7, 'Image', $2)`,
        [HELD, OTHER_REASON]
      );
      const form = {
        imageIds: `${HELD},${OTHER_REASON}`,
        status: 'Approved',
        resolvedReason: 'misclassified',
      };

      // Caught, and the rest of the batch let finish: an uncaught refusal would otherwise leave a query
      // in flight when the client closes, and the run would hang instead of failing.
      const result = await imageQueueActions
        .bulkResolveAppeal(event(form))
        .catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(result).toMatchObject({ status: 409 });
      expect(await row(HELD)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
      expect(await row(OTHER_REASON)).toMatchObject({ ingestion: 'Scanned' });
      const statuses = (
        await db.query<{ entityId: number; status: string }>(
          `SELECT "entityId", status FROM "Appeal" ORDER BY "entityId"`
        )
      ).rows;
      expect(statuses).toEqual([
        { entityId: HELD, status: 'Pending' },
        { entityId: OTHER_REASON, status: 'Approved' },
      ]);
    }
  );
});
