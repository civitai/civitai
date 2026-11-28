import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as TextScanRoute from '~/server/services/text-scan/route';

// The Redis-backed post-commit helpers never settle without a live Redis, so they are stubbed.
const { enqueueImageIngestion, preventReplicationLag } = vi.hoisted(() => ({
  enqueueImageIngestion: vi.fn(),
  preventReplicationLag: vi.fn(async () => undefined),
}));

// The withheld rule a rescan asks runs for real. Image 30 is withheld from a moderator without the
// grant; every other image is not.
const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});
beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion text, "needsReview" text,
      "blockedFor" text, "userId" int, "pHash" bigint, "postId" int);
    ${WITHHELD_TABLES_SQL}
    INSERT INTO "Image" (id, url, ingestion, "userId") VALUES (10, 'key-10', 'Scanned', 7), (30, 'key-30', 'Scanned', 7);
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES (31, 'key-30', 'Blocked', 'CSAM', 8);
  `);
}, 60_000);

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag,
}));
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanRoute>()),
  submitTextModerationOrScan: vi.fn(async () => undefined),
}));

import {
  rescanArticle,
  rescanArticleImage,
  retryArticleErrorImages,
} from '~/server/services/article.service';

const ARTICLE_ID = 21;
const AUTHOR = 7;
const SOMEONE_ELSE = 8;
const MODERATOR = 99;

type Img = ReturnType<typeof image>;
const image = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  url: `00000000-0000-0000-0000-0000000000${id}`,
  type: 'image',
  userId: AUTHOR,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  nsfwLevelLocked: false,
  blockedFor: null as string | null,
  needsReview: null as string | null,
  ...over,
});

const CLEAN = image(10);
// One block marker per image: a scan error or a rescan request can leave either of the last two.
const BLOCKED = image(11, { ingestion: 'Blocked' });
const BLOCKED_LEVEL_ONLY = image(12, { ingestion: 'Rescan', nsfwLevel: 32 });
const BLOCK_REASON_ONLY = image(13, { ingestion: 'Error', blockedFor: 'tos' });
const FOREIGN = image(14, { userId: SOMEONE_ELSE });
const PENDING = image(15, { ingestion: 'Pending' });
const LOCKED = image(16, { nsfwLevelLocked: true });
const AWAITING_MINOR_REVIEW = image(21, { needsReview: 'minor' });
const AWAITING_SOURCE_REVIEW = image(22, { needsReview: 'remixSource' });

const SKIPPED: [string, Img][] = [
  ['a blocked image', BLOCKED],
  ['an image that keeps only its Blocked level', BLOCKED_LEVEL_ONLY],
  ['an image that keeps only its block reason', BLOCK_REASON_ONLY],
  ["another owner's image", FOREIGN],
  ['an image still in flight', PENDING],
  ['an image whose rating a moderator locked', LOCKED],
  ['an image awaiting a minor review', AWAITING_MINOR_REVIEW],
  ['an image awaiting a source review', AWAITING_SOURCE_REVIEW],
];

const CHANGED_AFTER_READ: [string, Partial<Img>][] = [
  ['is blocked', { ingestion: 'Blocked' }],
  ['takes the Blocked level', { nsfwLevel: 32 }],
  ['takes a block reason', { blockedFor: 'tos' }],
  ['has its rating locked', { nsfwLevelLocked: true }],
  ['passes to another owner', { userId: SOMEONE_ELSE }],
  ['starts scanning', { ingestion: 'Pending' }],
  ['goes to review', { needsReview: 'minor' }],
  ['goes to a source review', { needsReview: 'remixSource' }],
];

/** The columns a Prisma `select` asked for, so a column the code stops selecting reads undefined. */
const pick = (row: Img, select: Record<string, boolean>) =>
  Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof Img]]));

const storeArticle = (coverId: number | null, bannerId: number | null = null) => {
  const article = {
    id: ARTICLE_ID,
    userId: AUTHOR,
    content: '',
    title: 'A title',
    coverId,
    bannerId,
    status: 'Draft',
    scheduledAt: null,
  };
  dbMock.dbRead.article.findUnique.mockResolvedValue(article as never);
  dbMock.dbWrite.article.findUnique.mockResolvedValue(article as never);
};

/** A lagging replica: it still holds every image as clean, unblocked and the author's own. */
const stale = (img: Img) => ({
  ...img,
  userId: AUTHOR,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  nsfwLevelLocked: false,
  blockedFor: null,
});

/** The Prisma filter operators the Rescan write uses; any other one fails the test loudly. */
const matchesWhere = (row: Record<string, unknown>, where: Record<string, any>): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, any>[]).every((w) => matchesWhere(row, w));
    if (cond === null || typeof cond !== 'object') return row[key] === cond;
    if ('in' in cond) return cond.in.includes(row[key]);
    if ('notIn' in cond) return !cond.notIn.includes(row[key]);
    if ('not' in cond) return row[key] !== cond.not;
    throw new Error(`matchesWhere: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
  });

/** Changes that land on the primary after the rescan read the row and before it writes. */
let landedAfterRead: Record<number, Partial<Img>> = {};

const storeImages = ({ connected = [], byId = [] }: { connected?: Img[]; byId?: Img[] }) => {
  dbMock.dbWrite.image.updateManyAndReturn.mockImplementation((async ({ where }: any) =>
    [...connected, ...byId]
      .map((img) => ({ ...img, ...landedAfterRead[img.id] }))
      .filter((row) => matchesWhere(row, where))
      .map(({ id }) => ({ id }))) as never);
  for (const [db, view] of [
    [dbMock.dbWrite, (img: Img) => img],
    [dbMock.dbRead, stale],
  ] as const) {
    db.imageConnection.findMany.mockImplementation((async ({ include }: any) =>
      connected.map((img) => ({
        imageId: img.id,
        image: pick(view(img), include.image.select),
      }))) as never);
    db.image.findUnique.mockImplementation((async ({ where, select }: any) => {
      const img = byId.find((x) => x.id === where.id);
      return img ? pick(view(img), select) : null;
    }) as never);
    db.image.findMany.mockImplementation((async ({ where, select }: any) =>
      byId
        .filter((x) => where.id.in.includes(x.id))
        .map((img) => pick(view(img), select))) as never);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  landedAfterRead = {};
  storeArticle(null);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
  dbMock.dbRead.imageConnection.findFirst.mockResolvedValue({ imageId: 1 } as never);
});

/** Ids an `updateManyAndReturn` set to `ingestion`. */
const written = async (ingestion: string) => {
  const { calls, results } = dbMock.dbWrite.image.updateManyAndReturn.mock;
  const rows = await Promise.all(
    results.filter((_, i) => calls[i][0]?.data.ingestion === ingestion).map((r) => r.value)
  );
  return rows.flatMap((set: { id: number }[]) => set.map(({ id }) => id));
};

/** Ids the rescan flipped to Rescan and the ids it sent to scan; both must agree. */
const requeued = async () => {
  expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  const flipped = await written('Rescan');
  const sent = enqueueImageIngestion.mock.calls.flatMap(([arg]) =>
    arg.images.map((img: { id: number }) => img.id)
  );
  expect(sent.sort()).toEqual([...flipped].sort());
  return flipped;
};

describe('rescanArticle', () => {
  it('skips a withheld image for a caller without the grant, and re-queues it with the grant', async () => {
    const withheld = image(30);
    storeImages({ connected: [CLEAN, withheld] });
    await rescanArticle({ csamReview: false, id: ARTICLE_ID, isModerator: false });
    expect(await requeued()).toEqual([CLEAN.id]);

    vi.clearAllMocks();
    storeImages({ connected: [CLEAN, withheld] });
    await rescanArticle({ csamReview: true, id: ARTICLE_ID, isModerator: true });
    expect((await requeued()).sort()).toEqual([CLEAN.id, withheld.id]);
  });

  it("re-queues only the author's settled, unblocked images", async () => {
    storeImages({ connected: [CLEAN, ...SKIPPED.map(([, img]) => img)] });

    await rescanArticle({ csamReview: true, id: ARTICLE_ID, isModerator: true });

    expect(await requeued()).toEqual([CLEAN.id]);
    // Refused on the read, so the write never sees them.
    expect(dbMock.dbWrite.image.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [CLEAN.id] } }) })
    );
  });

  it('re-queues a clean cover that is not among the connected images', async () => {
    const cover = image(17);
    storeArticle(cover.id);
    storeImages({ connected: [CLEAN], byId: [cover] });

    await rescanArticle({ csamReview: true, id: ARTICLE_ID, isModerator: true });

    expect((await requeued()).sort()).toEqual([CLEAN.id, cover.id]);
  });

  it('re-queues a clean banner beside the cover', async () => {
    const cover = image(17);
    const banner = image(18);
    storeArticle(cover.id, banner.id);
    storeImages({ connected: [CLEAN], byId: [cover, banner] });

    await rescanArticle({ csamReview: true, id: ARTICLE_ID, isModerator: true });

    expect((await requeued()).sort()).toEqual([CLEAN.id, cover.id, banner.id]);
  });

  it('leaves a blocked cover alone', async () => {
    storeArticle(BLOCKED.id);
    storeImages({ connected: [CLEAN], byId: [BLOCKED] });

    await rescanArticle({ csamReview: true, id: ARTICLE_ID, isModerator: true });

    expect(await requeued()).toEqual([CLEAN.id]);
  });

  it("leaves the author's images outside the article alone", async () => {
    const elsewhere = image(20);
    storeImages({ connected: [CLEAN], byId: [elsewhere] });

    await rescanArticle({ csamReview: true, id: ARTICLE_ID, isModerator: true });

    expect(await requeued()).toEqual([CLEAN.id]);
  });

  it.each(CHANGED_AFTER_READ)(
    'leaves an image alone when it %s between the read and the write',
    async (_, change) => {
      const changing = image(19);
      landedAfterRead[changing.id] = change;
      storeImages({ connected: [CLEAN, changing] });

      await rescanArticle({ csamReview: true, id: ARTICLE_ID, isModerator: true });

      expect(await requeued()).toEqual([CLEAN.id]);
    }
  );
});

describe('rescanArticleImage', () => {
  const rescan = (img: Img, userId = AUTHOR) =>
    rescanArticleImage({
      csamReview: true,
      articleId: ARTICLE_ID,
      imageId: img.id,
      userId,
      isModerator: true,
    });

  it.each(SKIPPED.filter(([, img]) => img !== PENDING))(
    'refuses %s, so the caller is not told it was sent',
    async (_, img) => {
      storeImages({ byId: [img] });

      await expect(rescan(img)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(await requeued()).toEqual([]);
      expect(dbMock.dbWrite.image.updateManyAndReturn).not.toHaveBeenCalled();
      // A refusal does not use one of the day's attempts.
      expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    }
  );

  it('does nothing for an image still in flight', async () => {
    storeImages({ byId: [PENDING] });

    await rescan(PENDING);

    expect(await requeued()).toEqual([]);
  });

  it("re-queues the author's own unblocked image", async () => {
    storeImages({ byId: [CLEAN] });

    await rescan(CLEAN);

    expect(await requeued()).toEqual([CLEAN.id]);
    expect(redisMock.redis.packed.set).toHaveBeenCalledOnce();
  });

  it("re-queues it for a moderator rescanning someone else's article, under the author", async () => {
    storeImages({ byId: [CLEAN] });

    await rescan(CLEAN, MODERATOR);

    expect(await requeued()).toEqual([CLEAN.id]);
    expect(enqueueImageIngestion).toHaveBeenCalledWith(expect.objectContaining({ userId: AUTHOR }));
  });

  it.each(CHANGED_AFTER_READ)(
    'refuses an image that %s between the read and the write',
    async (_, change) => {
      landedAfterRead[CLEAN.id] = change;
      storeImages({ byId: [CLEAN] });

      await expect(rescan(CLEAN)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(await requeued()).toEqual([]);
      expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    }
  );
});

describe("retryArticleErrorImages, the reconcile job's retry round", () => {
  const FAILED = image(30, { ingestion: 'Error' });
  const MISSING = image(31, { ingestion: 'NotFound' });
  const retry = (over: Partial<Parameters<typeof retryArticleErrorImages>[0]> = {}) =>
    retryArticleErrorImages({
      article: { id: ARTICLE_ID, userId: AUTHOR, coverId: null, bannerId: null },
      includeNotFound: true,
      budget: 10,
      fullBudget: true,
      absentImages: async () => new Set<number>(),
      ...over,
    });

  // Agreed with the Moderation Lead (#10522): the retry never re-submits an image under review.
  it('never re-submits a failed image a moderator has yet to review', async () => {
    storeImages({ connected: [image(32, { ingestion: 'Error', needsReview: 'minor' })] });

    expect(await retry()).toEqual({ sent: 0, deferred: false, gone: 0 });
    expect(await requeued()).toEqual([]);
  });

  it('re-submits the same failed image once nothing awaits review', async () => {
    storeImages({ connected: [image(32, { ingestion: 'Error' })] });

    expect(await retry()).toEqual({ sent: 1, deferred: false, gone: 0 });
    expect(await requeued()).toEqual([32]);
  });

  it('re-submits only failed images: a scanned or blocked one is left as it is', async () => {
    storeImages({ connected: [CLEAN, BLOCK_REASON_ONLY, FAILED] });

    await retry();

    expect(await requeued()).toEqual([FAILED.id]);
  });

  it('leaves a missing image alone after the first round', async () => {
    storeImages({ connected: [FAILED, MISSING] });

    await retry({ includeNotFound: false });

    expect(await requeued()).toEqual([FAILED.id]);
  });

  // civitai/civitai#10722: an image with no file behind it never keeps an article hidden; a stored
  // one keeps blocking until it scans clean.
  describe('an Error image whose file is gone', () => {
    const GONE = image(33, { ingestion: 'Error' });
    const gone =
      (...ids: number[]) =>
      async () =>
        new Set(ids);

    // Kills: re-queueing every Error image.
    it('is set NotFound instead of being sent to scan again', async () => {
      storeImages({ connected: [GONE, FAILED] });

      expect(await retry({ absentImages: gone(GONE.id) })).toEqual({
        sent: 1,
        deferred: false,
        gone: 1,
      });
      expect(await written('NotFound')).toEqual([GONE.id]);
      expect(await requeued()).toEqual([FAILED.id]);
    });

    // Control. Kills: setting NotFound without a confirmed absence.
    it('stays Error and is sent again while its file may still be stored', async () => {
      storeImages({ connected: [GONE] });

      expect(await retry()).toEqual({ sent: 1, deferred: false, gone: 0 });
      expect(await written('NotFound')).toEqual([]);
      expect(await requeued()).toEqual([GONE.id]);
    });

    // Kills: probing an image under review, which would then leave the retry's hands.
    it('is never asked about while a moderator has yet to review it', async () => {
      const absentImages = vi.fn(async () => new Set<number>());
      storeImages({ connected: [image(34, { ingestion: 'Error', needsReview: 'minor' })] });

      await retry({ absentImages });

      expect(absentImages).toHaveBeenCalledWith([]);
      expect(await written('NotFound')).toEqual([]);
    });

    // Kills: an unconditional NotFound write over a block that landed after the read.
    it('stays as it is when it is blocked between the read and the write', async () => {
      landedAfterRead[GONE.id] = { blockedFor: 'tos' };
      storeImages({ connected: [GONE] });

      expect(await retry({ absentImages: gone(GONE.id) })).toMatchObject({ gone: 0 });
      expect(await written('NotFound')).toEqual([]);
    });

    // Kills: dropping the `ingestion: Error` guard, which would overwrite a scan that landed.
    it('keeps a scan result that landed between the read and the write', async () => {
      landedAfterRead[GONE.id] = { ingestion: 'Scanned' };
      storeImages({ connected: [GONE] });

      expect(await retry({ absentImages: gone(GONE.id) })).toMatchObject({ gone: 0 });
    });

    // Kills: probing a NotFound image again on the first round.
    it('asks only about Error images', async () => {
      const absentImages = vi.fn(async () => new Set<number>());
      storeImages({ connected: [FAILED, MISSING] });

      await retry({ absentImages });

      expect(absentImages).toHaveBeenCalledWith([expect.objectContaining({ id: FAILED.id })]);
    });
  });

  it('sends nothing when the images exceed what is left of the tick', async () => {
    storeImages({ connected: [FAILED, MISSING] });

    expect(await retry({ budget: 1, fullBudget: false })).toEqual({
      sent: 0,
      deferred: true,
      gone: 0,
    });
    expect(await requeued()).toEqual([]);
  });
});
