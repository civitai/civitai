import { describe, it, expect, vi, beforeEach } from 'vitest';

// Switching needs BOTH the active account and the target linked (and fresh) on this device. The real
// `readUserId` runs; only the device set and session collaborators are stubbed.

const h = vi.hoisted(() => ({
  getDeviceId: vi.fn(),
  isLinkedAndFresh: vi.fn(),
  touchAccount: vi.fn(),
  rollDeviceCookie: vi.fn(),
  getOrProduceSessionUser: vi.fn(),
  mintUserSession: vi.fn(),
  setSessionCookie: vi.fn(),
}));

vi.mock('$lib/server/auth/device', () => ({
  getDeviceId: h.getDeviceId,
  isLinkedAndFresh: h.isLinkedAndFresh,
  touchAccount: h.touchAccount,
  rollDeviceCookie: h.rollDeviceCookie,
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduceSessionUser,
}));
vi.mock('$lib/server/auth/session', () => ({
  mintUserSession: h.mintUserSession,
  setSessionCookie: h.setSessionCookie,
}));

import { POST } from '../+server';

const DEVICE = 'device-xyz';
const ACTIVE = 100;
const TARGET = 200;

function makeEvent(user: Record<string, unknown> | undefined = { id: ACTIVE }) {
  return {
    request: new Request('https://auth.civitai.com/api/auth/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: TARGET }),
    }),
    cookies: {},
    locals: { user },
  } as never;
}

// Which user ids are linked to the device.
const linked = (...ids: number[]) =>
  h.isLinkedAndFresh.mockImplementation(async (_d: string, id: number) => ids.includes(id));

const statusOf = async (event: never) => {
  try {
    return (await POST(event)).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getDeviceId.mockReturnValue(DEVICE);
  h.getOrProduceSessionUser.mockResolvedValue({ id: TARGET });
  h.mintUserSession.mockResolvedValue('new-token');
});

describe('POST /api/auth/switch — device membership', () => {
  it('200s and mints for the target when the active account and the target are both linked', async () => {
    linked(ACTIVE, TARGET);

    const res = await POST(makeEvent());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'new-token', userId: TARGET });
    expect(h.setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('403s when the target is linked but the active account is not', async () => {
    linked(TARGET);

    expect(await statusOf(makeEvent())).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
    expect(h.setSessionCookie).not.toHaveBeenCalled();
  });

  it('403s when the target is not linked', async () => {
    linked(ACTIVE);

    expect(await statusOf(makeEvent())).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });

  // Pinned on purpose: impersonation never adds the impersonated user to the device set, so switching is
  // unavailable while impersonating — impersonate/exit is the way out. Do not exempt impersonated sessions.
  it('403s while impersonating: the impersonated user is not in the device set', async () => {
    linked(900, TARGET); // 900 = the moderator's own linked account; the session user is ACTIVE (impersonated)

    expect(await statusOf(makeEvent({ id: ACTIVE, impersonatedBy: 900 }))).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });

  // Pinned on purpose: after "remove from this browser" on the current account, a fresh sign-in is required
  // before switching. Do not make the caller check optional for that case.
  it('403s after the active account was removed from this browser', async () => {
    linked(TARGET); // ACTIVE was dropped from the set by DELETE /api/auth/accounts

    expect(await statusOf(makeEvent())).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });
});
