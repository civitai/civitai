import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// src/pages/api/user/getHiddenPreferences.ts. A refresh rebuilds every hidden-preference cache
// from the database (the block caches from the primary), so only a signed-in user may force one.

const { getAllHiddenForUser, getServerAuthSession } = vi.hoisted(() => ({
  getAllHiddenForUser: vi.fn(async (..._a: unknown[]) => ({})),
  getServerAuthSession: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/user-preferences.service', () => ({ getAllHiddenForUser }));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession }));

import handler from '~/pages/api/user/getHiddenPreferences';

const run = async (query: Record<string, string>) => {
  const req = { method: 'GET', query } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
    req,
    res
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  getServerAuthSession.mockResolvedValue(null);
});

describe('getHiddenPreferences endpoint — refresh', () => {
  it('ignores ?refresh=1 for an anonymous caller (cached path)', async () => {
    await run({ refresh: '1' });

    expect(getAllHiddenForUser).toHaveBeenCalledWith({ userId: -1, refreshCache: false });
  });

  it('honours ?refresh=1 for a signed-in user', async () => {
    getServerAuthSession.mockResolvedValue({ user: { id: 42 } });

    await run({ refresh: '1' });

    expect(getAllHiddenForUser).toHaveBeenCalledWith({ userId: 42, refreshCache: true });
  });

  it('uses the cached path for a signed-in user without refresh', async () => {
    getServerAuthSession.mockResolvedValue({ user: { id: 42 } });

    await run({});

    expect(getAllHiddenForUser).toHaveBeenCalledWith({ userId: 42, refreshCache: false });
  });
});
