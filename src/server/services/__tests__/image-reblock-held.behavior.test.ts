import { PGlite } from '@electric-sql/pglite';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
      "updatedAt" timestamp(3)
    );
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'CSAM');
    CREATE TABLE "Report" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      reason "ReportReason" NOT NULL,
      status "ReportStatus" NOT NULL,
      "statusSetAt" timestamp(3),
      "statusSetBy" int
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

const tosBlock = async (id: number, violationType?: string) => {
  const [image] = (
    await holder.db.query<{ pHash: bigint | null }>(`SELECT "pHash" FROM "Image" WHERE id = $1`, [
      id,
    ])
  ).rows;
  dbMock.dbRead.image.findFirst.mockResolvedValue({
    nsfwLevel: 32,
    userId: 7,
    postId: null,
    pHash: BigInt(image.pHash as never),
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
    expect(blocklistReasons()).toEqual({ [String(id + 130)]: 'CSAM' });
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
  it('never replaces its CSAM blocklist entry with a TOS one', async () => {
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
    expect(new Set(reasons)).toEqual(new Set(['CSAM']));
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

  it('adds a CSAM blocklist entry for the held and flagged images only', async () => {
    await handleBlockImages({ ids: all, include: ['phash-block'] });

    expect(blocklistReasons()).toEqual({
      '201': 'CSAM',
      '202': 'CSAM',
      '203': 'CSAM',
      '204': 'TOS',
      '205': 'CSAM',
    });
  });
});
