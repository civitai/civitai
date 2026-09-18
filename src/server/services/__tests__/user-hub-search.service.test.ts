import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SystemCache from '~/server/services/system-cache';

const { replacedTagIdsMock } = vi.hoisted(() => ({ replacedTagIdsMock: vi.fn() }));

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getReplacedTagIds: replacedTagIdsMock,
}));

import { searchHubSources } from '~/server/services/user-hub.service';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The picker searches what the viewer follows and owns. A creator they have never
// followed is invisible to those arms, which is what made an exact username find
// nothing — so the escape hatch and its shape are the behaviour worth pinning.

const findUser = dbMock.dbRead.user.findFirst;
const findTags = dbMock.dbRead.tag.findMany;
const findFollows = dbMock.dbRead.userEngagement.findMany;

beforeEach(() => {
  for (const mock of [findUser, findTags, findFollows]) mock.mockClear();
  replacedTagIdsMock.mockResolvedValue([]);
});

describe('searchHubSources', () => {
  it('finds a creator nobody follows, by exact username', async () => {
    findUser.mockResolvedValue({ id: 9, username: 'ruolong' });

    const results = await searchHubSources({ userId: 5, query: 'ruolong' });

    expect(results).toContainEqual({
      type: UserHubSourceType.User,
      targetId: 9,
      alias: 'ruolong',
    });
  });

  it('matches the username exactly rather than by pattern', async () => {
    // Asserted on the QUERY: `username` is citext, so neither `contains` nor
    // `startsWith` can use an index — both seq-scan 13M rows for seconds. A mocked
    // Prisma returns the row either way, so only the emitted `where` shows it.
    findUser.mockResolvedValue({ id: 9, username: 'ruolong' });

    await searchHubSources({ userId: 5, query: 'ruolong' });

    expect(findUser.mock.calls[0][0]).toMatchObject({
      where: { username: 'ruolong', deletedAt: null },
    });
  });

  it('does not repeat a creator the followed arm already returned', async () => {
    findFollows.mockResolvedValue([{ targetUserId: 9 }]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 9, username: 'ruolong' }]);
    findUser.mockResolvedValue({ id: 9, username: 'ruolong' });

    const results = await searchHubSources({ userId: 5, query: 'ruolong' });

    expect(results.filter((item) => item.targetId === 9)).toHaveLength(1);
  });

  it('leaves tags out until something is typed', async () => {
    await searchHubSources({ userId: 5 });

    // With no term the other arms are "what you already follow and own"; the site's
    // most-used tags are not that, and a tag query with no term is a page of them.
    expect(findTags).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('drops a replaced tag, which the index would never match', async () => {
    findTags.mockResolvedValue([
      { id: 1, name: 'anime' },
      { id: 2, name: 'anime style' },
    ]);
    replacedTagIdsMock.mockResolvedValue([2]);

    const results = await searchHubSources({ userId: 5, query: 'anime' });

    expect(results.filter((item) => item.type === UserHubSourceType.Tag)).toEqual([
      { type: UserHubSourceType.Tag, targetId: 1, alias: 'anime' },
    ]);
  });
});
