import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as AccountStandingService from '~/server/services/account-standing.service';
import type { AccountStanding } from '~/server/services/account-standing.service';

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));

const getAccountStanding = vi.fn<(userId: number) => Promise<AccountStanding>>();
vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountStandingService>()),
  getAccountStanding: (userId: number) => getAccountStanding(userId),
}));

const handler = (await import('~/pages/api/v1/me')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

async function status(user: SessionUser) {
  let body: Record<string, unknown> | undefined;
  const req = { method: 'GET', headers: {}, query: {}, context: {} } as unknown as NextApiRequest;
  const res = {
    send(value: Record<string, unknown>) {
      body = value;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler(req, res, user);
  return body?.status;
}

// A session minted before the mute or ban still says the account is fine.
const STALE_SESSION = { id: 7, username: 'u', muted: false } as SessionUser;
const standing = (s: Partial<AccountStanding>): AccountStanding => ({
  muted: false,
  banned: false,
  exists: true,
  ...s,
});

describe('GET /api/v1/me status', () => {
  beforeEach(() => getAccountStanding.mockReset());

  // Deliberate: callers cache this status, so it must come from the stored standing and not only
  // from the session. Do not go back to reading `user.muted` alone.
  it('reports muted when the session is stale but the stored standing is muted', async () => {
    getAccountStanding.mockResolvedValue(standing({ muted: true }));
    expect(await status(STALE_SESSION)).toBe('muted');
    expect(getAccountStanding).toHaveBeenCalledWith(7);
  });

  it('reports banned when the session is stale but the stored standing is banned', async () => {
    getAccountStanding.mockResolvedValue(standing({ banned: true, muted: true }));
    expect(await status(STALE_SESSION)).toBe('banned');
  });

  it('reports banned when the session says banned, whatever the stored standing', async () => {
    getAccountStanding.mockResolvedValue(standing({}));
    expect(await status({ ...STALE_SESSION, bannedAt: new Date() } as SessionUser)).toBe('banned');
  });

  it('reports active when both the session and the stored standing are clear', async () => {
    getAccountStanding.mockResolvedValue(standing({}));
    expect(await status(STALE_SESSION)).toBe('active');
  });

  it('keeps the session copy when the stored standing cannot be read', async () => {
    const down = new Error('cache and db down');
    getAccountStanding.mockRejectedValueOnce(down).mockRejectedValueOnce(down);
    expect(await status({ ...STALE_SESSION, muted: true } as SessionUser)).toBe('muted');
    expect(await status(STALE_SESSION)).toBe('active');
  });
});
