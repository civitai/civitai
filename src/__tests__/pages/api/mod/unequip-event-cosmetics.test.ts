import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// ModEndpoint wraps the handler in mod-auth; the handler itself is what is under test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

const TEAM_COSMETIC = { Red: 12, Blue: 14 } as Record<string, number>;
vi.mock('~/server/events', () => ({
  events: [
    {
      name: 'ended-event',
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2025-01-31T00:00:00Z'),
      teams: ['Red', 'Blue'],
      getTeamCosmetic: async (team: string) => TEAM_COSMETIC[team],
    },
  ],
}));

const { default: handler } = await import('~/pages/api/mod/unequip-event-cosmetics');
const { usersSearchIndex } = await import('~/server/search-index/users.search-index');

const WEARERS: Record<number, number[]> = { 12: [301, 302], 14: [303] };

function fakeRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res as unknown as NextApiResponse & typeof res;
}

describe('/api/mod/unequip-event-cosmetics', () => {
  // Search results and user pickers render the cosmetics on each user's search document, which
  // the sync re-pulls only for queued ids: every user it unequipped must be queued, and no one else.
  it('queues the users it unequipped for a search-index update', async () => {
    dbMock.dbWrite.userCosmetic.findMany.mockImplementation((async (args: {
      where: { cosmeticId: number; equippedToId?: unknown };
    }) =>
      args.where.equippedToId === null
        ? (WEARERS[args.where.cosmeticId] ?? []).map((userId) => ({ userId }))
        : []) as never);
    dbMock.dbWrite.userCosmetic.updateMany.mockResolvedValue({ count: 1 });
    const queue = vi.spyOn(usersSearchIndex, 'queueUpdate').mockResolvedValue();
    onTestFinished(() => queue.mockRestore());
    const res = fakeRes();

    await handler({ query: { eventName: 'ended-event' } } as unknown as NextApiRequest, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(queue.mock.calls.flatMap(([items]) => items.map((x) => x.id))).toEqual([301, 302, 303]);
  });
});
