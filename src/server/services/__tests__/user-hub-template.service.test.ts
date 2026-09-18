import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Blocklist from '~/server/services/blocklist.service';

// The scan is the real one everywhere else; here it stands in for "this exact text is
// refused", which is the only way to exercise the alias path without naming the
// patterns it holds.
const { blockedTextMock } = vi.hoisted(() => ({ blockedTextMock: vi.fn() }));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: blockedTextMock,
}));

import { getHubSourceCandidates } from '~/server/services/user-hub.service';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { ModelStatus, UserHubSourceType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A starting point is the only thing that fills a hub with sources nobody picked one
// by one. It creates NOTHING — what it gathers is handed to the editor — so what it
// gathers, what it counts, and what it does with text it cannot show are the whole
// behaviour.

const create = dbMock.dbWrite.userHub.create;
const findModels = dbMock.dbRead.model.findMany;
const countModels = dbMock.dbRead.model.count;
const findFollows = dbMock.dbRead.userEngagement.findMany;
const countFollows = dbMock.dbRead.userEngagement.count;
const findUsers = dbMock.dbRead.user.findMany;

beforeEach(() => {
  // Call history is not cleared between tests in this suite's setup, and every
  // assertion here reads `calls[0]` or counts calls.
  for (const mock of [create, findModels, countModels, findFollows, countFollows, findUsers])
    mock.mockClear();
  countModels.mockResolvedValue(0);
  countFollows.mockResolvedValue(0);
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

describe('getHubSourceCandidates', () => {
  it('writes nothing — a hub exists only once someone saves the editor', async () => {
    findModels.mockResolvedValue([{ id: 11, name: 'Newest' }]);

    await getHubSourceCandidates({ template: 'my-models', userId: 5 });

    // The whole point of the change: this used to create a hub the user had not seen.
    expect(create).not.toHaveBeenCalled();
  });

  it('gathers the newest published models the user owns', async () => {
    findModels.mockResolvedValue([
      { id: 11, name: 'Newest' },
      { id: 9, name: 'Older' },
    ]);

    const result = await getHubSourceCandidates({ template: 'my-models', userId: 5 });

    // Asserted on the QUERY, because a mocked Prisma ignores `where` and `take`:
    // returning rows for the fake proves nothing about which rows production reads.
    // Without the status and deletedAt clauses the editor opens full of the user's
    // unpublished drafts, which is the one thing this must not surface.
    expect(findModels.mock.calls[0][0]).toMatchObject({
      where: { userId: 5, status: ModelStatus.Published, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: hubLimits.sourcesPerHub,
    });

    expect(result.sources).toEqual([
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

  it('counts what there WAS, not what fit', async () => {
    // The two numbers together are what makes the shortfall sayable — the gather stops
    // at the cap, so counting its result would always report "everything fit".
    findModels.mockResolvedValue([{ id: 11, name: 'One' }]);
    countModels.mockResolvedValue(312);

    const result = await getHubSourceCandidates({ template: 'my-models', userId: 5 });

    expect(result.total).toBe(312);
    expect(result.sources).toHaveLength(1);
  });

  it('returns an empty list rather than throwing when there is nothing to gather', async () => {
    // The editor opens and explains itself; an error toast could not, and the person
    // is one search away from filling it by hand.
    findModels.mockResolvedValue([]);

    const result = await getHubSourceCandidates({ template: 'my-models', userId: 5 });

    expect(result).toMatchObject({ sources: [], total: 0 });
  });

  it('gathers followed creators in follow order, newest first', async () => {
    findFollows.mockResolvedValue([{ targetUserId: 3 }, { targetUserId: 4 }]);
    // Returned in the other order on purpose: the service must key on the follow
    // list, not on whatever order the user query answers in.
    findUsers.mockResolvedValue([
      { id: 4, username: 'second' },
      { id: 3, username: 'first' },
    ]);

    const result = await getHubSourceCandidates({ template: 'following', userId: 5 });

    expect(findFollows.mock.calls[0][0]).toMatchObject({ orderBy: { createdAt: 'desc' } });
    expect(result.sources.map((source) => [source.targetId, source.alias])).toEqual([
      [3, 'first'],
      [4, 'second'],
    ]);
  });

  it('drops a followed account the user query did not return', async () => {
    // A deleted account is filtered out by the query's own `deletedAt` clause, so it
    // comes back as an id with no row. Kept, it would be a source pointing at a user
    // nobody can open.
    findFollows.mockResolvedValue([{ targetUserId: 3 }, { targetUserId: 99 }]);
    findUsers.mockResolvedValue([{ id: 3, username: 'first' }]);

    const result = await getHubSourceCandidates({ template: 'following', userId: 5 });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].targetId).toBe(3);
  });

  it('reads past the cap so dead follows cannot hide the live ones behind them', async () => {
    // The window is applied before the dead accounts are dropped. At exactly the cap,
    // a user whose 50 most recent follows are deleted gathers nothing at all.
    findFollows.mockResolvedValue([{ targetUserId: 99 }, { targetUserId: 3 }]);
    findUsers.mockResolvedValue([{ id: 3, username: 'alive' }]);

    const result = await getHubSourceCandidates({ template: 'following', userId: 5 });

    expect(findFollows.mock.calls[0][0]).toMatchObject({ take: hubLimits.sourcesPerHub * 3 });
    expect(result.sources).toHaveLength(1);
  });

  it('keeps a creator whose name the scan refuses, without its label', async () => {
    // The alias is someone else's username — the user did not write it and cannot edit
    // it. Dropping the source would quietly remove a creator they asked for; keeping
    // the text would publish something unscanned. The source stays, the label does not.
    refuse('refused');
    findFollows.mockResolvedValue([{ targetUserId: 3 }, { targetUserId: 4 }]);
    findUsers.mockResolvedValue([
      { id: 3, username: 'fine' },
      { id: 4, username: 'refused' },
    ]);

    const result = await getHubSourceCandidates({ template: 'following', userId: 5 });

    expect(result.sources.map((source) => [source.targetId, source.alias])).toEqual([
      [3, 'fine'],
      [4, null],
    ]);
  });
});
