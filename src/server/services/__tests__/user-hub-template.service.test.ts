import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Blocklist from '~/server/services/blocklist.service';

// The scan is the real one everywhere else; here it stands in for "this exact text is
// refused", which is the only way to exercise the alias-dropping path without naming
// the patterns it holds.
const { blockedTextMock } = vi.hoisted(() => ({ blockedTextMock: vi.fn() }));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: blockedTextMock,
}));

import { createHubFromTemplate } from '~/server/services/user-hub.service';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { ModelStatus, UserHubSourceType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A template is the only path that puts sources into a hub the user never picked one
// by one, so what it gathers — and what it silently drops — is the whole behaviour.

const create = dbMock.dbWrite.userHub.create;
const findModels = dbMock.dbRead.model.findMany;
const findFollows = dbMock.dbRead.userEngagement.findMany;
const findUsers = dbMock.dbRead.user.findMany;

const createdSources = () => {
  const arg = create.mock.calls[0][0] as {
    data: { sources: { create: { type: string; targetId: number; alias: string | null }[] } };
  };
  return arg.data.sources.create;
};

beforeEach(() => {
  // Call history is not cleared between tests in this suite's setup, and every
  // assertion here reads `calls[0]` or counts calls.
  for (const mock of [create, findModels, findFollows, findUsers]) mock.mockClear();
  create.mockResolvedValue({ id: 7, metadata: {}, sources: [] });
  blockedTextMock.mockReset();
  blockedTextMock.mockResolvedValue(undefined);
});

// Refuses any call whose content includes `blocked`, the way the real scan refuses a
// matched pattern — batch calls included, since that is the call the service makes
// first.
const refuse = (blocked: string) =>
  blockedTextMock.mockImplementation(async (content: unknown) => {
    const values = Array.isArray(content) ? content : [content];
    if (values.includes(blocked)) throw new Error('blocked');
  });

describe('createHubFromTemplate — my-models', () => {
  it('seeds the newest published models the user owns', async () => {
    findModels.mockResolvedValue([
      { id: 11, name: 'Newest' },
      { id: 9, name: 'Older' },
    ]);

    await createHubFromTemplate({ template: 'my-models', userId: 5 });

    // Asserted on the QUERY, because a mocked Prisma ignores `where` and `take`:
    // returning rows for the fake proves nothing about which rows production reads.
    // Without the status and deletedAt clauses a hub arrives full of the user's
    // unpublished drafts, which is the one thing this template must not surface.
    expect(findModels.mock.calls[0][0]).toMatchObject({
      where: { userId: 5, status: ModelStatus.Published, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: hubLimits.sourcesPerHub,
    });

    expect(createdSources()).toEqual([
      {
        type: UserHubSourceType.Model,
        targetId: 11,
        alias: 'Newest',
        enabled: true,
        exclude: false,
        index: 0,
      },
      {
        type: UserHubSourceType.Model,
        targetId: 9,
        alias: 'Older',
        enabled: true,
        exclude: false,
        index: 1,
      },
    ]);
  });

  it('refuses rather than creating an empty hub when the user has published nothing', async () => {
    findModels.mockResolvedValue([]);

    await expect(createHubFromTemplate({ template: 'my-models', userId: 5 })).rejects.toThrow(
      /no published models/i
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('createHubFromTemplate — following', () => {
  it('seeds followed creators in follow order, newest first', async () => {
    findFollows.mockResolvedValue([{ targetUserId: 3 }, { targetUserId: 4 }]);
    // Returned in the other order on purpose: the service must key on the follow
    // list, not on whatever order the user query answers in.
    findUsers.mockResolvedValue([
      { id: 4, username: 'second' },
      { id: 3, username: 'first' },
    ]);

    await createHubFromTemplate({ template: 'following', userId: 5 });

    expect(findFollows.mock.calls[0][0]).toMatchObject({ orderBy: { createdAt: 'desc' } });
    expect(createdSources().map((source) => [source.targetId, source.alias])).toEqual([
      [3, 'first'],
      [4, 'second'],
    ]);
  });

  it('drops a followed account the user query did not return', async () => {
    // A deleted account is filtered out by the query's own `deletedAt` clause, so it
    // comes back as an id with no row. Kept, it would be a source with a null alias
    // pointing at a user nobody can open.
    findFollows.mockResolvedValue([{ targetUserId: 3 }, { targetUserId: 99 }]);
    findUsers.mockResolvedValue([{ id: 3, username: 'first' }]);

    await createHubFromTemplate({ template: 'following', userId: 5 });

    expect(createdSources()).toHaveLength(1);
    expect(createdSources()[0].targetId).toBe(3);
  });

  it('reads past the cap so dead follows cannot hide the live ones behind them', async () => {
    // The window is applied before the dead accounts are dropped. At exactly the cap,
    // a user whose 50 most recent follows are deleted is told they follow nobody.
    findFollows.mockResolvedValue([{ targetUserId: 99 }, { targetUserId: 3 }]);
    findUsers.mockResolvedValue([{ id: 3, username: 'alive' }]);

    await createHubFromTemplate({ template: 'following', userId: 5 });

    expect(findFollows.mock.calls[0][0]).toMatchObject({
      take: hubLimits.sourcesPerHub * 3,
    });
    expect(createdSources()).toHaveLength(1);
  });

  it('leaves out a creator the content scan refuses, and builds the hub anyway', async () => {
    // The alias is someone else's username: the user did not write it and cannot edit
    // it from this screen, so refusing the whole template leaves them nothing to do.
    refuse('refused');
    findFollows.mockResolvedValue([{ targetUserId: 3 }, { targetUserId: 4 }]);
    findUsers.mockResolvedValue([
      { id: 3, username: 'fine' },
      { id: 4, username: 'refused' },
    ]);

    await createHubFromTemplate({ template: 'following', userId: 5 });

    expect(createdSources().map((source) => source.alias)).toEqual(['fine']);
  });

  it('still refuses when every alias is left out', async () => {
    refuse('refused');
    findFollows.mockResolvedValue([{ targetUserId: 4 }]);
    findUsers.mockResolvedValue([{ id: 4, username: 'refused' }]);

    await expect(createHubFromTemplate({ template: 'following', userId: 5 })).rejects.toThrow(
      /not following anyone/i
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses rather than creating an empty hub when every followed account is gone', async () => {
    findFollows.mockResolvedValue([{ targetUserId: 99 }]);
    findUsers.mockResolvedValue([]);

    await expect(createHubFromTemplate({ template: 'following', userId: 5 })).rejects.toThrow(
      /not following anyone/i
    );
    expect(create).not.toHaveBeenCalled();
  });
});
