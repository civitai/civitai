import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
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
  getReferencedBlurbIds,
  reconcileBlurbReferences,
  submitTextModeration,
  preventReplicationLag,
  refreshUserArticleCount,
  throwOnBlockedLinkDomain,
} = vi.hoisted(() => ({
  expandBlurbs: vi.fn(),
  getReferencedBlurbIds: vi.fn(),
  reconcileBlurbReferences: vi.fn(),
  submitTextModeration: vi.fn(),
  preventReplicationLag: vi.fn(async () => {}),
  refreshUserArticleCount: vi.fn(async () => {}),
  throwOnBlockedLinkDomain: vi.fn(),
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain,
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs,
  getReferencedBlurbIds,
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
const BLOCKED_HTML =
  '<span data-type="blurb" data-id="7"><a href="https://blocked.example">x</a></span>';
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

/**
 * The `$executeRaw` templates that write the content column, joined back into readable SQL.
 * `updateArticleImageScanStatus` issues raw statements of its own, so a bare call count
 * over `$executeRaw` measures the wrong thing.
 */
function contentSql() {
  return dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings]) => (strings as string[]).join('?'))
    .filter((sql) => /UPDATE "Article"\s+SET content =/.test(sql));
}

beforeEach(() => {
  vi.clearAllMocks();
  expandBlurbs.mockResolvedValue({ evaluated: true, html: EXPANDED_HTML, uses: USES });
  getReferencedBlurbIds.mockResolvedValue([7]);
  throwOnBlockedLinkDomain.mockResolvedValue(undefined);
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
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER_ID, html: CLIENT_HTML })
    );
  });

  it('rejects a blocked domain that arrived inside the blurb body', async () => {
    // The client html is clean; the blurb the server splices in is not. The guard at the
    // top of `upsertArticle` ran before the splice, so only a re-check of the EXPANDED
    // html can see this.
    expandBlurbs.mockResolvedValue({ evaluated: true, html: BLOCKED_HTML, uses: USES });
    throwOnBlockedLinkDomain.mockImplementation(async (html: string) => {
      if (html.includes('blocked.example')) throw new Error('invalid urls: blocked.example');
    });

    await expect(upsert()).rejects.toThrow('invalid urls');

    expect(throwOnBlockedLinkDomain).toHaveBeenCalledWith(BLOCKED_HTML);
    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
  });

  it('resolves only the blurbs the article already references when a moderator saves', async () => {
    getReferencedBlurbIds.mockResolvedValue([7]);

    await upsert({ userId: MODERATOR_ID, isModerator: true });

    // Without this a moderator could splice in guessed `data-id`s across a range and read
    // the owner's whole blurb library back out of the mutation response.
    expect(getReferencedBlurbIds).toHaveBeenCalledWith({
      entityType: 'Article',
      entityId: ARTICLE_ID,
    });
    expect(expandBlurbs).toHaveBeenCalledWith(expect.objectContaining({ restrictToBlurbIds: [7] }));
  });

  it('leaves the owner unrestricted', async () => {
    await upsert();

    expect(getReferencedBlurbIds).not.toHaveBeenCalled();
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToBlurbIds: undefined })
    );
  });

  it('links content images on a content-changing save', async () => {
    await upsert({ scanContent: true });

    // The observable that makes the `context` contract enforceable: drop the caller's
    // pre-write snapshot and `hasContentChanged` computes false, so this never fires.
    const rescans = dbMock.dbWrite.article.update.mock.calls
      .map(([arg]) => arg.data)
      .filter((data: Record<string, unknown>) => 'scanRequestedAt' in data);
    expect(rescans).toHaveLength(1);
    expect(rescans[0].ingestion).toBe('Rescan');
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

  it('runs the moved follow-up block exactly once per save', async () => {
    await upsert();

    // Re-inline the block into `upsertArticle` and leave the extracted copy in place and
    // every other assertion here still passes — a duplicated block just does the work
    // twice. Drift between the interactive path and the fan-out path is the failure this
    // extraction exists to prevent, and this count is the only thing that sees it.
    expect(preventReplicationLag).toHaveBeenCalledTimes(2);

    // And does not replay the column write the transaction already committed — a second
    // save landing in between would be silently reinstated as the older body.
    expect(contentSql()).toEqual([]);
  });

  it('leaves an existing reference row alone when the flag is off for the owner', async () => {
    // The regression this exists for: `expandBlurbs` used to report `uses: []` with the flag
    // off, the call site handed that straight to reconcile, and reconcile deleted EVERY
    // reference row for the article. A creator who fell out of the rollout lost their blurbs
    // on their next save, and the fan-out — deliberately ungated so it can still maintain
    // them — then had nothing left to maintain.
    expandBlurbs.mockResolvedValue({ evaluated: false, html: CLIENT_HTML });

    await upsert();

    expect(reconcileBlurbReferences).not.toHaveBeenCalled();
    // And the save still happens — the gate skips reconciliation, not the article.
    expect(dbMock.dbWrite.article.update).toHaveBeenCalled();
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
    const [sql, ...extra] = contentSql();
    expect(extra).toEqual([]);
    expect(sql).toMatch(/WHERE id =/);
    expect(sql).not.toMatch(/title|coverId|tags|userNsfwLevel|status/);
  });

  it('writes content through raw SQL so a re-materialization does not bump updatedAt', async () => {
    await applyArticleContentChange({ id: ARTICLE_ID, userId: OWNER_ID, content: EXPANDED_HTML });

    // Prisma's @updatedAt would reorder the Recently Updated feed and reopen the
    // rating-dispute re-edit window on every blurb edit the owner makes.
    expect(contentSql()).toHaveLength(1);
    expect(contentWrites()).toEqual([]);
  });

  it('issues no Prisma update at all on a fan-out rewrite', async () => {
    await applyArticleContentChange({ id: ARTICLE_ID, userId: OWNER_ID, content: EXPANDED_HTML });

    // Any `article.update` on this path re-stamps `@updatedAt` and undoes the raw write above.
    // The raw-SQL assertion cannot see one whose payload omits `content` — which is how the
    // `Rescan` stamp bumped every referencing article on every blurb edit.
    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
  });

  it('rejects a blocked link domain before writing anything', async () => {
    throwOnBlockedLinkDomain.mockRejectedValue(new Error('invalid urls: blocked.example'));

    await expect(
      applyArticleContentChange({ id: ARTICLE_ID, userId: OWNER_ID, content: BLOCKED_HTML })
    ).rejects.toThrow('invalid urls');

    expect(contentSql()).toEqual([]);
  });

  it('runs the follow-up work a content change implies', async () => {
    await applyArticleContentChange({ id: ARTICLE_ID, userId: OWNER_ID, content: EXPANDED_HTML });

    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Article', entityId: ARTICLE_ID })
    );
  });
});
