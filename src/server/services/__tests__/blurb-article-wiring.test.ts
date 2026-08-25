import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import type * as TextModerationService from '~/server/services/text-moderation.service';

// The ordering contract of the article save path: expand -> persist -> moderate -> reconcile.
// These assertions run against the real `upsertArticle` / `applyArticleContentChange`, so
// dropping either blurb call fails them. article.service.ts has a large import graph; only
// the Redis-backed post-commit helpers are stubbed, because with no live Redis those awaits
// never settle and the tests hang.
// Hoisted: article.service imports every module mocked below, so these factories run while
// the test file's own imports are still resolving — before a plain module-scope `const`
// exists.
const {
  expandBlurbs,
  reconcileBlurbReferences,
  submitTextModeration,
  preventReplicationLag,
  refreshUserArticleCount,
} = vi.hoisted(() => ({
  expandBlurbs: vi.fn(),
  reconcileBlurbReferences: vi.fn(),
  submitTextModeration: vi.fn(),
  preventReplicationLag: vi.fn(async () => {}),
  refreshUserArticleCount: vi.fn(async () => {}),
}));

vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs,
  reconcileBlurbReferences,
}));
vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userArticleCountCache: { ...actual.userArticleCountCache, refresh: refreshUserArticleCount },
  };
});

import { applyArticleContentChange, upsertArticle } from '~/server/services/article.service';

const ARTICLE_ID = 21;
const CREATED_ID = 99;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

const CLIENT_HTML = '<span data-type="blurb" data-id="7">ATTACKER SUPPLIED</span>';
const EXPANDED_HTML = '<span data-type="blurb" data-id="7">REAL</span>';
const USES = [{ blurbId: 7, contentHash: 'h7' }];

const storedArticle = {
  id: ARTICLE_ID,
  title: 'Stored title',
  cover: null,
  coverId: null,
  userId: OWNER_ID,
  publishedAt: null,
  status: 'Draft',
  nsfwLevel: 1,
  userNsfwLevel: 1,
  moderatorNsfwLevel: null,
  lockedProperties: [],
  metadata: {},
  content: 'stored content',
};

const upsert = (input: Record<string, unknown> = {}) =>
  upsertArticle({
    id: ARTICLE_ID,
    userId: OWNER_ID,
    title: 'A title',
    content: CLIENT_HTML,
    status: 'Draft',
    ...input,
  } as never);

/** Every `article.update` whose payload carries the content column. */
function contentWrites() {
  return dbMock.dbWrite.article.update.mock.calls
    .map(([arg]) => arg.data)
    .filter((data: Record<string, unknown>) => 'content' in data);
}

beforeEach(() => {
  vi.clearAllMocks();
  expandBlurbs.mockResolvedValue({ html: EXPANDED_HTML, uses: USES });
  reconcileBlurbReferences.mockResolvedValue(undefined);
  submitTextModeration.mockResolvedValue(undefined);
  dbMock.dbWrite.article.findUnique.mockResolvedValue(storedArticle);
  dbMock.dbRead.article.findUnique.mockResolvedValue(storedArticle);
  dbMock.dbWrite.article.update.mockResolvedValue({
    id: ARTICLE_ID,
    userId: OWNER_ID,
    publishedAt: null,
  });
  dbMock.dbWrite.article.create.mockResolvedValue({
    id: CREATED_ID,
    userId: OWNER_ID,
    coverId: null,
    content: EXPANDED_HTML,
  });
});

describe('upsertArticle — blurb expansion', () => {
  it('stores what the blurb says, not the html the client sent', async () => {
    await upsert();

    expect(expandBlurbs).toHaveBeenCalledWith({ userId: OWNER_ID, html: CLIENT_HTML });

    const writes = contentWrites();
    expect(writes.length).toBeGreaterThan(0);
    for (const data of writes) {
      expect(data.content).toBe(EXPANDED_HTML);
      expect(data.content).not.toContain('ATTACKER SUPPLIED');
    }
  });

  it('expands against the owner, not the moderator doing the saving', async () => {
    await upsert({ userId: MODERATOR_ID, isModerator: true });

    // A moderator's own blurb set resolves none of the owner's `data-id`s, and every span
    // would be unwrapped to plain text — a silent, permanent loss of the article's blurbs.
    expect(expandBlurbs).toHaveBeenCalledWith({ userId: OWNER_ID, html: CLIENT_HTML });
  });

  it('stores the expanded html on a create too', async () => {
    await upsert({ id: undefined });

    expect(dbMock.dbWrite.article.create.mock.calls[0][0].data.content).toBe(EXPANDED_HTML);
  });
});

describe('upsertArticle — blurb reconciliation', () => {
  it('reconciles after the write and after the moderation submit, against the article id', async () => {
    await upsert();

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'Article',
      entityId: ARTICLE_ID,
      uses: USES,
    });

    const write = Math.min(...dbMock.dbWrite.article.update.mock.invocationCallOrder);
    const [submit] = submitTextModeration.mock.invocationCallOrder;
    const [reconcile] = reconcileBlurbReferences.mock.invocationCallOrder;

    expect(submit).toBeGreaterThan(write);
    expect(reconcile).toBeGreaterThan(submit);
  });

  it('reconciles a new article against the id it was created with', async () => {
    await upsert({ id: undefined });

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'Article',
      entityId: CREATED_ID,
      uses: USES,
    });

    const [create] = dbMock.dbWrite.article.create.mock.invocationCallOrder;
    const [reconcile] = reconcileBlurbReferences.mock.invocationCallOrder;
    expect(reconcile).toBeGreaterThan(create);
  });
});

describe('applyArticleContentChange', () => {
  beforeEach(() => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      title: 'Stored title',
      content: 'stored content',
      coverId: null,
    });
  });

  it('writes the content column and nothing else', async () => {
    await applyArticleContentChange({ id: ARTICLE_ID, userId: OWNER_ID, content: EXPANDED_HTML });

    // The fan-out calls this with nothing but new HTML. Route it back through the
    // form-shaped upsert and the failure mode is silent field loss — title, tags,
    // attachments and cover cleared on every entity the job touches.
    const [firstWrite] = dbMock.dbWrite.article.update.mock.calls[0];
    expect(Object.keys(firstWrite.data)).toEqual(['content']);
    expect(firstWrite.where).toEqual({ id: ARTICLE_ID });
  });

  it('runs the follow-up work a content change implies', async () => {
    await applyArticleContentChange({ id: ARTICLE_ID, userId: OWNER_ID, content: EXPANDED_HTML });

    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Article', entityId: ARTICLE_ID })
    );
  });
});
