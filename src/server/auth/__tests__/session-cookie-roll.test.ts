import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

// The roll rule through the real getServerAuthSession → maybeRollHubCookie → setSessionCookie path: a refreshed
// token is written under the name it was read from, and a shared-slot token is never copied into the host-only
// slot. Only the hub calls (verify + refresh) are stubbed.
const h = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
  return {
    ...actual,
    createSessionClient: () => ({ getSessionUser: h.getSessionUser }),
    createSessionTokenClient: () => ({
      refresh: h.refresh,
      exchangeLegacy: vi.fn(),
      revoke: vi.fn(),
    }),
  };
});
vi.mock('../session-verifier', () => ({ isRevoked: vi.fn() }));
vi.mock('../bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));

const HOST = '__Host-civ-token';
const SHARED = '__Secure-civ-token';

// An unsigned JWT-shaped token: only its claims are decoded on this path (verification is stubbed above).
function token(claims: Record<string, unknown>) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}
const now = () => Math.floor(Date.now() / 1000);
const stale = () => token({ sub: '1', iat: now() - 2 * 24 * 3600, exp: now() + 3600 });
const fresh = () => token({ sub: '1', iat: now(), exp: now() + 30 * 24 * 3600 });

function call(cookies: Record<string, string>) {
  let store: string[] = [];
  const res = {
    getHeader: (n: string) => (n.toLowerCase() === 'set-cookie' ? store : undefined),
    setHeader: (n: string, v: string | string[]) => {
      if (n.toLowerCase() === 'set-cookie') store = Array.isArray(v) ? v : [v];
    },
  };
  const req = { headers: { host: 'civitai.com' }, cookies, url: '/' };
  return { req, res, setCookies: () => store };
}

async function run(mode: 'shared' | 'host', cookies: Record<string, string>) {
  process.env.AUTH_SESSION_COOKIE_MODE = mode;
  const { getServerAuthSession } = await import('../get-server-auth-session');
  const c = call(cookies);
  const session = await getServerAuthSession({ req: c.req as never, res: c.res as never });
  return { session, setCookies: c.setCookies() };
}

describe('session cookie roll rule', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.AUTH_LEGACY_READ;
    h.getSessionUser.mockResolvedValue({ id: 1, username: 'u' });
    h.refresh.mockResolvedValue({ token: fresh() });
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // Test 4. Host mode, a request carrying only the shared-slot token past the update age: it is served, but
  // nothing is written to the host-only slot (or anywhere). Control: rolling under the mode's name writes a
  // `__Host-` copy of the shared token.
  it('host mode serves a shared-slot token without writing it to the host-only slot', async () => {
    const { session, setCookies } = await run('host', { [SHARED]: stale() });
    expect(session?.user).toMatchObject({ id: 1 });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(setCookies.some((c) => c.startsWith(`${HOST}=`))).toBe(false);
    expect(setCookies).toEqual([]);
  });

  // Test 19. Back in shared mode after a rollback, a token read from the host-only slot through the fallback
  // is rolled in place: `__Host-`, no Domain. Controls: rolling only the mode's name never rolls it (the user
  // expires); writing with the shared writer's default puts it on `Domain=civitai.com` as `__Secure-civ-token`.
  it('shared mode rolls a host-only token in place, host-only', async () => {
    const { setCookies } = await run('shared', { [HOST]: stale(), '__Host-civ-device': 'D' });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    const written = setCookies.find((c) => c.startsWith(`${HOST}=`));
    expect(written).toBeDefined();
    expect(written).not.toMatch(/Domain=/i);
    expect(written).toMatch(/; Secure/);
    expect(setCookies.some((c) => c.startsWith(`${SHARED}=`))).toBe(false);
    const device = setCookies.find((c) => c.startsWith('__Host-civ-device='));
    expect(device).toMatch(/^__Host-civ-device=D;/);
    expect(device).not.toMatch(/Domain=/i);
  });

  it('shared mode still rolls a shared-slot token on the registrable domain, as before', async () => {
    const { setCookies } = await run('shared', { [SHARED]: stale() });
    const written = setCookies.find((c) => c.startsWith(`${SHARED}=`));
    expect(written).toMatch(/Domain=civitai\.com/);
    expect(setCookies.some((c) => c.startsWith(`${HOST}=`))).toBe(false);
  });

  it('host mode rolls a host-only token in place', async () => {
    const { setCookies } = await run('host', { [HOST]: stale(), [SHARED]: 'other' });
    const written = setCookies.find((c) => c.startsWith(`${HOST}=`));
    expect(written).toBeDefined();
    expect(written).not.toMatch(/Domain=/i);
  });
});

describe('sharedSlotNavigationSyncUrl', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  const nav = (cookies: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    method: 'GET',
    url: '/models/1?x=2',
    headers: { 'sec-fetch-mode': 'navigate' },
    cookies,
    ...extra,
  });

  it('sends a shared-slot-only navigation through the sync in host mode', async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    const { sharedSlotNavigationSyncUrl } = await import('../shared-slot-sync');
    expect(sharedSlotNavigationSyncUrl(nav({ [SHARED]: 't' }))).toBe(
      `/api/auth/authorize?returnUrl=${encodeURIComponent('/models/1?x=2')}`
    );
  });

  it('does nothing in shared mode, with a host-only cookie, or for a non-navigation', async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'shared';
    let mod = await import('../shared-slot-sync');
    expect(mod.sharedSlotNavigationSyncUrl(nav({ [SHARED]: 't' }))).toBeNull();

    vi.resetModules();
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    mod = await import('../shared-slot-sync');
    expect(mod.sharedSlotNavigationSyncUrl(nav({ [HOST]: 'h', [SHARED]: 't' }))).toBeNull();
    expect(
      mod.sharedSlotNavigationSyncUrl(
        nav({ [SHARED]: 't' }, { headers: { 'sec-fetch-mode': 'cors' } })
      )
    ).toBeNull();
    expect(mod.sharedSlotNavigationSyncUrl(nav({ [SHARED]: 't' }, { method: 'POST' }))).toBeNull();
  });
});
