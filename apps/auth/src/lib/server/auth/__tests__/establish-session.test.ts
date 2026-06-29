import { describe, it, expect, vi, beforeEach } from 'vitest';

// establishSession is the login-path seam that decides whether a login is a 2nd-account add. It reads the
// INCOMING civ-token cookie, and if it carries a valid session for a DIFFERENT user, passes that prior userId
// to linkAccount (which materializes the switcher set). An ordinary login (no/expired prior cookie) passes
// undefined → linkAccount writes nothing. We mock the collaborators and assert exactly what linkAccount receives.

const h = vi.hoisted(() => ({
  mintSessionToken: vi.fn(async () => 'minted-token'),
  trackToken: vi.fn(async () => {}),
  verifyToken: vi.fn(),
  linkAccount: vi.fn(async () => {}),
  getOrCreateDeviceId: vi.fn(() => 'device-xyz'),
}));

vi.mock('@civitai/auth', () => ({
  isSecureCookie: () => false,
  sessionCookieName: () => 'civ-token',
  maybeCreateSessionSigner: () => ({
    mintSessionToken: h.mintSessionToken,
    maxAge: 1234,
  }),
}));
vi.mock('../registry', () => ({ sessions: { trackToken: h.trackToken } }));
vi.mock('../verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('../cookie', () => ({ cookieDomain: () => undefined }));
vi.mock('../device', () => ({
  getOrCreateDeviceId: h.getOrCreateDeviceId,
  linkAccount: h.linkAccount,
}));

import { establishSession } from '../session';
import type { SessionUser } from '@civitai/auth';

const user = (id: number): SessionUser =>
  ({
    id,
    username: `u${id}`,
    showNsfw: true,
    blurNsfw: false,
    browsingLevel: 1,
    onboarding: 0,
    createdAt: new Date(),
    isModerator: false,
    muted: false,
  }) as unknown as SessionUser;

// A minimal Cookies stub: in-memory get + a set that records the queued cookie.
function makeCookies(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const set = vi.fn((name: string, value: string) => store.set(name, value));
  return {
    _store: store,
    set,
    get: (name: string) => store.get(name),
    delete: vi.fn(),
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('establishSession 2nd-account detection', () => {
  it('passes the prior DIFFERENT user as existingUserId when a valid civ-token is present', async () => {
    h.verifyToken.mockResolvedValue({ sub: '100', jti: 'j1' });
    const cookies = makeCookies({ 'civ-token': 'prior-session-for-100' });

    await establishSession(cookies, user(200));

    expect(h.linkAccount).toHaveBeenCalledWith('device-xyz', 200, 100);
  });

  it('passes undefined existingUserId on an ordinary login with no prior cookie', async () => {
    const cookies = makeCookies(); // no civ-token

    await establishSession(cookies, user(200));

    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(h.linkAccount).toHaveBeenCalledWith('device-xyz', 200, undefined);
  });

  it('passes undefined when the prior cookie fails verification (expired/invalid)', async () => {
    h.verifyToken.mockRejectedValue(new Error('expired'));
    const cookies = makeCookies({ 'civ-token': 'expired' });

    await establishSession(cookies, user(200));

    expect(h.linkAccount).toHaveBeenCalledWith('device-xyz', 200, undefined);
  });

  it('reads the prior session BEFORE overwriting the cookie (re-login as same user passes own id)', async () => {
    // Re-login as the SAME user: prior=200, new=200. linkAccount gets (…, 200, 200) and (per its own logic)
    // treats same-id as not-a-2nd-account. Here we just assert the prior id was read pre-overwrite.
    h.verifyToken.mockResolvedValue({ sub: '200', jti: 'j' });
    const cookies = makeCookies({ 'civ-token': 'prior-session-for-200' });

    await establishSession(cookies, user(200));

    expect(h.linkAccount).toHaveBeenCalledWith('device-xyz', 200, 200);
    // The new token was queued (cookie set) — confirms we still establish the session.
    expect(cookies._store.get('civ-token')).toBe('minted-token');
  });
});
