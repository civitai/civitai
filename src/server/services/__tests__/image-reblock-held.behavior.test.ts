import { PGlite } from '@electric-sql/pglite';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as NotificationService from '~/server/services/notification.service';
import type * as Rewards from '~/server/rewards';

/**
 * Blocking a held image (removed for CSAM, or under the review flag and not dismissed) writes the block
 * and nothing the owner or a reporter would see: no owner notice, no report actioned, no reward, and a
 * CSAM blocklist entry. One under review also gets a deferred-effect row for its review's close. Any
 * other image still gets all of them. The block's own UPDATE decides, so it runs here.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/image-removal-hold.service', () => ({
  canConfirmReRemoval: async () => false,
  holdRemovals: async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  }),
  heldRemovalSummary: () => [],
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { createNotification, applyReward, clickhouseInsert } = vi.hoisted(() => ({
  createNotification: vi.fn(async (_n: { details: { url: string } }) => undefined),
  applyReward: vi.fn(async (_a: { userId: number; reportId: number }, _o?: unknown) => undefined),
  clickhouseInsert: vi.fn(
    async (_a: { table: string; values: { hash: string; reason: string }[] }) => undefined
  ),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
vi.mock('~/server/rewards', async (importOriginal) => ({
  ...(await importOriginal<typeof Rewards>()),
  reportAcceptedReward: { apply: applyReward },
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert: clickhouseInsert, $query: vi.fn(async () => []) },
}));

const markResolved = vi.fn(async (_k: string, _f: string[], _t: number) => 1);
const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const run = async (flat: { text: string; values: unknown[] }) =>
  holder.db.query(flat.text, flat.values as unknown[]);

// Each image's TOS report has the image's id plus 1000.
const HELD = 71; // removed, block reason kept
const FLAGGED_LIVE = 72; // under review, not removed yet
const FLAG_REMOVED = 73; // removed with the review flag, another reason
const OTHER_REASON = 74; // removed for another reason
const DISMISSED = 75; // removed with the review flag, dismissed from its queue
const report = (imageId: number) => imageId + 1000;
// And its pHash is the id plus 130.

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int,
      ingestion text,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "needsReview" text,
      "pHash" bigint,
      "updatedAt" timestamp(3),
      metadata jsonb
    );
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'CSAM');
    CREATE TABLE "Report" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      reason "ReportReason" NOT NULL,
      status "ReportStatus" NOT NULL,
      "statusSetAt" timestamp(3),
      "statusSetBy" int,
      "alsoReportedBy" int[] NOT NULL DEFAULT '{}',
      details jsonb,
      "previouslyReviewedCount" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "ImageReport" ("imageId" int, "reportId" int);
    CREATE TABLE "CsamQueueSetAside" ("imageId" int PRIMARY KEY, outcome text NOT NULL);
    CREATE TABLE "ImageDeferredBlockEffect" (
      "imageId" int PRIMARY KEY,
      "violationType" text,
      "notifyOwner" boolean NOT NULL DEFAULT true,
      "reportReason" text,
      "reportIds" int[] NOT NULL DEFAULT '{}',
      "blockedBy" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  // No reporter here is banned or deleted.
  dbMock.dbWrite.user.findMany.mockResolvedValue([] as never);
  (redisMock.redis as unknown as { hSetMultiWithExpire: typeof markResolved }).hSetMultiWithExpire =
    markResolved;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    if (!/"blockedFor" = CASE|"Report"|"Image" WHERE id = ANY/.test(flat.text)) return [];
    return (await run(flat)).rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    // The block, its deferred row and `clearReviewFlagsOnBlock`; the other raw writers touch tables
    // this stand-in lacks.
    if (!/SET "needsReview" = NULL|"blockedFor" = CASE|"ImageDeferredBlockEffect"/.test(flat.text))
      return 0;
    return (await run(flat)).affectedRows ?? 0;
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "Report", "ImageReport", "CsamQueueSetAside", "ImageDeferredBlockEffect";
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "needsReview", "pHash") VALUES
      (${HELD}, 7, 'Blocked', 'CSAM', 32, NULL, 201),
      (${FLAGGED_LIVE}, 7, 'Scanned', NULL, 4, 'csam', 202),
      (${FLAG_REMOVED}, 7, 'Blocked', 'moderated', 32, 'csam', 203),
      (${OTHER_REASON}, 7, 'Blocked', 'AiNotVerified', 32, NULL, 204),
      (${DISMISSED}, 7, 'Blocked', 'moderated', 32, 'csam', 205);
    INSERT INTO "CsamQueueSetAside" ("imageId", outcome) VALUES (${DISMISSED}, 'Dismissed');
    INSERT INTO "Report" (id, "userId", reason, status)
      SELECT id + 1000, 9, 'TOSViolation', 'Pending' FROM "Image";
    INSERT INTO "ImageReport" ("imageId", "reportId") SELECT id, id + 1000 FROM "Image";
  `);
  dbMock.dbRead.image.findMany.mockImplementation((async ({
    where,
  }: {
    where?: { id?: { in?: number[] } };
  }) => {
    const ids: number[] = where?.id?.in ?? [];
    return (
      await holder.db.query(
        // A replica that has not seen the held image's reason, so only the block's RETURNING knows it.
        `SELECT id, "userId", "pHash", NULL::int AS "postId", "nsfwLevel",
           CASE WHEN id = $2 THEN NULL ELSE "blockedFor" END AS "blockedFor", "needsReview"
         FROM "Image" WHERE id = ANY($1)`,
        [ids, HELD]
      )
    ).rows;
  }) as never);
});

const { handleBlockImages } = await import('~/server/services/image.service');
const { setTosViolationHandler } = await import('~/server/controllers/image.controller');

/** `replicaPHash`: what a lagging replica read returns instead of the row's hash. */
const tosBlock = async (id: number, violationType?: string, replicaPHash?: bigint | null) => {
  const [image] = (
    await holder.db.query<{ pHash: bigint | null }>(`SELECT "pHash" FROM "Image" WHERE id = $1`, [
      id,
    ])
  ).rows;
  dbMock.dbRead.image.findFirst.mockResolvedValue({
    nsfwLevel: 32,
    userId: 7,
    postId: null,
    pHash:
      replicaPHash !== undefined ? replicaPHash : image.pHash == null ? null : BigInt(image.pHash),
    post: null,
  } as never);
  await setTosViolationHandler({
    input: { id, violationType },
    ctx: { user: { id: 2, isModerator: true }, ip: '127.0.0.1', track: { images: vi.fn() } },
  } as never);
};

const notifiedImages = () =>
  createNotification.mock.calls.map(
    ([n]) => (n as unknown as { details: { url: string } }).details.url
  );
const reportStatus = async (id: number) =>
  (await holder.db.query<{ status: string }>(`SELECT status FROM "Report" WHERE id = $1`, [id]))
    .rows[0].status;
const rewardedReports = () =>
  applyReward.mock.calls.map(([a]) => (a as unknown as { reportId: number }).reportId);
const blocklistReasons = () =>
  Object.fromEntries(
    clickhouseInsert.mock.calls
      .map(([a]) => a as unknown as { table: string; values: { hash: string; reason: string }[] })
      .filter((a) => a.table === 'blocked_images')
      .flatMap((a) => a.values.map((v) => [String(v.hash), String(v.reason)]))
  );
const blockedFor = async (id: number) =>
  (
    await holder.db.query<{ blockedFor: string | null }>(
      `SELECT "blockedFor" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0].blockedFor;

const deferred = async () =>
  (
    await holder.db.query<{
      imageId: number;
      violationType: string | null;
      blockedBy: number | null;
    }>(
      `SELECT "imageId", "violationType", "blockedBy" FROM "ImageDeferredBlockEffect" ORDER BY "imageId"`
    )
  ).rows;

const deferredScope = async () =>
  (
    await holder.db.query<{ imageId: number; notifyOwner: boolean; reportReason: string | null }>(
      `SELECT "imageId", "notifyOwner", "reportReason" FROM "ImageDeferredBlockEffect" ORDER BY "imageId"`
    )
  ).rows;

const noHashLogs = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([e]) => e as { name?: string; payload?: unknown })
    .filter((e) => e.name === 'csam-blocklist-no-hash')
    .map((e) => e.payload);

const underReviewNotices = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([e]) => e as { name?: string; imageId?: number; userId?: number })
    .filter((e) => e.name === 'image-notice-under-review')
    .map((e) => [e.imageId, e.userId]);

describe('setTosViolationHandler on an image removed with its block reason kept', () => {
  it('blocks it, sends no notice, actions no report, pays no reward', async () => {
    await tosBlock(HELD);

    expect(await blockedFor(HELD)).toBe('CSAM');
    expect(notifiedImages()).toEqual([]);
    expect(await reportStatus(report(HELD))).toBe('Pending');
    expect(rewardedReports()).toEqual([]);
  });

  it('keeps its blocklist entry at CSAM', async () => {
    await tosBlock(HELD);

    expect(blocklistReasons()).toEqual({ '201': 'CSAM' });
  });
});

describe('setTosViolationHandler on an image under the review flag', () => {
  it.each([
    ['not removed yet', FLAGGED_LIVE],
    ['already removed', FLAG_REMOVED],
  ])('%s: sends no notice, actions no report, pays no reward, and defers them', async (_, id) => {
    await tosBlock(id, 'realPerson');

    expect(notifiedImages()).toEqual([]);
    expect(await reportStatus(report(id))).toBe('Pending');
    expect(rewardedReports()).toEqual([]);
    expect(await deferred()).toEqual([{ imageId: id, violationType: 'realPerson', blockedBy: 2 }]);
    expect(blocklistReasons()).toEqual({ [String(id + 130)]: 'TOS' });
  });

  it('defers a block with no violation chosen as reason-less', async () => {
    await tosBlock(FLAGGED_LIVE);

    expect(await deferred()).toEqual([
      { imageId: FLAGGED_LIVE, violationType: null, blockedBy: 2 },
    ]);
  });

  it('defers its TOS reports, and a notice only when the image was not removed yet', async () => {
    await tosBlock(FLAGGED_LIVE);
    await tosBlock(FLAG_REMOVED);

    expect(await deferredScope()).toEqual([
      { imageId: FLAGGED_LIVE, notifyOwner: true, reportReason: 'TOSViolation' },
      { imageId: FLAG_REMOVED, notifyOwner: false, reportReason: 'TOSViolation' },
    ]);
  });

  it("keeps the first block's notice and takes the report scope of the next", async () => {
    await handleBlockImages({
      ids: [FLAGGED_LIVE],
      include: ['user-notification'],
      moderatorId: 2,
    });
    await tosBlock(FLAGGED_LIVE);

    expect(await deferredScope()).toEqual([
      { imageId: FLAGGED_LIVE, notifyOwner: true, reportReason: 'TOSViolation' },
    ]);
  });

  it('keeps the first deferred row when blocked again', async () => {
    await tosBlock(FLAGGED_LIVE, 'realPerson');
    await tosBlock(FLAGGED_LIVE, 'gore');

    expect(await deferred()).toEqual([
      { imageId: FLAGGED_LIVE, violationType: 'realPerson', blockedBy: 2 },
    ]);
  });
});

describe('setTosViolationHandler on an image dismissed from the review queue', () => {
  it('notifies, actions and rewards as any other block, logs the notice, and defers nothing', async () => {
    await tosBlock(DISMISSED);

    expect(notifiedImages()).toEqual([`/images/${DISMISSED}`]);
    expect(await reportStatus(report(DISMISSED))).toBe('Actioned');
    expect(rewardedReports()).toEqual([report(DISMISSED)]);
    expect(underReviewNotices()).toEqual([[DISMISSED, 7]]);
    expect(await deferred()).toEqual([]);
  });
});

describe('setTosViolationHandler on an image removed with its block reason kept', () => {
  it('defers nothing: there is no review to close', async () => {
    await tosBlock(HELD);

    expect(await deferred()).toEqual([]);
  });
});

describe('blocking an image under the review flag again', () => {
  // Only a confirmed CSAM removal writes a CSAM entry; the review flag alone writes TOS, every
  // time it is blocked.
  it('writes a TOS blocklist entry each time it is blocked under the flag alone', async () => {
    await tosBlock(FLAGGED_LIVE);
    await tosBlock(FLAGGED_LIVE);
    await handleBlockImages({ ids: [FLAGGED_LIVE], include: ['phash-block'] });

    const reasons = clickhouseInsert.mock.calls
      .map(([a]) => a as unknown as { table: string; values: { hash: string; reason: string }[] })
      .filter((a) => a.table === 'blocked_images')
      .flatMap((a) =>
        a.values.filter((v) => String(v.hash) === '202').map((v) => String(v.reason))
      );
    expect(reasons).toHaveLength(3);
    expect(new Set(reasons)).toEqual(new Set(['TOS']));
  });
});

describe('setTosViolationHandler on any other image', () => {
  it('notifies the owner, actions the report, pays the reward and adds a TOS blocklist entry', async () => {
    await tosBlock(OTHER_REASON);

    expect(notifiedImages()).toEqual([`/images/${OTHER_REASON}`]);
    expect(await reportStatus(report(OTHER_REASON))).toBe('Actioned');
    expect(rewardedReports()).toEqual([report(OTHER_REASON)]);
    expect(blocklistReasons()).toEqual({ '204': 'TOS' });
    expect(underReviewNotices()).toEqual([]);
    expect(await deferred()).toEqual([]);
  });
});

describe('handleBlockImages over held and other images', () => {
  const all = [HELD, FLAGGED_LIVE, FLAG_REMOVED, OTHER_REASON, DISMISSED];

  it('notifies only the owners of images not held, and defers the ones under review', async () => {
    await handleBlockImages({ ids: all, include: ['user-notification'], moderatorId: 2 });

    expect(notifiedImages().sort()).toEqual([OTHER_REASON, DISMISSED].map((id) => `/images/${id}`));
    expect(underReviewNotices()).toEqual([[DISMISSED, 7]]);
    expect(await deferredScope()).toEqual([
      { imageId: FLAGGED_LIVE, notifyOwner: true, reportReason: null },
      { imageId: FLAG_REMOVED, notifyOwner: false, reportReason: null },
    ]);
  });

  it('notifies no one for a feedback page capture, where an ordinary owner is told (control)', async () => {
    const CAPTURE = 99;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "needsReview", "pHash")
        VALUES (${CAPTURE}, ${FEEDBACK_CAPTURE_OWNER_ID}, 'Blocked', 'moderated', 32, NULL, 299);
    `);

    await handleBlockImages({
      ids: [CAPTURE, OTHER_REASON],
      include: ['user-notification'],
      moderatorId: 2,
    });

    expect(notifiedImages()).toEqual([`/images/${OTHER_REASON}`]);
  });

  it('defers nothing when it sends no notice', async () => {
    await handleBlockImages({ ids: all, moderatorId: 2 });

    expect(await deferred()).toEqual([]);
  });

  it('adds a CSAM blocklist entry for the confirmed CSAM image only', async () => {
    await handleBlockImages({ ids: all, include: ['phash-block'] });

    expect(blocklistReasons()).toEqual({
      '201': 'CSAM',
      '202': 'TOS',
      '203': 'TOS',
      '204': 'TOS',
      '205': 'TOS',
    });
    expect(noHashLogs()).toEqual([]);
  });

  it('writes the CSAM entry from the row when the replica read has no hash yet', async () => {
    const replica = dbMock.dbRead.image.findMany.getMockImplementation()!;
    dbMock.dbRead.image.findMany.mockImplementationOnce((async (args: never) =>
      ((await replica(args)) as { id: number }[]).map((row) =>
        row.id === HELD ? { ...row, pHash: null } : row
      )) as never);

    await handleBlockImages({ ids: all, include: ['phash-block'] });

    expect(blocklistReasons()['201']).toBe('CSAM');
    expect(noHashLogs()).toEqual([]);
  });

  it('a CSAM removal with no hash on the row still blocks, and logs only its id and step', async () => {
    await holder.db.exec(`UPDATE "Image" SET "pHash" = NULL WHERE id = ${HELD}`);

    await handleBlockImages({ ids: all, include: ['phash-block'] });

    expect(blocklistReasons()['201']).toBeUndefined();
    expect(noHashLogs()).toEqual([{ imageId: HELD, step: 'block' }]);
  });
});

describe("handleBlockImages and the images' reports", () => {
  const all = [HELD, FLAGGED_LIVE, FLAG_REMOVED, OTHER_REASON, DISMISSED];
  const CSAM_REPORT = 2001;
  const UNACTIONED_REPORT = 2002;
  const ACTIONED_REPORT = 2003;
  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, "userId", reason, status) VALUES
        (${CSAM_REPORT}, 9, 'CSAM', 'Pending'), (${UNACTIONED_REPORT}, 9, 'TOSViolation', 'Unactioned'),
        (${ACTIONED_REPORT}, 9, 'TOSViolation', 'Actioned');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES
        (${OTHER_REASON}, ${CSAM_REPORT}), (${OTHER_REASON}, ${UNACTIONED_REPORT}),
        (${OTHER_REASON}, ${ACTIONED_REPORT});
    `);
  });
  const statuses = async () =>
    Object.fromEntries(
      (
        await holder.db.query<{ id: number; status: string }>(
          `SELECT id, status FROM "Report" ORDER BY id`
        )
      ).rows.map((r) => [r.id, r.status])
    );

  // An image under the review flag keeps its reports even once dismissed from the CSAM queue, unlike
  // `setTosViolationHandler`: a bulk removal leaves every flagged image's reports to that queue.
  it("a moderator's removal actions and rewards the Pending TOS reports of images not held or flagged", async () => {
    await handleBlockImages({ ids: all, moderatorId: 2 });

    expect(await statuses()).toEqual({
      [report(HELD)]: 'Pending',
      [report(FLAGGED_LIVE)]: 'Pending',
      [report(FLAG_REMOVED)]: 'Pending',
      [report(OTHER_REASON)]: 'Actioned',
      [report(DISMISSED)]: 'Pending',
      [CSAM_REPORT]: 'Pending',
      [UNACTIONED_REPORT]: 'Unactioned',
      [ACTIONED_REPORT]: 'Actioned',
    });
    expect(applyReward).toHaveBeenCalledWith(
      { userId: 9, reportId: report(OTHER_REASON) },
      expect.anything()
    );
    expect(rewardedReports()).toEqual([report(OTHER_REASON)]);
  });

  it('a failure settling the reports leaves them Pending and still completes the removal', async () => {
    const raw = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...v: unknown[]) =>
      strings.join('').includes('FROM "Report" r')
        ? Promise.reject(new Error('lock timeout'))
        : raw(strings, ...v)) as never);

    await expect(handleBlockImages({ ids: all, moderatorId: 2 })).resolves.toBeDefined();

    expect(await blockedFor(OTHER_REASON)).toBe('moderated');
    expect(await reportStatus(report(OTHER_REASON))).toBe('Pending');
    expect(rewardedReports()).toEqual([]);
  });

  it('pays every reporter of a settled report, co-reporters included', async () => {
    await holder.db.exec(
      `UPDATE "Report" SET "alsoReportedBy" = '{10}' WHERE id = ${report(OTHER_REASON)}`
    );

    await handleBlockImages({ ids: all, moderatorId: 2 });

    expect(applyReward.mock.calls.map(([a]) => a.userId).sort()).toEqual([10, 9].sort());
    expect(rewardedReports()).toEqual([report(OTHER_REASON), report(OTHER_REASON)]);
  });

  it('stamps the settled report as reviewed and marks it resolved for the moderator queue', async () => {
    await holder.db.exec(
      `UPDATE "Report" SET "alsoReportedBy" = '{10}' WHERE id = ${report(OTHER_REASON)}`
    );

    await handleBlockImages({ ids: all, moderatorId: 2 });

    const { rows } = await holder.db.query<{ previouslyReviewedCount: number }>(
      `SELECT "previouslyReviewedCount" FROM "Report" WHERE id = $1`,
      [report(OTHER_REASON)]
    );
    expect(rows[0].previouslyReviewedCount).toBe(2);
    expect(markResolved).toHaveBeenCalledWith(
      'report:resolved-recent',
      [String(report(OTHER_REASON)), '1'],
      300
    );
  });

  it("drops a moderation rule's keys, so the removal reads as the moderator's", async () => {
    await holder.db.exec(
      `UPDATE "Image" SET metadata = '{"ruleId": 5, "ruleReason": "r", "other": 1}' WHERE id = ${OTHER_REASON}`
    );

    await handleBlockImages({ ids: [OTHER_REASON], moderatorId: 2 });

    const { rows } = await holder.db.query<{ metadata: unknown }>(
      `SELECT metadata FROM "Image" WHERE id = $1`,
      [OTHER_REASON]
    );
    expect(rows[0].metadata).toEqual({ other: 1 });
  });

  it('a failed banned-reporter lookup leaves the reports Pending and pays nobody', async () => {
    dbMock.dbWrite.user.findMany.mockRejectedValue(new Error('connection lost') as never);

    await expect(handleBlockImages({ ids: all, moderatorId: 2 })).resolves.toBeDefined();

    expect(await reportStatus(report(OTHER_REASON))).toBe('Pending');
    expect(rewardedReports()).toEqual([]);
  });

  it('a second removal of the same images pays nothing more', async () => {
    await handleBlockImages({ ids: all, moderatorId: 2 });
    await handleBlockImages({ ids: [OTHER_REASON], moderatorId: 3 });

    expect(rewardedReports()).toEqual([report(OTHER_REASON)]);
  });

  it('an account-wide removal moves no report and pays no one', async () => {
    dbMock.dbRead.image.findMany.mockImplementationOnce(
      (async () =>
        (
          await holder.db.query(
            `SELECT id, "userId", "pHash", NULL::int AS "postId", "nsfwLevel", "blockedFor", "needsReview"
           FROM "Image" WHERE "userId" = 7`
          )
        ).rows) as never
    );
    await handleBlockImages({ userId: 7, moderatorId: 2 });

    expect(await blockedFor(OTHER_REASON)).toBe('moderated');

    expect(await reportStatus(report(OTHER_REASON))).toBe('Pending');
    expect(rewardedReports()).toEqual([]);
  });

  it('a removal with no moderator moves no report', async () => {
    await handleBlockImages({ ids: all });

    expect(await reportStatus(report(OTHER_REASON))).toBe('Pending');
    expect(rewardedReports()).toEqual([]);
  });
});

describe('setTosViolationHandler on a CSAM removal with no hash on the row', () => {
  it('writes the CSAM entry from the row when the replica read has no hash yet', async () => {
    await tosBlock(HELD, undefined, null);

    expect(blocklistReasons()).toEqual({ '201': 'CSAM' });
    expect(noHashLogs()).toEqual([]);
  });

  it('still blocks, writes no entry, and logs only its id and step', async () => {
    await holder.db.exec(`UPDATE "Image" SET "pHash" = NULL WHERE id = ${HELD}`);

    await tosBlock(HELD);

    expect(blocklistReasons()).toEqual({});
    expect(noHashLogs()).toEqual([{ imageId: HELD, step: 'block' }]);
  });
});
