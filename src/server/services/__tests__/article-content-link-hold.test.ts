import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { ReportEntity } from '~/shared/utils/report-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as RatingReview from '~/server/services/article-rating-review.helpers';

/**
 * A content url with no image row whose key's issuer cannot be read, or was someone else, gets no
 * row; the article is held off public until it settles, through the real ingestion recompute.
 */

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

const { linkArticleContentImages } = await import('~/server/services/article.service');
const { recordUploadKeyOwner } = await import('~/server/services/image-url-ownership');
const { settleContentLinkHolds, CONTENT_LINK_DEFERRAL_BACKSTOP_MS } = await import(
  '~/server/jobs/article-content-link-hold'
);

const ARTICLE_ID = 21;
const AUTHOR = 7;
const OTHER = 8;
const KEY = '0a0b0c0d-0000-4000-8000-0000000000bb';
const content = `<p><img src="https://image.civitai.com/x/${KEY}/original=true/a.jpeg"></p>`;

const redis = new Map<string, string>();
let metadata: Record<string, unknown> = {};
let textModeration: { status: string; blocked: boolean } | null;
let ingestionWrites: string[] = [];
const createManyAndReturn = vi.fn(async ({ data }: { data: { url: string }[] }) =>
  data.map((row, i) => ({ id: i + 1, url: row.url }))
);

const tx = {
  $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // The recompute's write: `SET ${fragments}` with the derived ingestion first.
    if (strings.join('').includes('UPDATE "Article"'))
      ingestionWrites.push((values[0] as { values: string[] }).values[0]);
    return 1;
  }),
  image: { findMany: async () => [], createManyAndReturn, findUnique: async () => null },
  imageConnection: { upsert: vi.fn(), findMany: async () => [], deleteMany: vi.fn() },
  article: {
    findUniqueOrThrow: async () => ({
      ingestion: 'Scanned',
      status: 'Published',
      publishedAt: new Date(),
      userId: AUTHOR,
      title: 'A title',
      content,
      coverId: null,
      moderatorNsfwLevel: null,
      metadata,
    }),
  },
  entityModeration: { findUnique: async () => textModeration },
};

beforeEach(() => {
  redis.clear();
  metadata = {};
  textModeration = { status: 'Succeeded', blocked: false };
  ingestionWrites = [];
  state.clickhouseDown = false;
  createManyAndReturn.mockClear();
  createReport.mockClear();
  redisMock.sysRedis.set.mockImplementation((async (k: string, v: string) => {
    redis.set(k, v);
    return 'OK';
  }) as never);
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.article.findUnique.mockImplementation((async () => ({ metadata })) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join('').includes("metadata ? 'contentLinkHold'")
        ? [{ id: ARTICLE_ID, userId: AUTHOR, content, coverId: null }]
        : []
    )) as never);
  // The hold's own writes, applied to `metadata`.
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('');
    if (sql.includes("- 'contentLinkHold'")) {
      const { contentLinkHold: _, ...rest } = metadata;
      metadata = { ...rest, ...JSON.parse(values[0] as string) };
    } else if (sql.includes('{contentLinkHold,reportedAt}')) {
      metadata = {
        ...metadata,
        contentLinkHold: { ...(metadata.contentLinkHold as object), reportedAt: values[0] },
      };
    }
    return 1;
  }) as never);
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (t: unknown) => unknown) =>
    cb(tx)) as never);
});

const lookupsDown = () => {
  redisMock.sysRedis.mGet.mockRejectedValue(new Error('redis down'));
  state.clickhouseDown = true;
};
const lookupsUp = () => {
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
  state.clickhouseDown = false;
};
const link = () =>
  linkArticleContentImages({ articleId: ARTICLE_ID, content, userId: AUTHOR, ownerId: AUTHOR });
const hold = () =>
  metadata.contentLinkHold as { deferred: string[]; refused: string[] } | undefined;
const created = () =>
  createManyAndReturn.mock.calls.flatMap(([{ data }]) => data.map((r) => r.url));

describe('linking content whose key cannot be proved', () => {
  it('with both lookups down, creates no row, queues the url and holds the article', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    lookupsDown();
    await link();
    expect(created()).toEqual([]);
    expect(hold()?.deferred).toEqual([KEY]);
    expect(ingestionWrites).toEqual(['Pending']);
  });

  it('with the request log alone down, defers a key the issue record does not hold', async () => {
    state.clickhouseDown = true;
    await link();
    expect(created()).toEqual([]);
    expect(hold()?.deferred).toEqual([KEY]);
  });

  it('with the lookups up, refuses a key issued to another user and keeps the article held', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    await link();
    expect(created()).toEqual([]);
    expect(hold()?.refused).toEqual([KEY]);
    expect(ingestionWrites).toEqual(['Blocked']);
  });

  it('links a key issued to the author with no hold', async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    await link();
    expect(created()).toEqual([KEY]);
    expect(hold()).toBeUndefined();
    expect(ingestionWrites).toEqual([]);
  });
});

describe('settling a held article', () => {
  beforeEach(async () => {
    lookupsDown();
    await link();
    ingestionWrites = [];
    lookupsUp();
  });

  it('links the url and restores the article once the author is proved', async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    await settleContentLinkHolds();
    expect(created()).toEqual([KEY]);
    expect(hold()).toBeUndefined();
    expect(ingestionWrites).toEqual(['Scanned']);
  });

  it('restores what the article was for other reasons, not public', async () => {
    await recordUploadKeyOwner(KEY, AUTHOR);
    textModeration = { status: 'Pending', blocked: false };
    await settleContentLinkHolds();
    textModeration = { status: 'Succeeded', blocked: true };
    metadata = { contentLinkHold: { deferred: [KEY], refused: [] } };
    await settleContentLinkHolds();
    expect(ingestionWrites).toEqual(['Pending', 'Blocked']);
  });

  it('keeps the article held when the key turns out to be issued to another user', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    await settleContentLinkHolds();
    expect(created()).toEqual([]);
    expect(hold()?.refused).toEqual([KEY]);
    expect(ingestionWrites).toEqual(['Blocked']);
  });

  it('settles a url saved by an editor against the editor, not only the author', async () => {
    const EDITOR = 99;
    lookupsDown();
    metadata = {};
    await linkArticleContentImages({
      articleId: ARTICLE_ID,
      content,
      userId: EDITOR,
      ownerId: AUTHOR,
    });
    lookupsUp();
    await recordUploadKeyOwner(KEY, EDITOR);
    await settleContentLinkHolds();
    expect(created()).toEqual([KEY]);
    expect(hold()).toBeUndefined();
  });

  it('leaves the url queued while the lookups are still down', async () => {
    lookupsDown();
    await settleContentLinkHolds();
    expect(created()).toEqual([]);
    expect(hold()?.deferred).toEqual([KEY]);
  });
});

describe('a deferral that does not settle', () => {
  beforeEach(async () => {
    lookupsDown();
    await link();
  });

  it('files one moderator report once it is older than the backstop, and only one', async () => {
    const later = new Date(Date.now() + CONTENT_LINK_DEFERRAL_BACKSTOP_MS + 60_000);
    await settleContentLinkHolds(new Date(Date.now() + 60_000));
    expect(createReport).not.toHaveBeenCalled();
    await settleContentLinkHolds(later);
    await settleContentLinkHolds(later);
    expect(createReport).toHaveBeenCalledOnce();
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ARTICLE_ID,
        type: ReportEntity.Article,
        reason: 'AdminAttention',
      })
    );
  });
});
