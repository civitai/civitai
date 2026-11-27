import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

// AUTH_SESSION_COOKIE_MODE_BY_SITE=civitai.red:host on a deployment whose global mode is shared: civitai.red runs
// host mode end to end (read, roll, write, sync, sign-in retry, sign-out), and civitai.com is unchanged. Only the hub
// calls are stubbed.
const h = vi.hoisted(() => ({ getSessionUser: vi.fn(), refresh: vi.fn(), revoke: vi.fn() }));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
  return {
    ...actual,
    createSessionClient: () => ({ getSessionUser: h.getSessionUser }),
    createSessionTokenClient: () => ({ refresh: h.refresh, revoke: h.revoke }),
  };
});
vi.mock('../session-verifier', () => ({ isRevoked: vi.fn(), confirmElevatedRevocation: vi.fn() }));
vi.mock('../bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/shared/constants/generation.constants', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generationServiceCookie: { name: 'civitai-generation' },
}));
vi.mock('~/server/auth/oauth-bridge', () => ({
  HUB_BASE_URL: 'https://auth.test',
  resolveSelfOrigin: () => 'https://civitai.red',
  safePath: (p: unknown) => (typeof p === 'string' ? p : '/'),
  clearBridgeCookie: () => 'oauth_bridge=; Path=/; Max-Age=0; SameSite=Lax',
  buildAuthorizeRedirect: () => ({ location: 'https://auth.test/authorize', setCookies: [] }),
}));

const HOST = '__Host-civ-token';
const SHARED = '__Secure-civ-token';
const SHARED_DEVICE = '__Secure-civ-device';

function token(claims: Record<string, unknown>) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}
const now = () => Math.floor(Date.now() / 1000);
const stale = () => token({ sub: '1', iat: now() - 2 * 24 * 3600, exp: now() + 3600 });
const fresh = () => token({ sub: '1', iat: now(), exp: now() + 30 * 24 * 3600 });

function response() {
  let store: string[] = [];
  return {
    res: {
      getHeader: (n: string) => (n.toLowerCase() === 'set-cookie' ? store : undefined),
      setHeader: (n: string, v: string | string[]) => {
        if (n.toLowerCase() === 'set-cookie') store = Array.isArray(v) ? v : [v];
      },
      status: () => undefined,
      send: () => undefined,
      redirect: () => undefined,
    },
    setCookies: () => store,
  };
}

/** The jar after a response's Set-Cookie headers: an expiry (Max-Age=0) removes its name. */
const applyExpiries = (jar: Record<string, string>, setCookies: string[]) =>
  Object.fromEntries(
    Object.entries(jar).filter(
      ([name]) => !setCookies.some((c) => c.startsWith(`${name}=`) && /Max-Age=0/.test(c))
    )
  );

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  process.env.AUTH_SESSION_COOKIE_MODE = 'shared';
  process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE = 'civitai.red:host';
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.AUTH_LEGACY_READ;
  h.getSessionUser.mockResolvedValue({ id: 1, username: 'u' });
  h.refresh.mockResolvedValue({ token: fresh() });
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function session(host: string, cookies: Record<string, string>) {
  const { getServerAuthSession } = await import('../get-server-auth-session');
  const r = response();
  const req = { headers: { host }, cookies, url: '/' };
  const s = await getServerAuthSession({ req: req as never, res: r.res as never });
  return { session: s, setCookies: r.setCookies() };
}

describe('reading the session', () => {
  it('civitai.red never takes a shared-slot cookie as the session; civitai.com still does', async () => {
    const red = await session('civitai.red', { [SHARED]: fresh() });
    expect(red.session).toBeNull();
    expect(h.getSessionUser).not.toHaveBeenCalled();

    const com = await session('civitai.com', { [SHARED]: fresh() });
    expect(com.session?.user).toMatchObject({ id: 1 });
  });

  it('with valid sessions for different users in both slots, civitai.red reads the host-only one', async () => {
    h.getSessionUser.mockImplementation(async (t: string) =>
      t === 'tok-a' ? { id: 1, username: 'a' } : t === 'tok-x' ? { id: 2, username: 'x' } : null
    );
    const jar = { [HOST]: 'tok-a', [SHARED]: 'tok-x' };
    expect((await session('civitai.red', jar)).session?.user).toMatchObject({ id: 1 });
    // Control: a site listed shared reads the shared slot first, so the same jar is user X.
    vi.resetModules();
    process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE = 'civitai.red:shared';
    expect((await session('civitai.red', jar)).session?.user).toMatchObject({ id: 2 });
  });

  it('civitai.red rolls its host-only token in place and expires a shared copy at both scopes', async () => {
    const { session: s, setCookies } = await session('civitai.red', {
      [HOST]: stale(),
      [SHARED]: 'other',
      [SHARED_DEVICE]: 'dev',
    });
    expect(s?.user).toMatchObject({ id: 1 });
    expect(setCookies.find((c) => c.startsWith(`${HOST}=`))).not.toMatch(/Domain=/);
    expect(setCookies.filter((c) => !c.startsWith(`${HOST}=`))).toEqual([
      `${SHARED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${SHARED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure; Domain=civitai.red`,
      `${SHARED_DEVICE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${SHARED_DEVICE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure; Domain=civitai.red`,
    ]);
  });
});

it('a site listed shared rolls its shared-slot token while the global mode is host', async () => {
  process.env.AUTH_SESSION_COOKIE_MODE = 'host';
  process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE = 'civitai.red:shared';
  const { setCookies } = await session('civitai.red', { [SHARED]: stale() });
  expect(setCookies.find((c) => c.startsWith(`${SHARED}=`))).toMatch(/; Domain=civitai\.red;/);
});

describe('writing the session (login callback, switch)', () => {
  it('civitai.red writes the host-only slot and expires the shared slot at both scopes', async () => {
    const { setSessionCookie } = await import('../civ-cookie');
    const r = response();
    setSessionCookie(r.res, fresh(), {
      host: 'civitai.red',
      deviceCookie: 'D',
      requestCookies: { [SHARED]: 's', [SHARED_DEVICE]: 'sd' },
    });
    const [session, device, ...expiries] = r.setCookies();
    expect(session).toMatch(new RegExp(`^${HOST}=.*; Secure; Max-Age=\\d+$`));
    expect(device).toMatch(
      /^__Host-civ-device=D; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=\d+$/
    );
    expect(expiries).toEqual([
      `${SHARED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${SHARED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure; Domain=civitai.red`,
      `${SHARED_DEVICE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${SHARED_DEVICE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure; Domain=civitai.red`,
    ]);
  });

  it('the sign-in retry on civitai.red looks for the host-only cookie, not a shared one', async () => {
    const { default: authorize } = await import('~/pages/api/auth/authorize');
    const { POST_LOGIN_MARKER, LOGIN_RETRY_COOKIE } = await import('../civ-cookie');
    const r = response();
    const req = {
      headers: { host: 'civitai.red' },
      cookies: { [POST_LOGIN_MARKER]: '1', [SHARED]: 's' },
      query: {},
    };
    authorize(req as never, r.res as never);
    // The callback's host-only cookie did not land: this is the first miss, so a retry is counted.
    expect(r.setCookies()).toContain(
      `${LOGIN_RETRY_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=120`
    );
  });
});

describe('clearing and forwarding on civitai.red', () => {
  it('the sign-in loop reset also expires a shared-slot device id, at both scopes', async () => {
    const { clearAllSessionCookies } = await import('../civ-cookie');
    const red = clearAllSessionCookies('civitai.red');
    expect(red).toContain(`${SHARED_DEVICE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
    expect(red).toContain(
      `${SHARED_DEVICE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.red`
    );
  });

  it('Training Studio is sent only the host-only session', async () => {
    const { sessionCookiesOf } = await import('~/server/services/training-studio-forward.service');
    const header = `${SHARED}=s; ${HOST}=h; other=1`;
    expect(sessionCookiesOf(header, 'civitai.red')).toBe(`${HOST}=h`);
    expect(sessionCookiesOf(header, 'civitai.com')).toBe(`${SHARED}=s; ${HOST}=h`);
  });
});

describe('the server render on civitai.red', () => {
  it('looks the session up without the shared slot, though it asks under the internal host', async () => {
    const { settingsBootstrapRequest } = await import(
      '~/server/services/settings-bootstrap.service'
    );
    const page = (host: string) =>
      settingsBootstrapRequest(
        {
          headers: { host, cookie: `${SHARED}=s; ${HOST}=h` },
          cookies: { [SHARED]: 's', [HOST]: 'h' },
        } as never,
        { host: 'web.internal:3000' }
      );
    const red = page('civitai.red');
    expect(red.headers.host).toBe('web.internal:3000');
    expect(red.cookies).toEqual({ [HOST]: 'h' });
    expect(red.headers.cookie).toBe(`${HOST}=h`);
    const com = page('civitai.com');
    expect(com.cookies).toEqual({ [SHARED]: 's', [HOST]: 'h' });
    expect(com.headers.cookie).toBe(`${SHARED}=s; ${HOST}=h`);
  });
});

describe('shared-slot sync on civitai.red', () => {
  const nav = (cookies: Record<string, string>) => ({
    method: 'GET',
    url: '/models/1',
    headers: { host: 'civitai.red', 'sec-fetch-mode': 'navigate' },
    cookies,
    // A host-only site never reads the shared slot as its session, so it syncs on the cookie alone.
    signedIn: false,
  });

  it('syncs a shared-only browser once: the redirect expires the shared cookies at both scopes', async () => {
    const { sharedSlotNavigationSyncUrl } = await import('../shared-slot-sync');
    let jar: Record<string, string> = { [SHARED]: 's', [SHARED_DEVICE]: 'sd' };
    const first = sharedSlotNavigationSyncUrl(nav(jar));
    expect(first?.location).toBe(
      `/api/auth/authorize?returnUrl=${encodeURIComponent('/models/1')}`
    );
    expect(first?.setCookies).toEqual([
      `${SHARED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${SHARED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure; Domain=civitai.red`,
      `${SHARED_DEVICE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${SHARED_DEVICE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure; Domain=civitai.red`,
    ]);
    // The hub had no session to send back (signed out there): the next navigation does not bounce again.
    jar = applyExpiries(jar, first!.setCookies);
    expect(sharedSlotNavigationSyncUrl(nav(jar))).toBeNull();
  });

  it('stops once the host-only cookie is present', async () => {
    const { sharedSlotNavigationSyncUrl } = await import('../shared-slot-sync');
    expect(sharedSlotNavigationSyncUrl(nav({ [SHARED]: 's', [HOST]: 'h' }))).toBeNull();
  });
});

describe('signing out on civitai.red', () => {
  it('revokes a shared-slot token it is carrying, though it never read it as the session', async () => {
    const { default: logout } = await import('~/pages/api/auth/logout');
    const r = response();
    await logout(
      {
        query: {},
        cookies: { [SHARED]: 'shared-tok', [SHARED_DEVICE]: 'sd' },
        headers: { host: 'civitai.red', 'x-forwarded-proto': 'https' },
      } as never,
      r.res as never
    );
    expect(h.revoke).toHaveBeenCalledWith('shared-tok', { deviceId: 'sd' });
  });
});
