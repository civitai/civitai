import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

// getServerAuthSession counts each hub session by the cookie slot it was read from. Only the hub verify is stubbed.
const h = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
  return {
    ...actual,
    createSessionClient: () => ({ getSessionUser: h.getSessionUser }),
    createSessionTokenClient: () => ({ refresh: vi.fn(), revoke: vi.fn() }),
  };
});

const HOST = '__Host-civ-token';
const SHARED = '__Secure-civ-token';

function token() {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none' })}.${b64({ sub: '1', iat: now, exp: now + 3600 })}.sig`;
}

// ~/server/prom/client is stubbed in the test setup: read the incs of the counter session-metrics registered,
// skipping the zero-value seeds.
async function slotCounts(cookies: Record<string, string>) {
  const { getServerAuthSession } = await import('../get-server-auth-session');
  const prom = await import('~/server/prom/client');
  const register = vi.mocked(prom.registerCounterWithLabels);
  const i = register.mock.calls.findLastIndex(([o]) => o.name === 'session_cookie_slot_total');
  const counter = register.mock.results[i]?.value as { inc: ReturnType<typeof vi.fn> } | undefined;
  const req = { headers: { host: 'civitai.com' }, cookies, url: '/' };
  const res = { getHeader: () => undefined, setHeader: vi.fn() };
  const session = await getServerAuthSession({ req: req as never, res: res as never });
  expect(session?.user).toMatchObject({ id: 1 });
  const counts: Record<string, number> = { host: 0, shared: 0 };
  for (const [labels, by] of counter?.inc.mock.calls ?? [])
    if (by === undefined) counts[labels.slot]++;
  return counts;
}

describe('session cookie slot metric', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.AUTH_LEGACY_READ;
    h.getSessionUser.mockResolvedValue({ id: 1, username: 'u' });
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('counts a request carrying only the shared cookie as shared', async () => {
    expect(await slotCounts({ [SHARED]: token() })).toEqual({ host: 0, shared: 1 });
  });

  it('counts a request carrying the host-only cookie as host', async () => {
    expect(await slotCounts({ [HOST]: token() })).toEqual({ host: 1, shared: 0 });
  });
});
