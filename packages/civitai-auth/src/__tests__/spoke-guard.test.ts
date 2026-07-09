import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the session client (no redis/jose) so we drive getSessionUser directly, and the env (hub base URL).
const h = vi.hoisted(() => ({ getSessionUser: vi.fn(), loadAuthEnv: vi.fn() }));
vi.mock('../session-client', () => ({
  createSessionClient: () => ({
    getSessionUser: h.getSessionUser,
    invalidate: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createSpokeGuard } from '../spoke-guard';
import type { SessionUser } from '../types';

const ISSUER = 'http://localhost:5173'; // http → non-secure cookie name 'civ-token'
const RETURN = 'http://localhost:3100/cases/42';
const LOGIN = `${ISSUER}/login?returnUrl=${encodeURIComponent(RETURN)}`;

const mod = { id: 1, isModerator: true } as unknown as SessionUser;
const normie = { id: 2, isModerator: false } as unknown as SessionUser;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_BASE_URL;
  process.env.AUTH_JWT_ISSUER = ISSUER; // drives isSecureCookie → cookie name 'civ-token'
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: ISSUER });
  h.getSessionUser.mockReset();
});
afterEach(() => {
  delete process.env.AUTH_JWT_ISSUER;
});

describe('createSpokeGuard', () => {
  it('→ login redirect (carrying returnUrl) when there is no session cookie; never calls the hub', async () => {
    const r = await createSpokeGuard().check('', RETURN);
    expect(r).toEqual({ status: 'login', redirect: LOGIN });
    expect(h.getSessionUser).not.toHaveBeenCalled();
  });

  it('→ login when the token does not resolve to a user', async () => {
    h.getSessionUser.mockResolvedValue(null);
    const r = await createSpokeGuard().check('civ-token=bad', RETURN);
    expect(r.status).toBe('login');
    expect(h.getSessionUser).toHaveBeenCalledWith('bad');
  });

  it('→ ok with the user when authenticated and no `require`', async () => {
    h.getSessionUser.mockResolvedValue(normie);
    expect(await createSpokeGuard().check('civ-token=t', RETURN)).toEqual({
      status: 'ok',
      user: normie,
    });
  });

  it('→ forbidden (NOT a login loop) for a logged-in user who fails `require`', async () => {
    h.getSessionUser.mockResolvedValue(normie);
    const guard = createSpokeGuard({ require: (u) => !!u.isModerator });
    expect(await guard.check('civ-token=t', RETURN)).toEqual({ status: 'forbidden', user: normie });
  });

  it('→ ok when `require` passes', async () => {
    h.getSessionUser.mockResolvedValue(mod);
    const guard = createSpokeGuard({ require: (u) => !!u.isModerator });
    expect(await guard.check('civ-token=t', RETURN)).toEqual({ status: 'ok', user: mod });
  });

  it('extracts the right cookie from a multi-cookie header', async () => {
    h.getSessionUser.mockResolvedValue(normie);
    await createSpokeGuard().check('foo=1; civ-token=the-token; bar=2', RETURN);
    expect(h.getSessionUser).toHaveBeenCalledWith('the-token');
  });

  it('honors a custom loginPath', async () => {
    const r = (await createSpokeGuard({ loginPath: '/sign-in' }).check('', RETURN)) as {
      redirect: string;
    };
    expect(r.redirect).toBe(`${ISSUER}/sign-in?returnUrl=${encodeURIComponent(RETURN)}`);
  });
});
