import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ArticleService from '~/server/services/article.service';

const { mockUpsertArticle } = vi.hoisted(() => ({ mockUpsertArticle: vi.fn() }));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  upsertArticle: mockUpsertArticle,
}));

// The handler still runs the pre-existing adminOnly-CATEGORY check, which reads the
// system cache. Unrelated to this field, and it throws without redis.
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCategoryTags: async () => [],
}));

import { upsertArticleHandler } from '../article.controller';

function ctx(isModerator: boolean) {
  return {
    user: { id: 7, isModerator },
    features: { articleImageScanning: false },
    req: undefined,
    track: { article: vi.fn(async () => undefined) },
  } as never;
}

const input = (isOfficial?: boolean) =>
  ({
    id: 5,
    title: 't',
    content: '<p>c</p>',
    ...(isOfficial === undefined ? {} : { isOfficial }),
  } as never);

const lastUpsertArg = () => mockUpsertArticle.mock.calls.at(-1)?.[0] as Record<string, unknown>;

/**
 * `isOfficial` is a provenance claim reachable from a user-facing mutation, so the
 * question is not only "can a member set it" but "what happens to a member who sends it".
 */
describe('upsertArticleHandler — isOfficial', () => {
  beforeEach(() => {
    mockUpsertArticle.mockReset();
    mockUpsertArticle.mockResolvedValue({ id: 5, publishedAt: null });
    dbMock.dbRead.article.findUnique.mockResolvedValue({ publishedAt: null });
    dbMock.dbRead.tag.findMany.mockResolvedValue([]);
  });

  it('does not let a member mark their own article official', async () => {
    await upsertArticleHandler({ input: input(true), ctx: ctx(false) });

    expect(lastUpsertArg().isOfficial).toBeUndefined();
  });

  // 🔴 The other half, and the one that is easy to get wrong. The member's SAVE must
  // still succeed. Refusing is what killed the tag version of this feature: the edit form
  // seeds itself from the article, so an owner editing an article a moderator had marked
  // would send the flag back and be locked out of their own article with a bare
  // UNAUTHORIZED and nothing explaining it.
  it('still saves the member’s article, rather than refusing it', async () => {
    await expect(
      upsertArticleHandler({ input: input(true), ctx: ctx(false) })
    ).resolves.toBeDefined();

    expect(mockUpsertArticle).toHaveBeenCalledTimes(1);
    expect(lastUpsertArg().title).toBe('t');
  });

  // `undefined` is what tells `upsertArticle` to leave the column alone, so this is also
  // the assertion that a member's edit cannot CLEAR a mark a moderator set.
  it('does not let a member clear an official mark either', async () => {
    await upsertArticleHandler({ input: input(false), ctx: ctx(false) });

    expect(lastUpsertArg().isOfficial).toBeUndefined();
  });

  // The control for all three: same field, moderator context. Without it they pass for a
  // handler that drops `isOfficial` from everyone, which would make the editor toggle a
  // decoration.
  it('passes a moderator’s value through', async () => {
    await upsertArticleHandler({ input: input(true), ctx: ctx(true) });
    expect(lastUpsertArg().isOfficial).toBe(true);

    await upsertArticleHandler({ input: input(false), ctx: ctx(true) });
    expect(lastUpsertArg().isOfficial).toBe(false);
  });

  // An ordinary save from anyone must not carry the key at all — `upsertArticle` reads
  // `undefined` as "leave the column alone", and an accidental `false` here would unmark
  // every official article the moment its author edited it.
  it('sends no isOfficial key when nobody asked for one', async () => {
    await upsertArticleHandler({ input: input(), ctx: ctx(true) });

    expect(lastUpsertArg()).toHaveProperty('isOfficial', undefined);
  });
});
