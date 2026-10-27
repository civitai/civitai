import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only an active moderator may start impersonation: one whose own account carries no bannedAt or deletedAt.
// The real `readUserId` runs; the session collaborators and the audit write are stubbed.

const h = vi.hoisted(() => ({
  getOrProduceSessionUser: vi.fn(),
  mintUserSession: vi.fn(),
  setSessionCookie: vi.fn(),
  trackImpersonation: vi.fn(),
}));

vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduceSessionUser,
}));
vi.mock('$lib/server/auth/session', () => ({
  mintUserSession: h.mintUserSession,
  setSessionCookie: h.setSessionCookie,
}));
vi.mock('$lib/server/auth/mod-activity', () => ({
  trackImpersonation: h.trackImpersonation,
}));

import { POST } from '../+server';

const MOD = 100;
const TARGET = 200;

const activeMod = { id: MOD, isModerator: true, permissions: ['impersonation'] };

function makeEvent(user: Record<string, unknown> | undefined, userId = TARGET) {
  return {
    request: new Request('https://auth.civitai.com/api/auth/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    cookies: {},
    locals: { user },
  } as never;
}

const statusOf = async (event: never) => {
  try {
    return (await POST(event)).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getOrProduceSessionUser.mockResolvedValue({ id: TARGET });
  h.mintUserSession.mockResolvedValue('imp-token');
});

describe('POST /api/auth/impersonate — moderator account state', () => {
  it('200s and mints for an active moderator with the impersonation permission', async () => {
    const res = await POST(makeEvent(activeMod));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'imp-token', userId: TARGET });
    expect(h.mintUserSession).toHaveBeenCalledWith({ id: TARGET }, { impersonatedBy: MOD });
    expect(h.trackImpersonation).toHaveBeenCalledWith(MOD, TARGET, 'on');
  });

  it('403s for a banned moderator and mints nothing', async () => {
    expect(await statusOf(makeEvent({ ...activeMod, bannedAt: new Date('2026-01-01') }))).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
    expect(h.trackImpersonation).not.toHaveBeenCalled();
  });

  it('403s for a deleted moderator and mints nothing', async () => {
    expect(await statusOf(makeEvent({ ...activeMod, deletedAt: new Date('2026-01-01') }))).toBe(
      403
    );
    expect(h.mintUserSession).not.toHaveBeenCalled();
    expect(h.trackImpersonation).not.toHaveBeenCalled();
  });

  it('403s for a moderator without the impersonation permission', async () => {
    expect(await statusOf(makeEvent({ ...activeMod, permissions: [] }))).toBe(403);
  });

  it('401s with no session user', async () => {
    expect(await statusOf(makeEvent(undefined))).toBe(401);
  });
});

describe('POST /api/auth/impersonate — target', () => {
  it.each([-1, 0])('403s for target %i and mints no session', async (userId) => {
    expect(await statusOf(makeEvent(activeMod, userId))).toBe(403);
    expect(h.getOrProduceSessionUser).not.toHaveBeenCalled();
    expect(h.mintUserSession).not.toHaveBeenCalled();
    expect(h.trackImpersonation).not.toHaveBeenCalled();
  });
});
