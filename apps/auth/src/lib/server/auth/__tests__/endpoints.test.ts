import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Mock the endpoints' collaborators (producer / verifier / signer). `isInternalRequest` is left real — it
// reads AUTH_INTERNAL_TOKEN via the $env stub (process.env), set per-test below.
const h = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getOrProduce: vi.fn(),
  invalidate: vi.fn(),
  produce: vi.fn(),
  mintSessionToken: vi.fn(),
  mintUserSession: vi.fn(),
  mintSession: vi.fn(),
  invalidateAll: vi.fn(),
  logToAxiom: vi.fn<(record: Record<string, unknown>) => Promise<undefined>>(async () => undefined),
}));
vi.mock('$lib/server/auth/verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduce,
  invalidateSessionUser: h.invalidate,
  produceSessionUser: h.produce,
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: h.logToAxiom }));
vi.mock('$lib/server/auth/registry', () => ({ sessions: { invalidateAll: h.invalidateAll } }));
vi.mock('$lib/server/auth/session', () => ({
  SESSION_COOKIE: 'civ-token',
  readHubSession: (cookies: { get: (n: string) => string | undefined }) => {
    const value = cookies.get('civ-token');
    return value ? { value, name: 'civ-token', slot: 'shared' } : null;
  },
  getSigner: () => ({ mintSessionToken: h.mintSessionToken }),
  mintUserSession: h.mintUserSession,
  mintSession: h.mintSession,
  refuseModerationAccount: () => undefined,
}));

import { GET, POST } from '../../../../routes/api/auth/identity/+server';
import { POST as DEV_LOGIN } from '../../../../routes/api/auth/dev/login/+server';

// Loosely typed (`any`): the same mock event is fed to handlers with different route generics.
const ev = (
  opts: {
    method?: string;
    auth?: string;
    cookie?: string;
    body?: unknown;
    userId?: string | number;
  } = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => {
  const url = new URL('http://h/api/auth/identity');
  if (opts.userId !== undefined) url.searchParams.set('userId', String(opts.userId));
  return {
    request: new Request(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.auth ? { authorization: opts.auth, 'content-type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    url,
    cookies: { get: (n: string) => (n === 'civ-token' ? opts.cookie : undefined) },
    platform: { req: { socket: { remoteAddress: '10.0.0.9' } } },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_TOKEN = 'secret-123';
  h.verifyToken.mockResolvedValue({ sub: '5', iss: 'https://auth.test' });
  h.getOrProduce.mockResolvedValue({ id: 5, username: 'alice' });
  h.produce.mockResolvedValue({ id: 5, username: 'alice' });
  h.invalidate.mockResolvedValue(undefined);
  h.mintSessionToken.mockResolvedValue('minted.jwt.token');
  h.mintUserSession.mockResolvedValue('civ.minted.jwt');
  h.mintSession.mockResolvedValue({ token: 'civ.minted.jwt', family: 'f' });
});

describe('GET /api/auth/identity', () => {
  it('verifies the Bearer and returns the produced user', async () => {
    const res = await GET(ev({ auth: 'Bearer usertoken' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 5 });
    expect(h.getOrProduce).toHaveBeenCalledWith(5);
  });

  it('falls back to the session cookie when there is no Bearer', async () => {
    const res = await GET(ev({ cookie: 'cookietoken' }));
    expect(res.status).toBe(200);
    expect(h.verifyToken).toHaveBeenCalledWith('cookietoken');
  });

  it('401 when no token is presented', async () => {
    expect((await GET(ev({}))).status).toBe(401);
  });

  it('401 when the token fails verification', async () => {
    h.verifyToken.mockResolvedValue(null);
    expect((await GET(ev({ auth: 'Bearer bad' }))).status).toBe(401);
    expect(h.getOrProduce).not.toHaveBeenCalled();
  });

  it('404 when there is no such user', async () => {
    h.getOrProduce.mockResolvedValue(null);
    expect((await GET(ev({ auth: 'Bearer usertoken' }))).status).toBe(404);
  });
});

describe('GET /api/auth/identity?userId= (internal by-userId read-through)', () => {
  it('returns the produced user for an internal caller (read-through, no token)', async () => {
    const res = await GET(ev({ auth: 'Bearer secret-123', userId: 5 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 5 });
    expect(h.getOrProduce).toHaveBeenCalledWith(5);
    expect(h.verifyToken).not.toHaveBeenCalled(); // by-userId path never verifies a token
  });

  it('401 without a valid internal token (and does not resolve)', async () => {
    const res = await GET(ev({ auth: 'Bearer wrong', userId: 5 }));
    expect(res.status).toBe(401);
    expect(h.getOrProduce).not.toHaveBeenCalled();
  });

  it('400 on a non-numeric userId', async () => {
    expect((await GET(ev({ auth: 'Bearer secret-123', userId: 'nope' }))).status).toBe(400);
  });

  it('404 when there is no such user', async () => {
    h.getOrProduce.mockResolvedValue(null);
    expect((await GET(ev({ auth: 'Bearer secret-123', userId: 5 }))).status).toBe(404);
  });
});

describe('POST /api/auth/identity (invalidate / refresh)', () => {
  it('401 without a valid internal token (and does not bust)', async () => {
    const res = await POST(ev({ auth: 'Bearer wrong', body: { userId: 5 } }));
    expect(res.status).toBe(401);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('busts the cache and returns 204 by default', async () => {
    const res = await POST(ev({ auth: 'Bearer secret-123', body: { userId: 5 } }));
    expect(res.status).toBe(204);
    expect(h.invalidate).toHaveBeenCalledWith(5);
    expect(h.produce).not.toHaveBeenCalled();
  });

  it('busts AND re-produces when refresh:true', async () => {
    const res = await POST(ev({ auth: 'Bearer secret-123', body: { userId: 5, refresh: true } }));
    expect(res.status).toBe(200);
    expect(h.invalidate).toHaveBeenCalledWith(5);
    expect(h.produce).toHaveBeenCalledWith(5);
    expect(await res.json()).toMatchObject({ id: 5 });
  });

  it('400 on a non-numeric userId', async () => {
    expect((await POST(ev({ auth: 'Bearer secret-123', body: { userId: 'nope' } }))).status).toBe(
      400
    );
  });

  it('scope:"all" sets the global cutoff and returns 204 (no per-user bust)', async () => {
    const res = await POST(ev({ auth: 'Bearer secret-123', body: { scope: 'all' } }));
    expect(res.status).toBe(204);
    expect(h.invalidateAll).toHaveBeenCalledTimes(1);
    expect(h.invalidate).not.toHaveBeenCalled(); // mass path does not touch per-user busts
  });

  it('scope:"all" still requires the internal token', async () => {
    const res = await POST(ev({ auth: 'Bearer wrong', body: { scope: 'all' } }));
    expect(res.status).toBe(401);
    expect(h.invalidateAll).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/identity audit record', () => {
  const audits = () =>
    h.logToAxiom.mock.calls
      .map(([record]) => record)
      .filter((record) => record.name === 'identity-invalidate-audit')
      .map((record) => record.payload);
  const withCaller = (event: ReturnType<typeof ev>) => {
    event.request.headers.set('cf-connecting-ip', '203.0.113.7');
    event.request.headers.set('user-agent', 'curl/8.4.0');
    return event;
  };

  // The refused-call cap is per process; each test starts in a fresh window.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.advanceTimersByTime(60_000);
    h.logToAxiom.mockClear();
  });

  it('records an accepted scope:"all" call with its caller', async () => {
    await POST(withCaller(ev({ auth: 'Bearer secret-123', body: { scope: 'all' } })));
    expect(audits()).toEqual([
      expect.objectContaining({
        internal: true,
        status: 204,
        scope: 'all',
        clientIp: '203.0.113.7',
        socketIp: '10.0.0.9',
        userAgent: 'curl/8.4.0',
      }),
    ]);
    expect(JSON.stringify(audits())).not.toContain('secret-123');
  });

  it('records a refused call without the presented token', async () => {
    await POST(withCaller(ev({ auth: 'Bearer wrong-token-value', body: { scope: 'all' } })));
    expect(audits()).toEqual([
      expect.objectContaining({ internal: false, status: 401, scope: 'all' }),
    ]);
    const serialized = JSON.stringify(audits());
    expect(serialized).not.toContain('wrong-token-value');
    expect(serialized).not.toContain('secret-123');
  });

  it('does not record an accepted per-user bust', async () => {
    await POST(ev({ auth: 'Bearer secret-123', body: { userId: 5 } }));
    expect(audits()).toHaveLength(0);
  });

  it('records a mass invalidation that fails as a 500, and still fails', async () => {
    h.invalidateAll.mockRejectedValueOnce(new Error('registry down'));
    await expect(POST(ev({ auth: 'Bearer secret-123', body: { scope: 'all' } }))).rejects.toThrow(
      'registry down'
    );
    expect(audits()).toEqual([expect.objectContaining({ internal: true, status: 500 })]);
  });

  it('writes the first 20 refused calls in a minute, then one count when the minute ends', async () => {
    for (let i = 0; i < 25; i++)
      await POST(withCaller(ev({ auth: 'Bearer wrong', body: { scope: 'all' } })));
    expect(audits()).toHaveLength(20);

    vi.advanceTimersByTime(60_000);
    expect(audits()).toHaveLength(21);
    expect(audits()[20]).toMatchObject({
      summary: true,
      internal: false,
      dropped: 5,
      byKey: { post: 5 },
      // The socket peer, not the caller's cf-connecting-ip.
      clientIps: ['10.0.0.9'],
    });
  });

  it('never drops an accepted mass invalidation', async () => {
    for (let i = 0; i < 25; i++)
      await POST(ev({ auth: 'Bearer secret-123', body: { scope: 'all' } }));
    vi.advanceTimersByTime(60_000);
    expect(audits()).toEqual(Array(25).fill(expect.objectContaining({ internal: true })));
  });
});

describe('POST /api/auth/dev/login (dev-gated)', () => {
  it('mints a session token for the userId with a valid internal token', async () => {
    const res = await DEV_LOGIN(ev({ auth: 'Bearer secret-123', body: { userId: 5 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'civ.minted.jwt', userId: 5 });
    expect(h.mintUserSession).toHaveBeenCalledWith({ id: 5 });
  });

  it('404 (throws) without a valid internal token', async () => {
    await expect(
      DEV_LOGIN(ev({ auth: 'Bearer wrong', body: { userId: 5 } }))
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(h.mintSessionToken).not.toHaveBeenCalled();
  });
});
