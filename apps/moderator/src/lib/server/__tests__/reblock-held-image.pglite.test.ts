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

const csamCheck = vi.hoisted(() => ({
  fails: false,
  live: [] as { hash: string; reason: string }[],
}));
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
  getClickhouse: () => ({
    insert: clickhouseInsert,
    query: async ({ query }: { query: string }) => {
      if (csamCheck.fails && query.includes("= 'CSAM'")) throw new Error('Socket hang up');
      if (query.includes("= 'CSAM'")) return { json: async () => [] };
      return { json: async () => csamCheck.live };
    },
  }),
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

const { acceptImage, ImageNotRestoredError, RemovedImageNotRestorableError } = await import(
  '../image-moderation.service'
);
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
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER,
  PRIMARY KEY ("entityType", "entityId", "type"));
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
-- Rates a restored image as its tags would: an untagged one would go back to the scanner.
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE "Image" SET "nsfwLevel" = 1
  WHERE id = ANY(ids) AND NOT "nsfwLevelLocked" AND "ingestion" = 'Scanned' AND "blockedFor" IS NULL;
$$;
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

  // From the reports queue a CSAM-flagged image keeps its report Pending even once dismissed: that
  // queue's staff decide it. A block without a report still blocks as before.
  it('once dismissed from the review queue, leaves its report open when Removed from a report', async () => {
    await db.query(
      `INSERT INTO "CsamQueueSetAside" ("imageId", "userId", outcome, "moderatorId") VALUES ($1, 7, 'Dismissed', 2)`,
      [FLAG_ONLY]
    );
    const result = await block(FLAG_ONLY);

    expect(notifiedImages()).toEqual([]);
    expect(setReportStatus).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('alreadyRemoved');
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

  it('leaves its report open when the review flag is on it too, and repeats its CSAM entry', async () => {
    await block(HELD_FLAGGED);

    expect(await row(HELD_FLAGGED)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
    expect(blocklistReasons()).toEqual({ '105': 'CSAM' });
    expect(notifiedImages()).toEqual([]);
    expect(actionedReports()).toEqual([]);
  });

  it('keeps its blocklist entry at CSAM', async () => {
    await block(HELD);

    expect(blocklistReasons()).toEqual({ '101': 'CSAM' });
  });
});

describe('blocking an image under review that is not removed yet', () => {
  // Only a confirmed CSAM removal writes a CSAM entry; the review flag alone writes TOS, which a
  // later clear-and-accept can lift.
  it('removes it and keeps the flag, with a TOS blocklist entry', async () => {
    await block(FLAGGED_LIVE);

    expect(await row(FLAGGED_LIVE)).toMatchObject({ ingestion: 'Blocked', needsReview: 'csam' });
    expect(blocklistReasons()).toEqual({ '103': 'TOS' });
  });

  it('writes the same TOS entry when blocked again', async () => {
    await block(FLAGGED_LIVE);
    await block(FLAGGED_LIVE);

    const reasons = clickhouseInsert.mock.calls
      .map(([a]) => a)
      .filter((a) => a.table === 'blocked_images')
      .flatMap((a) => a.values.filter((v) => String(v.hash) === '103').map((v) => v.reason));
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(['TOS']));
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
    expect(blocklistReasons()).toEqual({ '101': 'CSAM', '103': 'TOS', '104': 'TOS' });
  });

  it('completes when the blocklist check fails: one notice, reports actioned, the skip logged', async () => {
    csamCheck.fails = true;
    const ids = [HELD, FLAG_ONLY, FLAGGED_LIVE, OTHER_REASON];
    try {
      await imageQueueActions.bulkBlock(
        event({ imageIds: ids.join(','), reportIds: ids.map(report).join(',') })
      );
    } finally {
      csamCheck.fails = false;
    }

    expect(notifiedImages()).toEqual([`/images/${OTHER_REASON}`]);
    expect(actionedReports()).toEqual([report(OTHER_REASON)]);
    expect(blocklistReasons()).toEqual({ '101': 'CSAM' });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-insert-skipped',
        payload: expect.objectContaining({ step: 'block', imageId: OTHER_REASON }),
      })
    );
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

  // A CSAM block is lifted only through its own review, never by an explicit unblock. Do not
  // restore the old expectation.
  it('is not overridden by an explicit unblock when the reason is CSAM', async () => {
    await expect(
      acceptImage({ imageId: HELD, userId: 2, restoreRemoved: true })
    ).rejects.toBeInstanceOf(ImageNotRestoredError);

    expect(await row(HELD)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
  });

  it('is overridden by an explicit unblock for another reason', async () => {
    await acceptImage({ imageId: OTHER_REASON, userId: 2, restoreRemoved: true });

    expect(await row(OTHER_REASON)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
  });
});

describe('a verdict on a report of an image a moderator already removed', () => {
  const MOD_REMOVED = 66; // removed by a moderator, no flag
  const LIVE = 67; // reported, still up
  const GRACE = 68; // under an account-deletion grace block
  beforeEach(async () => {
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "pHash", "metadata") VALUES
        ($1, 7, NULL, 'moderated', 'Blocked', 32, 106, NULL),
        ($2, 7, NULL, NULL, 'Scanned', 4, 107, NULL),
        ($3, 7, NULL, 'moderated', 'Blocked', 32, 108, '{"accountDeletionPriorIngestion": "Scanned", "accountDeletionPriorBlockedFor": null, "accountDeletionPriorNeedsReview": null}')`,
      [MOD_REMOVED, LIVE, GRACE]
    );
    await db.query(
      `INSERT INTO "ImageReport" ("imageId", "reportId") VALUES ($1, $2), ($3, $4), ($5, $6)`,
      [MOD_REMOVED, report(MOD_REMOVED), LIVE, report(LIVE), GRACE, report(GRACE)]
    );
  });
  const verdict = (action: 'accept' | 'block', imageId: number) =>
    imageQueueActions[action](
      event({ imageId: String(imageId), reportId: String(report(imageId)) })
    );
  const reportsMovedTo = (status: string) =>
    setReportStatus.mock.calls
      .map(([a]) => a)
      .filter((a) => a.status === status)
      .map((a) => a.id);

  it('Unaction leaves it removed and closes the report as actioned', async () => {
    const result = await verdict('accept', MOD_REMOVED);

    expect(await row(MOD_REMOVED)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(reportsMovedTo('Actioned')).toEqual([report(MOD_REMOVED)]);
    expect(reportsMovedTo('Unactioned')).toEqual([]);
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ noReward: false }));
    expect(result).toMatchObject({
      success: true,
      closedReportIds: [report(MOD_REMOVED)],
      alreadyRemoved: expect.stringContaining('Already removed by a moderator'),
    });
  });

  it('Unaction leaves an account-deletion grace block as it is and closes the report', async () => {
    const unaction = await verdict('accept', GRACE);

    expect(await row(GRACE)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(reportsMovedTo('Actioned')).toEqual([report(GRACE)]);
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ noReward: true }));
    expect(unaction).toMatchObject({ success: true, closedReportIds: [report(GRACE)] });
  });

  // A grace block is reversible: an account restore reads its breadcrumbs and un-blocks the image.
  it('Remove on a grace-blocked image writes a real block, clearing what an account restore reads', async () => {
    const remove = await verdict('block', GRACE);

    const { metadata } = (
      await db.query<{ metadata: Record<string, unknown> | null }>(
        `SELECT metadata FROM "Image" WHERE id = $1`,
        [GRACE]
      )
    ).rows[0];
    expect(metadata).toEqual({});
    expect(notifiedImages()).toEqual([`/images/${GRACE}`]);
    expect(reportsMovedTo('Actioned')).toEqual([report(GRACE)]);
    expect(remove).not.toHaveProperty('alreadyRemoved');
  });

  it('refuses a report that is not on the image, moving no report', async () => {
    const result = await imageQueueActions.accept(
      event({ imageId: String(MOD_REMOVED), reportId: String(report(HELD)) })
    );

    expect(result).toMatchObject({ status: 400 });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('Unaction on an image under the review flag, even dismissed, is refused and moves no report', async () => {
    const DISMISSED = 69;
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "pHash") VALUES
        ($1, 7, 'csam', 'moderated', 'Blocked', 32, 109)`,
      [DISMISSED]
    );
    await db.query(
      `INSERT INTO "CsamQueueSetAside" ("imageId", outcome) VALUES ($1, 'Dismissed')`,
      [DISMISSED]
    );
    await db.query(`INSERT INTO "ImageReport" ("imageId", "reportId") VALUES ($1, $2)`, [
      DISMISSED,
      report(DISMISSED),
    ]);

    const result = await verdict('accept', DISMISSED);

    expect(result).toMatchObject({ status: 409 });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('Remove refuses a report that is not on the image, moving no report', async () => {
    const result = await imageQueueActions.block(
      event({ imageId: String(OTHER_REASON), reportId: String(report(HELD)) })
    );

    expect(result).toMatchObject({ status: 400 });
    expect(notifiedImages()).toEqual([]);
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it("a bulk Unaction with a held image closes the removed one's report and moves no other", async () => {
    const result = await imageQueueActions.bulkAccept(
      event({
        imageIds: [MOD_REMOVED, FLAG_ONLY].join(','),
        reportIds: [report(MOD_REMOVED), report(FLAG_ONLY)].join(','),
      })
    );

    expect(reportsMovedTo('Actioned')).toEqual([report(MOD_REMOVED)]);
    expect(reportsMovedTo('Unactioned')).toEqual([]);
    expect(result).toMatchObject({ status: 409, data: { closedReportIds: [report(MOD_REMOVED)] } });
  });

  it.each(['bulkAccept', 'bulkBlock'] as const)(
    '%s moves no report filed on an image outside the batch, and still rules on the rest',
    async (action) => {
      const result = await imageQueueActions[action](
        event({
          imageIds: String(OTHER_REASON),
          reportIds: [report(OTHER_REASON), report(HELD)].join(','),
        })
      );

      expect(setReportStatus.mock.calls.map(([a]) => a.id)).toEqual([report(OTHER_REASON)]);
      expect(result).toMatchObject({ notMoved: expect.stringContaining(`#${report(HELD)}`) });
    }
  );

  describe('an image an automated moderation rule blocked', () => {
    const RULE_BLOCKED = 70;
    beforeEach(async () => {
      await db.query(
        `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "pHash", "metadata") VALUES
          ($1, 7, NULL, 'moderated', 'Blocked', 32, 110, '{"ruleId": 5, "ruleReason": "r"}')`,
        [RULE_BLOCKED]
      );
      await db.query(`INSERT INTO "ImageReport" ("imageId", "reportId") VALUES ($1, $2)`, [
        RULE_BLOCKED,
        report(RULE_BLOCKED),
      ]);
    });

    it('Unaction restores it, as a rule false positive, and unactions the report', async () => {
      await verdict('accept', RULE_BLOCKED);

      expect(await row(RULE_BLOCKED)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
      expect(reportsMovedTo('Unactioned')).toEqual([report(RULE_BLOCKED)]);
    });

    it('once a moderator Removed it, Unaction on its other report refuses and it stays blocked', async () => {
      const OTHER_REPORT = 9070;
      await db.query(`INSERT INTO "ImageReport" ("imageId", "reportId") VALUES ($1, $2)`, [
        RULE_BLOCKED,
        OTHER_REPORT,
      ]);
      await verdict('block', RULE_BLOCKED);
      vi.clearAllMocks();

      const unaction = await imageQueueActions.accept(
        event({ imageId: String(RULE_BLOCKED), reportId: String(OTHER_REPORT) })
      );
      const remove = await imageQueueActions.block(
        event({ imageId: String(RULE_BLOCKED), reportId: String(OTHER_REPORT) })
      );

      expect(await row(RULE_BLOCKED)).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
      });
      expect(unaction).toMatchObject({ success: true, closedReportIds: [OTHER_REPORT] });
      expect(remove).toMatchObject({ success: true, alreadyRemoved: expect.any(String) });
      expect(notifiedImages()).toEqual([]);
    });

    it('Remove writes a real block: the owner notice and a TOS blocklist entry', async () => {
      const result = await imageQueueActions.block(
        event({
          imageId: String(RULE_BLOCKED),
          reportId: String(report(RULE_BLOCKED)),
          violationType: 'other',
        })
      );

      expect(result).not.toHaveProperty('alreadyRemoved');
      expect(notifiedImages()).toEqual([`/images/${RULE_BLOCKED}`]);
      expect(blocklistReasons()).toEqual({ '110': 'TOS' });
      expect(reportsMovedTo('Actioned')).toEqual([report(RULE_BLOCKED)]);
    });
  });

  it('a bulk Unaction closes a grace-blocked report unpaid and a moderator-removed one paid', async () => {
    await imageQueueActions.bulkAccept(
      event({
        imageIds: [GRACE, MOD_REMOVED].join(','),
        reportIds: [report(GRACE), report(MOD_REMOVED)].join(','),
      })
    );

    const noReward = Object.fromEntries(
      setReportStatus.mock.calls.map(([a]) => [a.id, (a as { noReward?: boolean }).noReward])
    );
    expect(noReward).toEqual({ [report(GRACE)]: true, [report(MOD_REMOVED)]: false });
  });

  it('a bulk Unaction posting only a report from another image still restores no removed image', async () => {
    await imageQueueActions.bulkAccept(
      event({ imageIds: String(MOD_REMOVED), reportIds: String(report(HELD)) })
    );

    expect(await row(MOD_REMOVED)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('Unaction on an image under CSAM review and still up is refused, keeping the flag and the report', async () => {
    const result = await verdict('accept', FLAGGED_LIVE);

    expect(result).toMatchObject({ status: 409 });
    expect(await row(FLAGGED_LIVE)).toMatchObject({ ingestion: 'Scanned', needsReview: 'csam' });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('Unaction refuses a grace-blocked image even when a rule flagged it first', async () => {
    await db.query(
      `UPDATE "Image" SET metadata = metadata || '{"ruleId": 5}'::jsonb WHERE id = $1`,
      [GRACE]
    );

    await verdict('accept', GRACE);

    expect(await row(GRACE)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(reportsMovedTo('Actioned')).toEqual([report(GRACE)]);
  });

  it('Accept with no report posted, as the review queues post it, still restores it (control)', async () => {
    await imageQueueActions.accept(event({ imageId: String(MOD_REMOVED) }));

    expect(await row(MOD_REMOVED)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
  });

  it('Unaction on a reported image still up restores nothing and unactions the report (control)', async () => {
    await verdict('accept', LIVE);

    expect(await row(LIVE)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(reportsMovedTo('Unactioned')).toEqual([report(LIVE)]);
  });

  it('Unaction on a held image is refused as before and moves no report', async () => {
    const result = await verdict('accept', FLAG_ONLY);

    expect(result).toMatchObject({ status: 409 });
    expect(await row(FLAG_ONLY)).toMatchObject({ ingestion: 'Blocked', needsReview: 'csam' });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('Remove does not block it again: no second notice or blocklist write, the report actioned', async () => {
    const result = await verdict('block', MOD_REMOVED);

    expect(notifiedImages()).toEqual([]);
    expect(blocklistReasons()).toEqual({});
    expect(await row(MOD_REMOVED)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(reportsMovedTo('Actioned')).toEqual([report(MOD_REMOVED)]);
    expect(result).toMatchObject({ success: true, closedReportIds: [report(MOD_REMOVED)] });
  });

  it('a bulk Unaction closes its report and still unactions and restores the others', async () => {
    const result = await imageQueueActions.bulkAccept(
      event({
        imageIds: [MOD_REMOVED, OTHER_REASON].join(','),
        reportIds: [report(MOD_REMOVED), report(OTHER_REASON)].join(','),
      })
    );

    expect(await row(MOD_REMOVED)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(await row(OTHER_REASON)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(reportsMovedTo('Actioned')).toEqual([report(MOD_REMOVED)]);
    expect(reportsMovedTo('Unactioned')).toEqual([report(OTHER_REASON)]);
    expect(result).toMatchObject({ success: true, closedReportIds: [report(MOD_REMOVED)] });
  });

  it('a bulk Remove notifies only the owner of the image not yet removed, and actions both reports', async () => {
    await imageQueueActions.bulkBlock(
      event({
        imageIds: [MOD_REMOVED, OTHER_REASON].join(','),
        reportIds: [report(MOD_REMOVED), report(OTHER_REASON)].join(','),
      })
    );

    expect(notifiedImages()).toEqual([`/images/${OTHER_REASON}`]);
    expect(reportsMovedTo('Actioned').sort()).toEqual(
      [report(MOD_REMOVED), report(OTHER_REASON)].sort()
    );
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

describe('the blocklist hash', () => {
  it('is the exact 64-bit pHash, not a rounded float', async () => {
    const EXACT = '-4276845791567733103';
    await db.query(`UPDATE "Image" SET "pHash" = $1 WHERE id = $2`, [EXACT, OTHER_REASON]);
    // The app's Kysely clients parse INT8 with parseFloat (packages/civitai-db kysely.ts); PGlite's
    // default parser would hand back the exact value and hide a rounded read.
    const asInProduction = {
      query: (sql: string, params?: unknown[]) =>
        db.query(sql, params, { parsers: { 20: (value: string) => parseFloat(value) } }),
    } as unknown as PGlite;
    const primary = dbHandle.current;
    dbHandle.current = new Kysely({ dialect: pgliteDialect(asInProduction) });
    try {
      await block(OTHER_REASON);
    } finally {
      dbHandle.current = primary;
    }

    expect(Object.keys(blocklistReasons())).toEqual([EXACT]);
  });
});

describe('a CSAM blocklist write that fails', () => {
  const failBlocklistInsert = () =>
    clickhouseInsert.mockImplementationOnce(async ({ table }) => {
      if (table === 'blocked_images') throw new Error('Socket hang up');
    });

  it('fails the block action with a retry message, the block and its report still landing', async () => {
    failBlocklistInsert();

    const result = await block(HELD);

    expect(result).toMatchObject({
      status: 502,
      data: { error: expect.stringContaining('CSAM blocklist') },
    });
    expect(await row(HELD)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'csam-blocklist-write-failed' })
    );
  });

  it('a non-CSAM blocklist write that fails is still swallowed (control)', async () => {
    failBlocklistInsert();

    const result = await block(OTHER_REASON);

    expect(result).toEqual({ success: true, imageId: OTHER_REASON });
    expect(await row(OTHER_REASON)).toMatchObject({ ingestion: 'Blocked' });
  });

  it('a bulk block still blocks and actions the others, then names the image to retry', async () => {
    // Only the CSAM row fails: the two blocks run concurrently, so a fail-once could hit either.
    clickhouseInsert.mockImplementation(async ({ table, values }) => {
      if (table === 'blocked_images' && values.some((v) => v.reason === 'CSAM'))
        throw new Error('Socket hang up');
    });
    const ids = [HELD, OTHER_REASON];

    const result = await imageQueueActions
      .bulkBlock(event({ imageIds: ids.join(','), reportIds: ids.map(report).join(',') }))
      .finally(() => clickhouseInsert.mockImplementation(async () => undefined));

    expect(result).toMatchObject({ status: 502, data: { imageIds: [HELD] } });
    expect(await row(OTHER_REASON)).toMatchObject({ ingestion: 'Blocked' });
    expect(actionedReports()).toEqual([report(OTHER_REASON)]);
  });
});

describe('a block under the review flag alone, later cleared', () => {
  it('has its TOS entry disabled when the image is restored', async () => {
    await block(FLAGGED_LIVE);
    expect(blocklistReasons()).toEqual({ '103': 'TOS' });
    clickhouseInsert.mockClear();
    csamCheck.live = [{ hash: '103', reason: 'TOS' }];
    try {
      await acceptImage({ imageId: FLAGGED_LIVE, userId: 2, restoreRemoved: true });
    } finally {
      csamCheck.live = [];
    }

    const disabled = clickhouseInsert.mock.calls
      .map(([a]) => a)
      .filter((a) => a.table === 'blocked_images')
      .flatMap((a) => a.values);
    expect(disabled).toEqual([{ hash: '103', reason: 'TOS', disabled: true }]);
  });
});
