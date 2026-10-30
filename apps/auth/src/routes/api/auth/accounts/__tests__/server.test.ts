import { describe, it, expect, vi, beforeEach } from 'vitest';

// Listing needs the caller's principal (the impersonating moderator, else the active account) linked and
// fresh on this device. Only the device set and the session-user cache are stubbed.

const h = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  isLinkedAndFresh: vi.fn(),
  removeAccount: vi.fn(),
  getOrProduceSessionUser: vi.fn(),
}));

vi.mock('$lib/server/auth/device', () => ({
  listAccounts: h.listAccounts,
  isLinkedAndFresh: h.isLinkedAndFresh,
  removeAccount: h.removeAccount,
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduceSessionUser,
}));

import { GET } from '../+server';

const DEVICE = 'device-xyz';
const ACTIVE = 100;
const MODERATOR = 900;

function makeEvent(locals: Record<string, unknown> = { user: { id: ACTIVE } }) {
  return { cookies: {}, locals: { deviceId: DEVICE, ...locals } } as never;
}

// The device set holds exactly these user ids.
const deviceSet = (...ids: number[]) => {
  h.listAccounts.mockResolvedValue(ids.map((userId) => ({ userId, lastSwitchedAt: Date.now() })));
  h.isLinkedAndFresh.mockImplementation(async (_d: string, id: number) => ids.includes(id));
};

const listedIds = async (event: never) => {
  const body = (await (await GET(event)).json()) as { accounts: { userId: number }[] };
  return body.accounts.map((a) => a.userId);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getOrProduceSessionUser.mockImplementation(async (id: number) => ({
    id,
    username: `u${id}`,
  }));
});

describe('GET /api/auth/accounts', () => {
  it('lists the device set when the active account is a member', async () => {
    deviceSet(ACTIVE, 200);
    expect(await listedIds(makeEvent())).toEqual([ACTIVE, 200]);
  });

  it('returns an empty list for a device set the active account is not in', async () => {
    deviceSet(200, 300);
    expect(await listedIds(makeEvent())).toEqual([]);
  });

  it('checks the impersonating moderator, not the impersonated account', async () => {
    deviceSet(MODERATOR, 200);
    expect(await listedIds(makeEvent({ user: { id: ACTIVE }, impersonatedBy: MODERATOR }))).toEqual(
      [MODERATOR, 200]
    );

    deviceSet(ACTIVE, 200);
    expect(await listedIds(makeEvent({ user: { id: ACTIVE }, impersonatedBy: MODERATOR }))).toEqual(
      []
    );
  });

  it('returns an empty list when signed out', async () => {
    deviceSet(200);
    expect(await listedIds(makeEvent({}))).toEqual([]);
  });
});
