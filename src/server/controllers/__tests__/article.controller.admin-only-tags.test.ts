import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ArticleService from '~/server/services/article.service';

const { mockUpsertArticle } = vi.hoisted(() => ({ mockUpsertArticle: vi.fn() }));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  upsertArticle: mockUpsertArticle,
}));

import { upsertArticleHandler } from '../article.controller';

const OFFICIAL = { id: 900001, name: 'civitai official' };

function ctx({ adminTags }: { adminTags?: boolean }) {
  return {
    user: { id: 7, isModerator: false },
    features: { adminTags, articleImageScanning: false },
    req: undefined,
    // The handler tracks provenance after a successful save. Stubbed so the
    // ALLOWED assertions do not fail for an unrelated reason.
    track: { article: vi.fn(async () => undefined) },
  } as never;
}

const input = (tags: { id?: number; name?: string }[]) =>
  ({ title: 't', content: '<p>c</p>', tags } as never);

describe('upsertArticleHandler — adminOnly tags', () => {
  beforeEach(() => {
    mockUpsertArticle.mockReset();
    mockUpsertArticle.mockResolvedValue({ id: 1, publishedAt: null });
    // Call history, not just the return value: the shared db mock keeps its calls across
    // tests in a file, so `not.toHaveBeenCalled()` below would be reading the PREVIOUS
    // test's guard query and failing for the wrong reason.
    dbMock.dbRead.tag.findMany.mockClear();
    dbMock.dbRead.tag.findMany.mockResolvedValue([]);
    dbMock.dbRead.article.findUnique.mockResolvedValue(null);
  });

  // 🔴 The defect this file exists for. The guard used to resolve the incoming tags
  // through `getCategoryTags('article')`, so it only saw adminOnly tags that were ALSO
  // article categories. An adminOnly tag that is not a category — which is what a
  // mod-only marker has to be, since one article already carries exactly one category —
  // went through unchecked, and tags attach by NAME via `connectOrCreate`, so a normal
  // user could put it on their own article by typing it.
  it('refuses an adminOnly tag that is not a category', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([OFFICIAL]);

    await expect(
      upsertArticleHandler({ input: input([{ name: OFFICIAL.name }]), ctx: ctx({}) })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockUpsertArticle).not.toHaveBeenCalled();
  });

  // The control for the test above: same call, same user, a tag the table does not report
  // as adminOnly. Without this, a handler that refused EVERY article would pass.
  it('allows an ordinary tag from the same user', async () => {
    await expect(
      upsertArticleHandler({ input: input([{ name: 'workflows' }]), ctx: ctx({}) })
    ).resolves.toBeDefined();

    expect(mockUpsertArticle).toHaveBeenCalledTimes(1);
  });

  it('allows an adminOnly tag when the user holds the adminTags feature', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([OFFICIAL]);

    await expect(
      upsertArticleHandler({
        input: input([{ name: OFFICIAL.name }]),
        ctx: ctx({ adminTags: true }),
      })
    ).resolves.toBeDefined();

    expect(mockUpsertArticle).toHaveBeenCalledTimes(1);
  });

  // A mod pays no query for the check. Stated as a test because the obvious refactor —
  // resolve first, then decide — is a database read on every article save by a moderator,
  // and nothing else would notice.
  it('does not query the tag table at all for an adminTags holder', async () => {
    await upsertArticleHandler({
      input: input([{ name: OFFICIAL.name }]),
      ctx: ctx({ adminTags: true }),
    });

    expect(dbMock.dbRead.tag.findMany).not.toHaveBeenCalled();
  });

  // `adminTags` is a sparse FeatureAccess: an off flag is absent, so it reads `undefined`
  // rather than `false`. A guard written as `=== false` would let every non-mod through.
  it('treats an absent adminTags flag as off, not as unknown', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([OFFICIAL]);

    await expect(
      upsertArticleHandler({ input: input([{ name: OFFICIAL.name }]), ctx: ctx({}) })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('asks the tag table for both the ids and the lowercased names it was sent', async () => {
    await upsertArticleHandler({
      input: input([{ id: 12, name: 'Announcement' }, { name: '  Civitai Official  ' }]),
      ctx: ctx({}),
    });

    const [args] = dbMock.dbRead.tag.findMany.mock.calls[0] as [
      { where: { adminOnly: boolean; OR: ({ id?: unknown } | { name?: unknown })[] } }
    ];
    expect(args.where.adminOnly).toBe(true);
    // Normalised the way `article.service` normalises on the attach path. A guard
    // comparing the raw string misses `Civitai Official` for the tag named
    // `civitai official`, which is a one-keystroke bypass.
    expect(args.where.OR).toEqual([
      { id: { in: [12] } },
      { name: { in: ['announcement', 'civitai official'] } },
    ]);
  });
});
