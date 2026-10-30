import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SystemCache from '~/server/services/system-cache';

const { replacedTagIdsMock } = vi.hoisted(() => ({ replacedTagIdsMock: vi.fn() }));

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getReplacedTagIds: replacedTagIdsMock,
}));

import { getHubSourceScope } from '~/server/services/user-hub.service';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Each tab searches inside itself. That is the trade the picker makes, and it owes two
// things back: a way to reach what a scope cannot hold, and an answer when the search
// finds nothing because the person is looking in the wrong drawer.

const findUser = dbMock.dbRead.user.findFirst;
const findTags = dbMock.dbRead.tag.findMany;
const findFollows = dbMock.dbRead.userEngagement.findMany;
const findModels = dbMock.dbRead.model.findMany;
const findFaces = dbMock.dbRead.user.findMany;
const findBookmarkCollection = dbMock.dbRead.collection.findFirst;
const findBells = dbMock.dbRead.modelEngagement.findMany;

beforeEach(() => {
  for (const mock of [
    findUser,
    findTags,
    findFollows,
    findModels,
    findFaces,
    findBookmarkCollection,
    findBells,
  ])
    mock.mockClear();
  replacedTagIdsMock.mockResolvedValue([]);
});

describe('getHubSourceScope', () => {
  it('finds a creator nobody follows, by exact username', async () => {
    findUser.mockResolvedValue({ id: 9, username: 'ruolong' });

    const result = await getHubSourceScope({ scope: 'following', query: 'ruolong', userId: 5 });

    expect(result.items).toContainEqual(
      expect.objectContaining({ type: UserHubSourceType.User, targetId: 9, alias: 'ruolong' })
    );
  });

  it('matches that username exactly rather than by pattern', async () => {
    // Asserted on the QUERY: `username` is citext, so neither `contains` nor
    // `startsWith` can use an index — both seq-scan 13M rows for seconds. A mocked
    // Prisma returns the row either way, so only the emitted `where` shows it.
    findUser.mockResolvedValue({ id: 9, username: 'ruolong' });

    await getHubSourceScope({ scope: 'following', query: 'ruolong', userId: 5 });

    expect(findUser.mock.calls[0][0]).toMatchObject({
      where: { username: 'ruolong', deletedAt: null },
    });
  });

  it('holds nothing in Tags until something is typed', async () => {
    // There is no list of this viewer's tags to browse, and the site's biggest tags
    // are not something to offer as one-click adds.
    const result = await getHubSourceScope({ scope: 'tags', userId: 5 });

    expect(result.items).toEqual([]);
    expect(findTags).not.toHaveBeenCalled();
  });

  it('drops a replaced tag, which the index would never match', async () => {
    findTags.mockResolvedValue([
      { id: 1, name: 'anime', metrics: [{ imageCount: 4200000 }] },
      { id: 2, name: 'anime style', metrics: [{ imageCount: 900 }] },
    ]);
    replacedTagIdsMock.mockResolvedValue([2]);

    const result = await getHubSourceScope({ scope: 'tags', query: 'anime', userId: 5 });

    expect(result.items).toEqual([
      { type: UserHubSourceType.Tag, targetId: 1, alias: 'anime', imageCount: 4200000 },
    ]);
  });

  it('ranks tags by use, not alphabetically', async () => {
    // Alphabetically 'swimsuit bottom' outranks 'swimsuit', and with a page of ten the
    // tag someone meant falls off the end — the complaint that produced this.
    findTags.mockResolvedValue([
      { id: 1, name: 'swimsuit bottom', metrics: [{ imageCount: 400 }] },
      { id: 2, name: 'swimsuit', metrics: [{ imageCount: 120000 }] },
    ]);

    const result = await getHubSourceScope({ scope: 'tags', query: 'swimsuit', userId: 5 });

    expect(result.items.map((item) => item.alias)).toEqual(['swimsuit', 'swimsuit bottom']);
  });

  it('says where the matches were when this scope has none', async () => {
    // The whole cost of scoping search: "no results" in My models is indistinguishable
    // from "no results anywhere" unless the other scopes are checked and reported.
    findModels.mockResolvedValue([]);
    findTags.mockResolvedValue([{ id: 1, name: 'anime', metrics: [{ imageCount: 42 }] }]);

    const result = await getHubSourceScope({ scope: 'my-models', query: 'anime', userId: 5 });

    expect(result.items).toEqual([]);
    expect(result.elsewhere).toContainEqual({ scope: 'tags', count: 1 });
  });

  // The keep-out box has no tabs, so 'all' is 100% of its traffic — and it is the only
  // way anything reaches that list.
  describe("the keep-out box's scope", () => {
    it('holds nothing until something is typed', async () => {
      const result = await getHubSourceScope({ scope: 'all', userId: 5 });

      expect(result.items).toEqual([]);
      for (const mock of [findUser, findTags, findFollows, findModels])
        expect(mock).not.toHaveBeenCalled();
    });

    it('answers from every scope at once', async () => {
      findUser.mockResolvedValue({ id: 9, username: 'anime' });
      findFaces.mockResolvedValue([{ id: 9, username: 'anime', image: null }]);
      findModels.mockResolvedValue([{ id: 4, name: 'Anime Mix', metrics: [{ imageCount: 12 }] }]);
      findTags.mockResolvedValue([{ id: 1, name: 'anime', metrics: [{ imageCount: 42 }] }]);

      const result = await getHubSourceScope({ scope: 'all', query: 'anime', userId: 5 });

      expect(result.items.map((item) => item.type)).toEqual(
        expect.arrayContaining([
          UserHubSourceType.User,
          UserHubSourceType.Model,
          UserHubSourceType.Tag,
        ])
      );
      expect(result.total).toBe(result.items.length);
    });

    it('does not re-ask every scope to report where the matches were', async () => {
      // 'all' has already read all four, so `elsewhere` can only ever come back empty —
      // and rebuilding it is a second full fan-out, on every keystroke that matches
      // nothing, including a `Tag` scan.
      // mockClear keeps the previous test's return values, so say so explicitly.
      for (const mock of [findTags, findModels, findFollows, findFaces]) mock.mockResolvedValue([]);
      findUser.mockResolvedValue(null);

      const result = await getHubSourceScope({ scope: 'all', query: 'nothingmatches', userId: 5 });

      expect(result.items).toEqual([]);
      expect(result.elsewhere).toEqual([]);
      expect(findTags).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the viewer own models out of the bookmarked scope', async () => {
    // They have their own tab. A creator seeing their whole catalogue under
    // "Bookmarked" is the complaint the split was written for.
    findBookmarkCollection.mockResolvedValue({ id: 77 });
    findBells.mockResolvedValue([{ modelId: 4 }]);

    await getHubSourceScope({ scope: 'bookmarks', userId: 5 });

    expect(findModels.mock.calls[0][0]).toMatchObject({ where: { userId: { not: 5 } } });
  });

  it('does not go looking elsewhere when this scope answered', async () => {
    // Three extra queries per keystroke, for a question nobody asked while they can
    // see results.
    findModels.mockResolvedValue([{ id: 4, name: 'Anime Mix', metrics: [{ imageCount: 12 }] }]);

    const result = await getHubSourceScope({ scope: 'my-models', query: 'anime', userId: 5 });

    expect(result.items).toHaveLength(1);
    expect(result.elsewhere).toEqual([]);
    expect(findTags).not.toHaveBeenCalled();
  });
});
