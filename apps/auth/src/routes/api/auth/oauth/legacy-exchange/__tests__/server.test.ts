import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Upgrade-on-read — `POST /api/auth/oauth/legacy-exchange`.
 *
 * This is the one mint path a ban has to stop. It is SILENT and it repeats: a client that ignores the
 * Set-Cookie the spoke writes re-enters it on every request, minting a fresh jti each time, which is what
 * grew a handful of accounts to tens of thousands of tracked sessions. A banned automated client would
 * otherwise keep minting and keep growing the very hash the ban has to walk.
 *
 * Deliberately NOT symmetric with interactive login: a banned user still needs a session there, to be shown
 * why they were banned and to appeal. So this test pins the asymmetry, not a general "banned users get no
 * session" rule.
 */

const h = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getOrProduceSessionUser: vi.fn(),
  mintUserSession: vi.fn(),
  touchAccount: vi.fn(),
  isInternalRequest: vi.fn(),
}));

vi.mock('$lib/server/auth/verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduceSessionUser,
}));
vi.mock('$lib/server/auth/session', () => ({ mintUserSession: h.mintUserSession }));
vi.mock('$lib/server/auth/device', () => ({
  getDeviceId: () => 'dev-1',
  touchAccount: h.touchAccount,
}));
vi.mock('$lib/server/auth/internal', () => ({ isInternalRequest: h.isInternalRequest }));

const call = async () => {
  const { POST } = await import('../+server');
  return POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/legacy-exchange', {
      method: 'POST',
      body: JSON.stringify({ legacyToken: 'legacy.jwe' }),
    }),
    cookies: { get: () => undefined },
  } as never);
};

describe('legacy-exchange ban gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isInternalRequest.mockReturnValue(true);
    h.verifyToken.mockResolvedValue({ sub: '42' });
    h.mintUserSession.mockResolvedValue('fresh.civ.jwt');
  });

  it('mints for an ordinary account', async () => {
    h.getOrProduceSessionUser.mockResolvedValue({ id: 42 });
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.mintUserSession).toHaveBeenCalled();
  });

  it('refuses to mint for a BANNED account', async () => {
    h.getOrProduceSessionUser.mockResolvedValue({ id: 42, bannedAt: new Date() });
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });

  it('refuses to mint for a DELETED account', async () => {
    h.getOrProduceSessionUser.mockResolvedValue({ id: 42, deletedAt: new Date() });
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });
});
