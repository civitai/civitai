import { describe, it, expect, vi } from 'vitest';

// Exit hands back the moderator's own session in the same family, and leaves the hub's own cookie alone.

const h = vi.hoisted(() => ({
  getOrProduceSessionUser: vi.fn(async (id: number): Promise<Record<string, unknown>> => ({ id })),
  mintUserSession: vi.fn(async () => 'mod-token'),
  setSessionCookie: vi.fn(),
  trackImpersonation: vi.fn(),
  invalidateToken: vi.fn(),
}));

vi.mock('$lib/server/auth/session', () => ({
  mintUserSession: h.mintUserSession,
  setSessionCookie: h.setSessionCookie,
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduceSessionUser,
}));
vi.mock('$lib/server/auth/mod-activity', () => ({ trackImpersonation: h.trackImpersonation }));
vi.mock('$lib/server/auth/registry', () => ({
  sessions: { invalidateToken: h.invalidateToken },
}));

import { POST } from '../+server';

describe('POST /api/auth/impersonate/exit', () => {
  it("returns the moderator's own session in the same family without setting the hub cookie", async () => {
    const session = { sub: '200', jti: 'j', sid: 'family-m', impersonatedBy: 100 };
    const res = await POST({
      cookies: {},
      locals: { user: { id: 200 }, impersonatedBy: 100, session },
    } as never);

    expect(await res.json()).toEqual({ token: 'mod-token', userId: 100 });
    expect(h.mintUserSession).toHaveBeenCalledWith(
      { id: 100 },
      { parent: session, clearImpersonation: true }
    );
    expect(h.setSessionCookie).not.toHaveBeenCalled();
    expect(h.trackImpersonation).toHaveBeenCalledWith(100, 200, 'off');
  });

  it.each([
    ['banned', { bannedAt: new Date('2026-01-01') }],
    ['deleted', { deletedAt: new Date('2026-01-01') }],
  ])('ends the session and mints nothing when the moderator is %s', async (_, state) => {
    h.mintUserSession.mockClear();
    h.invalidateToken.mockClear();
    h.getOrProduceSessionUser.mockResolvedValueOnce({ id: 100, ...state });
    const session = { sub: '200', jti: 'j', sid: 'family-m', impersonatedBy: 100 };
    const status = await Promise.resolve(
      POST({
        cookies: {},
        locals: { user: { id: 200 }, impersonatedBy: 100, session, tokenId: 'j' },
      } as never)
    ).then(
      (r) => r.status,
      (e: { status: number }) => e.status
    );
    expect(status).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
    expect(h.invalidateToken).toHaveBeenCalledWith('j', 200);
  });
});
