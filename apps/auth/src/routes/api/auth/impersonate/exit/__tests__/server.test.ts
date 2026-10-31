import { describe, it, expect, vi } from 'vitest';

// Exit hands back the moderator's own session in the same family, and leaves the hub's own cookie alone.

const h = vi.hoisted(() => ({
  mintUserSession: vi.fn(async () => 'mod-token'),
  setSessionCookie: vi.fn(),
  trackImpersonation: vi.fn(),
}));

vi.mock('$lib/server/auth/session', () => ({
  mintUserSession: h.mintUserSession,
  setSessionCookie: h.setSessionCookie,
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id }),
}));
vi.mock('$lib/server/auth/mod-activity', () => ({ trackImpersonation: h.trackImpersonation }));

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
});
