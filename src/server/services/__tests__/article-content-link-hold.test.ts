import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ImageService from '~/server/services/image.service';
import type * as RatingReview from '~/server/services/article-rating-review.helpers';
import { ReportEntity } from '~/shared/utils/report-helpers';

/**
 * A content url with no image row whose key's issuer cannot be read, or was someone else, gets no
 * row; the article is held off public until it settles. The hold table is the migration's own SQL
 * on PGlite, and the ingestion recompute is the real one, writing the article row there too.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const state = vi.hoisted(() => ({ clickhouseDown: false }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: async () => {
      if (state.clickhouseDown) throw new Error('clickhouse down');
      return [];
    },
  },
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/article-rating-review.helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof RatingReview>()),
  maybeAutoResolveDisputeAfterScan: async () => undefined,
}));
const createReport = vi.hoisted(() => vi.fn(async () => null));
vi.mock('~/server/services/report.service', () => ({ createReport }));

const {
  assertArticleContentUrlsUsable,
  keepOffPublicAfterLinkFailure,
  linkArticleContentImages,
  recomputeArticleIngestion,
} = await import('~/server/services/article.service');
const {
  recordUploadKeyOwner,
  ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE,
  MAX_KEYS,
  UNFINISHED_UPLOAD_MESSAGE,
  UNRECORDED_KEYS_ACCEPTED_UNTIL,
} = await import('~/server/services/image-url-ownership');
const { nextContentLinkHold, writeContentLinkHold } = await import(
  '~/server/services/article-content-link-hold'
);
const { settleContentLinkHolds, CONTENT_LINK_DEFERRAL_BACKSTOP_MS } = await import(
  '~/server/jobs/article-content-link-hold'
);

const ARTICLE_ID = 21;
const AUTHOR = 7;
const OTHER = 8;
const EDITOR = 99;
const KEY = '0a0b0c0d-0000-4000-8000-0000000000bb';
const KEY2 = '0a0b0c0d-0000-4000-8000-0000000000cc';
const img = (key: string) => `<img src="https://image.civitai.com/x/${key}/original=true/a.jpeg">`;
const CONTENT = `<p>${img(KEY)}</p>`;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// After unrecorded keys are refused on save.
const T0 = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() + DAY);
const at = (ms: number) => new Date(T0.getTime() + ms);

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20261214120000_article_content_link_hold/migration.sql'
  ),
  'utf8'
);

let db: PGlite;
let raw: ReturnType<typeof pgliteRaw>;
const redis = new Map<string, string>();
let textModeration: { status: string; blocked: boolean } | null;

const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

// Read and written as UTC, as Prisma does: PGlite would use the machine's time zone.
const HOLD_COLUMNS = `deferred, refused, "editorId", "deferredSince" AT TIME ZONE 'UTC' AS "deferredSince", "reportedAt" AT TIME ZONE 'UTC' AS "reportedAt"`;
const holdDelegate = {
  findUnique: async ({ where }: { where: { articleId: number } }) =>
    (
      await q(`SELECT ${HOLD_COLUMNS} FROM "ArticleContentLinkHold" WHERE "articleId" = $1`, [
        where.articleId,
      ])
    )[0] ?? null,
  findFirst: async () => (await q(`SELECT "articleId" FROM "ArticleContentLinkHold" LIMIT 1`))[0],
  findMany: async ({
    take,
    orderBy,
  }: {
    take: number;
    orderBy?: Record<string, 'asc' | 'desc'>;
  }) => {
    const [column, direction] = Object.entries(orderBy ?? { articleId: 'asc' })[0];
    return q(
      `SELECT "articleId" FROM "ArticleContentLinkHold" ORDER BY "${column}" ${direction}, "articleId" LIMIT $1`,
      [take]
    );
  },
  updateMany: async ({
    where,
    data,
  }: {
    where: { articleId: number };
    data: { checkedAt?: Date; reportedAt?: Date };
  }) => {
    const [column, value] = Object.entries(data)[0] ?? [];
    if (!column) return { count: 0 };
    await q(
      `UPDATE "ArticleContentLinkHold" SET "${column}" = ($1::timestamptz AT TIME ZONE 'UTC') WHERE "articleId" = $2`,
      [(value as Date).toISOString(), where.articleId]
    );
  },
};

/** The transaction client linking and the recompute use, on the same PGlite. */
const tx = {
  $executeRaw: (...a: Parameters<typeof raw.executeRaw>) => raw.executeRaw(...a),
  $queryRaw: (...a: Parameters<typeof raw.queryRaw>) => raw.queryRaw(...a),
  articleContentLinkHold: holdDelegate,
  image: {
    findMany: async ({ where }: { where: { url?: { in: string[] }; id?: unknown } }) =>
      where.url
        ? q(`SELECT id, url, ingestion FROM "Image" WHERE url = ANY($1)`, [where.url.in])
        : [],
    findUnique: async () => null,
    createManyAndReturn: async ({ data }: { data: { url: string; userId: number }[] }) => {
      const rows: { id: number; url: string }[] = [];
      for (const row of data)
        rows.push(
          ...(await q<{ id: number; url: string }>(
            `INSERT INTO "Image" (url, "userId") VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, url`,
            [row.url, row.userId]
          ))
        );
      return rows;
    },
  },
  imageConnection: {
    upsert: async ({ create }: { create: { imageId: number; entityId: number } }) =>
      q(
        `INSERT INTO "ImageConnection" ("imageId", "entityId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [create.imageId, create.entityId]
      ),
    findMany: async ({ where }: { where: { entityId: number; imageId?: { notIn: number[] } } }) =>
      where.imageId
        ? q(
            `SELECT "imageId" FROM "ImageConnection" WHERE "entityId" = $1 AND NOT ("imageId" = ANY($2))`,
            [where.entityId, where.imageId.notIn]
          )
        : (
            await q<{ ingestion: string }>(
              `SELECT i.ingestion FROM "ImageConnection" c JOIN "Image" i ON i.id = c."imageId" WHERE c."entityId" = $1`,
              [where.entityId]
            )
          ).map((r) => ({ image: r })),
    deleteMany: async ({ where }: { where: { entityId: number; imageId: { in: number[] } } }) =>
      q(`DELETE FROM "ImageConnection" WHERE "entityId" = $1 AND "imageId" = ANY($2)`, [
        where.entityId,
        where.imageId.in,
      ]),
  },
  article: {
    findUniqueOrThrow: async ({ where }: { where: { id: number } }) =>
      (
        await q(
          `SELECT ingestion, status, "publishedAt", "userId", title, content, "coverId", "moderatorNsfwLevel" FROM "Article" WHERE id = $1`,
          [where.id]
        )
      )[0],
  },
  entityModeration: { findUnique: async () => textModeration },
};

beforeAll(async () => {
  db = new PGlite();
  raw = pgliteRaw(db);
  // A zone away from UTC, so the hold's own UTC handling, not the machine's, keeps its times.
  await db.exec(`SET TIME ZONE 'America/Denver'`);
  await db.exec(`
    CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'Processing', 'UnpublishedViolation');
    CREATE TABLE "Article" (id int PRIMARY KEY, "userId" int NOT NULL, title text, content text,
      "coverId" int, status "ArticleStatus" NOT NULL DEFAULT 'Published', "publishedAt" timestamp(3),
      ingestion "ArticleIngestionStatus" NOT NULL DEFAULT 'Scanned', "contentScannedAt" timestamp(3),
      "moderatorNsfwLevel" int);
    CREATE TABLE "Image" (id serial PRIMARY KEY, url text NOT NULL UNIQUE, "userId" int NOT NULL,
      ingestion text NOT NULL DEFAULT 'Pending');
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, PRIMARY KEY ("imageId", "entityId"));
  `);
  await db.exec(MIGRATION);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "Article", "Image", "ImageConnection", "ArticleContentLinkHold"`);
  await givenArticle();
  redis.clear();
  textModeration = { status: 'Succeeded', blocked: false };
  state.clickhouseDown = false;
  createReport.mockClear();
  redisMock.sysRedis.set.mockImplementation((async (k: string, v: string) => {
    redis.set(k, v);
    return 'OK';
  }) as never);
  lookupsUp();
  dbMock.dbWrite.image.findMany.mockImplementation(tx.image.findMany as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(tx.$queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(tx.$executeRaw as never);
  (dbMock.dbWrite as unknown as Record<string, unknown>).articleContentLinkHold = holdDelegate;
  dbMock.dbWrite.article.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (
        await q(`SELECT "userId", content, "coverId", status FROM "Article" WHERE id = $1`, [
          where.id,
        ])
      )[0] ?? null) as never
  );
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (t: unknown) => unknown) =>
    cb(tx)) as never);
});

async function givenArticle(
  over: { content?: string; status?: string; moderatorNsfwLevel?: number } = {}
) {
  await q(`DELETE FROM "Article" WHERE id = $1`, [ARTICLE_ID]);
  await q(
    `INSERT INTO "Article" (id, "userId", title, content, status, "moderatorNsfwLevel", "publishedAt")
     VALUES ($1, $2, 'A title', $3, $4, $5, now())`,
    [
      ARTICLE_ID,
      AUTHOR,
      over.content ?? CONTENT,
      over.status ?? 'Published',
      over.moderatorNsfwLevel ?? null,
    ]
  );
}
function lookupsDown() {
  redisMock.sysRedis.mGet.mockRejectedValue(new Error('redis down'));
  state.clickhouseDown = true;
}
function lookupsUp() {
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
  state.clickhouseDown = false;
}
const link = (
  over: { content?: string; userId?: number; now?: Date; cleanupOnly?: boolean } = {}
) =>
  linkArticleContentImages({
    articleId: ARTICLE_ID,
    content: over.content ?? CONTENT,
    userId: over.userId ?? AUTHOR,
    ownerId: AUTHOR,
    now: over.now ?? T0,
    cleanupOnly: over.cleanupOnly,
  });
const hold = async () =>
  (await holdDelegate.findUnique({ where: { articleId: ARTICLE_ID } })) as {
    deferred: string[];
    refused: string[];
    deferredSince: Date | null;
  } | null;
const rows = () =>
  q<{ url: string }>(`SELECT url FROM "Image" ORDER BY url`).then((r) => r.map((x) => x.url));
const ingestion = async () =>
  (await q<{ ingestion: string }>(`SELECT ingestion FROM "Article" WHERE id = $1`, [ARTICLE_ID]))[0]
    .ingestion;

describe('linking a url whose key cannot be proved', () => {
  it('with both lookups down, creates no row, defers the url and holds the article', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    lookupsDown();
    await link();
    expect(await rows()).toEqual([]);
    expect((await hold())?.deferred).toEqual([KEY]);
    expect(await ingestion()).toBe('Pending');
  });

  it('with the request log alone down, defers a key the issue record does not hold', async () => {
    state.clickhouseDown = true;
    await link();
    expect(await rows()).toEqual([]);
    expect((await hold())?.deferred).toEqual([KEY]);
  });

  it('with the issue record alone down, defers a key the request log does not hold', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    redisMock.sysRedis.mGet.mockRejectedValue(new Error('redis down'));
    await link();
    expect(await rows()).toEqual([]);
    expect((await hold())?.deferred).toEqual([KEY]);
  });

  it('with the lookups up, refuses a key issued to another user and blocks the article', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    await link();
    expect(await rows()).toEqual([]);
    expect((await hold())?.refused).toEqual([KEY]);
    expect(await ingestion()).toBe('Blocked');
  });

  it("links the owner's key and holds nothing", async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    await link();
    expect(await rows()).toEqual([KEY]);
    expect(await hold()).toBeNull();
  });

  it('keeps a deferred article off public over a moderator rating', async () => {
    await givenArticle({ moderatorNsfwLevel: 1 });
    lookupsDown();
    await link();
    expect(await ingestion()).toBe('Pending');
  });

  it('touches no hold when only cleaning up', async () => {
    lookupsDown();
    await link();
    lookupsUp();
    await recordUploadKeyOwner(KEY, AUTHOR);
    await link({ cleanupOnly: true });
    expect((await hold())?.deferred).toEqual([KEY]);
  });

  it('writes no hold for content the article no longer holds', async () => {
    const wrote = await writeContentLinkHold(tx as never, {
      articleId: ARTICLE_ID,
      content: '<p>older content</p>',
      hold: { deferred: [KEY], refused: [], editorId: AUTHOR, deferredSince: T0, reportedAt: null },
    });
    expect(wrote).toBe(false);
    expect(await hold()).toBeNull();
  });
});

describe('saving content whose stored url cannot be proved', () => {
  const save = () =>
    assertArticleContentUrlsUsable({
      content: CONTENT,
      storedContent: CONTENT,
      userId: AUTHOR,
      ownerId: AUTHOR,
    }).then(
      () => 'accepted',
      (e: Error) =>
        e.message === ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE ? 'refused' : e.message
    );

  it('goes through while the hold can be written, and is refused when it cannot', async () => {
    lookupsDown();
    expect(await save()).toBe('accepted');
    const findFirst = holdDelegate.findFirst;
    holdDelegate.findFirst = async () => {
      throw new Error('relation "ArticleContentLinkHold" does not exist');
    };
    try {
      expect(await save()).toBe('refused');
      lookupsUp();
      expect(await save()).toBe('refused');
    } finally {
      holdDelegate.findFirst = findFirst;
    }
  });

  it("goes through with the lookups up and the hold readable for the owner's key", async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    expect(await save()).toBe('accepted');
  });
});

describe('settling a held article', () => {
  beforeEach(async () => {
    lookupsDown();
    await link();
    lookupsUp();
  });

  it('links the url once the owner is proved, and the article follows its images again', async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await rows()).toEqual([KEY]);
    expect(await hold()).toBeNull();
    // The new row is unscanned, so the article waits for it, then follows its scan.
    expect(await ingestion()).toBe('Pending');
    await q(`UPDATE "Image" SET ingestion = 'Scanned'`);
    await recomputeArticleIngestion(ARTICLE_ID);
    expect(await ingestion()).toBe('Scanned');
  });

  it('returns to what the article was for other reasons, not to public', async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    textModeration = { status: 'Succeeded', blocked: true };
    await recomputeArticleIngestion(ARTICLE_ID);
    expect(await ingestion()).toBe('Blocked');
    await settleContentLinkHolds(at(10 * MINUTE));
    await q(`UPDATE "Image" SET ingestion = 'Scanned'`);
    await recomputeArticleIngestion(ARTICLE_ID);
    expect(await hold()).toBeNull();
    expect(await ingestion()).toBe('Blocked');
  });

  it('keeps the article blocked when the key turns out to be issued to another user', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await rows()).toEqual([]);
    expect((await hold())?.refused).toEqual([KEY]);
    expect(await ingestion()).toBe('Blocked');
  });

  it('settles a url saved by an editor against the editor', async () => {
    await q(`TRUNCATE "ArticleContentLinkHold"`);
    lookupsDown();
    await link({ userId: EDITOR });
    lookupsUp();
    await recordUploadKeyOwner(KEY, EDITOR);
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await rows()).toEqual([KEY]);
    expect(await hold()).toBeNull();
  });

  it('settles against the content as it is now, not as it was held', async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    await q(`UPDATE "Article" SET content = $1`, ['<p>the image was removed</p>']);
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await rows()).toEqual([]);
    expect(await hold()).toBeNull();
  });

  it('keeps the rest deferred, and its start, when one of two urls settles', async () => {
    const both = `<p>${img(KEY)}${img(KEY2)}</p>`;
    await givenArticle({ content: both });
    lookupsDown();
    await link({ content: both });
    lookupsUp();
    await recordUploadKeyOwner(KEY, AUTHOR);
    state.clickhouseDown = true;
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await rows()).toEqual([KEY]);
    const left = await hold();
    expect(left?.deferred).toEqual([KEY2]);
    expect(left?.deferredSince?.getTime()).toBe(T0.getTime());
  });

  it('leaves the url deferred while the lookups are still down', async () => {
    lookupsDown();
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await rows()).toEqual([]);
    expect((await hold())?.deferred).toEqual([KEY]);
  });
});

describe('a deferral that does not settle', () => {
  beforeEach(async () => {
    lookupsDown();
    await link();
  });

  it('files one moderator report once it is older than the backstop, across many retries', async () => {
    for (let t = 10 * MINUTE; t < CONTENT_LINK_DEFERRAL_BACKSTOP_MS; t += 4 * 60 * MINUTE)
      await settleContentLinkHolds(at(t));
    expect(createReport).not.toHaveBeenCalled();
    await settleContentLinkHolds(at(CONTENT_LINK_DEFERRAL_BACKSTOP_MS + MINUTE));
    await settleContentLinkHolds(at(CONTENT_LINK_DEFERRAL_BACKSTOP_MS + 11 * MINUTE));
    expect(createReport).toHaveBeenCalledOnce();
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ARTICLE_ID,
        type: ReportEntity.Article,
        reason: 'AdminAttention',
        foldIntoPendingOnly: true,
      })
    );
  });

  it('files no report for an article nobody else can see', async () => {
    await q(`UPDATE "Article" SET status = 'Draft'`);
    await settleContentLinkHolds(at(CONTENT_LINK_DEFERRAL_BACKSTOP_MS + MINUTE));
    expect(createReport).not.toHaveBeenCalled();
  });
});

describe('the settle job', () => {
  it('goes on to the next article when one fails, and moves the failed one to the back', async () => {
    lookupsDown();
    await link();
    const OTHER_ARTICLE = 23;
    await q(`INSERT INTO "Article" (id, "userId", content) VALUES ($1, $2, $3)`, [
      OTHER_ARTICLE,
      AUTHOR,
      CONTENT,
    ]);
    await q(
      `INSERT INTO "ArticleContentLinkHold" ("articleId", deferred, "editorId", "checkedAt") VALUES ($1, $2, $3, '2000-01-01')`,
      [OTHER_ARTICLE, [KEY], AUTHOR]
    );
    const findUnique = dbMock.dbWrite.article.findUnique.getMockImplementation()!;
    dbMock.dbWrite.article.findUnique.mockImplementation((async (args: {
      where: { id: number };
    }) => {
      if (args.where.id === OTHER_ARTICLE) throw new Error('unreadable');
      return findUnique(args as never);
    }) as never);
    lookupsUp();
    await recordUploadKeyOwner(KEY, AUTHOR);
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await hold()).toBeNull();
    const [failed] = await q<{ checkedAt: Date }>(
      `SELECT "checkedAt" AT TIME ZONE 'UTC' AS "checkedAt" FROM "ArticleContentLinkHold" WHERE "articleId" = $1`,
      [OTHER_ARTICLE]
    );
    expect(failed.checkedAt.getTime()).toBe(at(10 * MINUTE).getTime());
  });
});

describe('an image whose upload did not finish', () => {
  // The editor's url for a file still in the browser; its id is not an upload key.
  const BLOB = `blob:https://civitai.red/${KEY}`;
  const content = `<p><edge-media url="${BLOB}" type="image"></edge-media>${img(KEY2)}</p>`;

  it('refuses the save with a message to add it again, new or already stored', async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    for (const storedContent of [CONTENT, content]) {
      const save = assertArticleContentUrlsUsable({
        content,
        storedContent,
        userId: AUTHOR,
        ownerId: AUTHOR,
      });
      await expect(save).rejects.toThrow(UNFINISHED_UPLOAD_MESSAGE);
    }
  });

  it('gets no image row when stored content is linked, and holds nothing', async () => {
    await recordUploadKeyOwner(KEY2, AUTHOR);
    await givenArticle({ content });
    await link({ content });
    expect(await rows()).toEqual([KEY2]);
    expect(await hold()).toBeNull();
  });
});

describe('classifying many urls', () => {
  it('checks every url of an article longer than one lookup takes', async () => {
    const keys = Array.from(
      { length: 17 },
      (_, i) => `0a0b0c0d-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    for (const key of keys) await recordUploadKeyOwner(key, OTHER);
    const content = `<p>${keys.map(img).join('')}</p>`;
    await givenArticle({ content });
    await link({ content });
    expect((await hold())?.refused.sort()).toEqual([...keys].sort());
  });

  it('refuses a media url naming more keys than one lookup reads', async () => {
    const keys = Array.from(
      { length: MAX_KEYS + 1 },
      (_, i) => `0a0b0c0d-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    for (const key of keys) await recordUploadKeyOwner(key, AUTHOR);
    const url = keys.join(' ');
    const content = `<edge-media url="${url}"></edge-media>`;
    await givenArticle({ content });
    await link({ content });
    expect(await rows()).toEqual([]);
    expect((await hold())?.refused).toEqual([url]);
  });
});

describe('the hold write', () => {
  it('clears no hold for content the article no longer holds', async () => {
    lookupsDown();
    await link();
    const cleared = await writeContentLinkHold(tx as never, {
      articleId: ARTICLE_ID,
      content: '<p>older content</p>',
      hold: null,
    });
    expect(cleared).toBe(false);
    expect((await hold())?.deferred).toEqual([KEY]);
  });

  it('holds the content a later save wrote when it lost the race to it', async () => {
    const later = `<p>a later save</p>${CONTENT}`;
    await givenArticle({ content: later });
    lookupsDown();
    await link({ content: CONTENT });
    expect((await hold())?.deferred).toEqual([KEY]);
    expect(await ingestion()).toBe('Pending');
  });

  it('keeps a report time only while the same deferral lasts', () => {
    const previous = {
      deferred: [KEY],
      refused: [],
      editorId: AUTHOR,
      deferredSince: T0,
      reportedAt: at(MINUTE),
    };
    const next = (p: typeof previous | null, deferred: string[]) =>
      nextContentLinkHold(p, { deferred, refused: [KEY2], editorId: AUTHOR }, at(2 * MINUTE));
    expect(next(previous, [KEY])?.reportedAt).toEqual(at(MINUTE));
    expect(next(previous, [])?.reportedAt).toBeNull();
    expect(next({ ...previous, deferred: [] }, [KEY])?.reportedAt).toBeNull();
  });
});

describe('a deferred url still unrecorded once the lookups are back', () => {
  beforeEach(async () => {
    lookupsDown();
    await link();
    lookupsUp();
  });

  it('is refused once unrecorded keys are refused on save', async () => {
    await settleContentLinkHolds(at(10 * MINUTE));
    expect(await rows()).toEqual([]);
    expect((await hold())?.refused).toEqual([KEY]);
  });

  it('links before that', async () => {
    await settleContentLinkHolds(new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() - MINUTE));
    expect(await rows()).toEqual([KEY]);
    expect(await hold()).toBeNull();
  });
});

describe('a failed link', () => {
  it('takes the article off public and keeps it there until its urls settle', async () => {
    await keepOffPublicAfterLinkFailure({
      articleId: ARTICLE_ID,
      content: CONTENT,
      editorId: AUTHOR,
      ingestion: 'Rescan' as never,
      now: T0,
    });
    expect(await ingestion()).toBe('Rescan');
    expect((await hold())?.deferred).toEqual([KEY]);
    // A later recompute, from a webhook or the reconcile job, does not make it public again.
    await recomputeArticleIngestion(ARTICLE_ID);
    expect(await ingestion()).toBe('Pending');
  });

  const fail = (now: Date) =>
    keepOffPublicAfterLinkFailure({
      articleId: ARTICLE_ID,
      content: CONTENT,
      editorId: AUTHOR,
      ingestion: 'Rescan' as never,
      now,
    });

  it('reports at the backstop from the first failure, however often it fails again', async () => {
    lookupsDown();
    await fail(T0);
    await fail(at(23 * 60 * MINUTE));
    await settleContentLinkHolds(at(CONTENT_LINK_DEFERRAL_BACKSTOP_MS + MINUTE));
    expect(createReport).toHaveBeenCalledOnce();
  });

  it('keeps a refused url refused', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    await link();
    await fail(at(MINUTE));
    expect(await hold()).toMatchObject({ refused: [KEY], deferred: [] });
  });
});

describe('a refused url still unrecorded', () => {
  it('stays refused on every later pass, not only the first', async () => {
    lookupsDown();
    await link();
    lookupsUp();
    await settleContentLinkHolds(at(10 * MINUTE));
    await settleContentLinkHolds(at(20 * MINUTE));
    await link({ now: at(30 * MINUTE) });
    expect(await rows()).toEqual([]);
    expect((await hold())?.refused).toEqual([KEY]);
  });
});
