import { describe, it, expect, vi, beforeEach } from 'vitest';

// The hub's `civ-token` is Domain=.civitai.com — which is ALSO civitai.com's session cookie. So a login the
// user performs to reach civitai.red used to re-point civitai.com to that account, while switching BACK on
// .red went through the seamless device switch and never touched the hub cookie. That asymmetry is the bug
// (ClickUp 868kxch09, report 2).
//
// establishSession now hands a cross-scope login's identity to /api/auth/oauth/authorize out-of-band and
// leaves the hub cookie alone. These tests pin BOTH directions: green logins must still write the cookie
// (over-fixing here would sign everyone out of civitai.com and every *.civitai.com app that reads it), and
// .red logins must not.
//
// 🔴 The returnUrl fixtures below are the REAL shape — the hub's `oauth_return` cookie, which buildHubLoginUrl
// sets to the SPOKE's own landing (`https://<spoke>/api/auth/authorize?returnUrl=<post-login>`). An earlier
// version of this suite asserted against the hub's `/api/auth/oauth/authorize?...&redirect_uri=...` instead —
// a URL that never reaches establishSession — so every test passed over a fix that never fired. Build these
// with spokeLanding(); do not hand-write a hub-side authorize URL here.

const h = vi.hoisted(() => ({
  mintSessionToken: vi.fn(async () => 'minted-token'),
  trackToken: vi.fn(async () => undefined),
  verifyToken: vi.fn(),
  linkAccount: vi.fn(async () => undefined),
  getOrCreateDeviceId: vi.fn(() => 'device-xyz'),
  issuePendingAuthz: vi.fn(async () => true),
  isFirstPartyOrigin: vi.fn(async () => true),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  isSecureCookie: () => false,
  sessionCookieName: () => 'civ-token',
  maybeCreateSessionSigner: () => ({ mintSessionToken: h.mintSessionToken, maxAge: 1234 }),
}));
vi.mock('../registry', () => ({ sessions: { trackToken: h.trackToken } }));
vi.mock('../verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('../device', () => ({
  getOrCreateDeviceId: h.getOrCreateDeviceId,
  linkAccount: h.linkAccount,
}));
vi.mock('../pending-authz', () => ({ issuePendingAuthz: h.issuePendingAuthz }));
// Stands in for the DB-backed spoke registry. session.ts imports this LAZILY (it pulls in a pg Pool built at
// module scope), so this mock is also what keeps that import from being attempted for real.
vi.mock('../../oauth/first-party', () => ({ isFirstPartyOrigin: h.isFirstPartyOrigin }));
// The hub's own cookie scope. Not `undefined` (the localhost default) — the hand-off only applies where the
// cookie is actually shared, so every case here needs a real Domain.
vi.mock('../cookie', () => ({ cookieDomain: () => '.civitai.com' }));

import { establishSession } from '../session';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionUser } from '@civitai/auth';
import type { Cookies } from '@sveltejs/kit';

const user = (id: number): SessionUser =>
  ({ id, username: `u${id}`, showNsfw: true, blurNsfw: false, browsingLevel: 1 } as SessionUser);

type CookiesStub = Cookies & { _store: Map<string, string> };
function makeCookies(initial: Record<string, string> = {}): CookiesStub {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    set: vi.fn((name: string, value: string) => void store.set(name, value)),
    get: (name: string) => store.get(name),
    getAll: () => [...store].map(([name, value]) => ({ name, value })),
    delete: vi.fn((name: string) => void store.delete(name)),
    serialize: (name: string, value: string) => `${name}=${value}`,
  };
}

/** What buildHubLoginUrl actually puts in `oauth_return`: the spoke's own authorize landing. */
const spokeLanding = (origin: string) =>
  `${origin}/api/auth/authorize?returnUrl=${encodeURIComponent('/api/auth/post-login?dest=%2F')}`;

const RED = spokeLanding('https://civitai.red');
const RED_SUBDOMAIN = spokeLanding('https://www.civitai.red');
const GREEN = spokeLanding('https://civitai.com');

beforeEach(() => {
  vi.clearAllMocks();
  h.issuePendingAuthz.mockResolvedValue(true);
  h.isFirstPartyOrigin.mockResolvedValue(true);
});

describe('a login bound for a spoke OUTSIDE the hub cookie scope', () => {
  it('does not write the hub session cookie — civitai.com keeps whoever was signed in', async () => {
    h.verifyToken.mockResolvedValue({ sub: '100', jti: 'j' });
    const cookies = makeCookies({ 'civ-token': 'green-session-for-100' });

    await establishSession(cookies, user(200), { returnUrl: RED });

    expect(cookies._store.get('civ-token')).toBe('green-session-for-100');
    expect(h.mintSessionToken).not.toHaveBeenCalled();
  });

  it('hands the identity to /authorize instead, bound to that spoke registrable domain', async () => {
    h.verifyToken.mockResolvedValue({ sub: '100', jti: 'j' });
    await establishSession(makeCookies({ 'civ-token': 'green-session-for-100' }), user(200), {
      returnUrl: RED,
    });

    expect(h.issuePendingAuthz).toHaveBeenCalledWith(expect.anything(), 200, 'civitai.red');
  });

  it('still links the account to the device set, so the .red switcher lists both', async () => {
    h.verifyToken.mockResolvedValue({ sub: '100', jti: 'j' });

    await establishSession(makeCookies({ 'civ-token': 'green-session-for-100' }), user(200), {
      returnUrl: RED,
    });

    expect(h.linkAccount).toHaveBeenCalledWith('device-xyz', 200, 100);
  });

  it('falls back to the session cookie when the hand-off could not be stored', async () => {
    // No identity anywhere would bounce the user back to /login forever. Degrading to the old behaviour is
    // strictly better than breaking the login.
    h.issuePendingAuthz.mockResolvedValue(false);

    const cookies = makeCookies();
    await establishSession(cookies, user(200), { returnUrl: RED });

    expect(cookies._store.get('civ-token')).toBe('minted-token');
  });

  it('does not hand off to an origin that is not a registered first-party spoke', async () => {
    h.isFirstPartyOrigin.mockResolvedValue(false);

    const cookies = makeCookies();
    await establishSession(cookies, user(200), { returnUrl: spokeLanding('https://evil.example') });

    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
    expect(cookies._store.get('civ-token')).toBe('minted-token');
  });

  it('binds a www host to the same domain as the apex, so the two legs still agree', async () => {
    h.verifyToken.mockResolvedValue({ sub: '100', jti: 'j' });
    await establishSession(makeCookies({ 'civ-token': 'green-session-for-100' }), user(200), {
      returnUrl: RED_SUBDOMAIN,
    });

    expect(h.issuePendingAuthz).toHaveBeenCalledWith(expect.anything(), 200, 'civitai.red');
  });
});

describe('the hand-off requires the spoke AUTHORIZE LANDING, not just a foreign first-party url', () => {
  // A createSpokeGuard app sends the raw current page URL as returnUrl. If such an app is ever on a foreign
  // registrable domain — a TrustedSpokeDomain row, no code change — handing off would give it no cookie, its
  // guard would bounce back to /login with the same returnUrl, and the login would loop forever with no error.
  // Only the /api/auth/authorize landing produces the second hop where the pending record is consumed.
  it.each([
    ['a bare page url on a foreign first-party host', 'https://civitai.red/models/123'],
    ['a spoke guard returnUrl', 'https://studio.civitai.red/queue?page=2'],
    ['the spoke callback rather than the landing', 'https://civitai.red/api/auth/callback?code=x'],
  ])('%s → no hand-off', async (_label, returnUrl) => {
    const cookies = makeCookies();

    await establishSession(cookies, user(200), { returnUrl });

    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
    expect(cookies._store.get('civ-token')).toBe('minted-token');
  });
});

describe('every other login still writes the hub session cookie', () => {
  it.each([
    ['the green spoke itself (civitai.com)', GREEN],
    ['a *.civitai.com app that READS civ-token (moderator)', 'https://moderator.civitai.com/queue'],
    ['another cookie-reading subdomain (advertising)', 'https://advertising.civitai.com/campaigns'],
    [
      'a third-party authorization (hub-RELATIVE returnUrl)',
      '/api/auth/oauth/authorize?client_id=x',
    ],
    ['a hub page', '/user/account'],
    ['a malformed returnUrl', 'http://['],
    ['a non-http scheme', 'javascript:alert(1)'],
  ])('%s', async (_label, returnUrl) => {
    const cookies = makeCookies();

    await establishSession(cookies, user(200), { returnUrl });

    expect(cookies._store.get('civ-token')).toBe('minted-token');
    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
  });

  it('a login with no returnUrl at all', async () => {
    const cookies = makeCookies();

    await establishSession(cookies, user(200));

    expect(cookies._store.get('civ-token')).toBe('minted-token');
    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
  });

  it('every login when the hub cookie is host-only (dev/localhost — nobody else shares it)', async () => {
    vi.resetModules();
    vi.doMock('../cookie', () => ({ cookieDomain: () => undefined }));
    const { establishSession: devEstablishSession } = await import('../session');

    const cookies = makeCookies();
    await devEstablishSession(cookies, user(200), { returnUrl: RED });

    expect(cookies._store.get('civ-token')).toBe('minted-token');
    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
    vi.doUnmock('../cookie');
  });
});

describe('the hand-off fires ONLY for a genuine account switch', () => {
  // Withholding the hub session is only correct when someone else's session is there to protect. Firing on a
  // plain login would sign the user out of civitai.com and every *.civitai.com app that reads civ-token —
  // apps that a single .red login previously signed them into. That is a regression, not the fix.
  it('a first login with no prior session writes the cookie as always', async () => {
    const cookies = makeCookies(); // no civ-token

    await establishSession(cookies, user(200), { returnUrl: RED });

    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
    expect(cookies._store.get('civ-token')).toBe('minted-token');
  });

  it('re-login as the SAME user writes the cookie (green is already that user)', async () => {
    h.verifyToken.mockResolvedValue({ sub: '200', jti: 'j' });
    const cookies = makeCookies({ 'civ-token': 'green-session-for-200' });

    await establishSession(cookies, user(200), { returnUrl: RED });

    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
    expect(cookies._store.get('civ-token')).toBe('minted-token');
  });

  it('an expired/invalid prior token counts as no prior session', async () => {
    h.verifyToken.mockRejectedValue(new Error('expired'));
    const cookies = makeCookies({ 'civ-token': 'expired' });

    await establishSession(cookies, user(200), { returnUrl: RED });

    expect(h.issuePendingAuthz).not.toHaveBeenCalled();
    expect(cookies._store.get('civ-token')).toBe('minted-token');
  });

  it('but a prior session for a DIFFERENT user hands off', async () => {
    h.verifyToken.mockResolvedValue({ sub: '100', jti: 'j' });
    const cookies = makeCookies({ 'civ-token': 'green-session-for-100' });

    await establishSession(cookies, user(200), { returnUrl: RED });

    expect(h.issuePendingAuthz).toHaveBeenCalledWith(expect.anything(), 200, 'civitai.red');
    expect(cookies._store.get('civ-token')).toBe('green-session-for-100');
  });
});
