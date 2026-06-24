import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the endpoints' collaborators (producer / verifier / signer). `isInternalRequest` is left real — it
// reads AUTH_INTERNAL_TOKEN via the $env stub (process.env), set per-test below.
const h = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getOrProduce: vi.fn(),
  invalidate: vi.fn(),
  produce: vi.fn(),
  mintSessionToken: vi.fn(),
  mintUserSession: vi.fn(),
  invalidateAll: vi.fn(),
}));
vi.mock('$lib/server/auth/verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduce,
  invalidateSessionUser: h.invalidate,
  produceSessionUser: h.produce,
}));
vi.mock('$lib/server/auth/registry', () => ({ sessions: { invalidateAll: h.invalidateAll } }));
vi.mock('$lib/server/auth/session', () => ({
  SESSION_COOKIE: 'civ-token',
  getSigner: () => ({ mintSessionToken: h.mintSessionToken }),
  mintUserSession: h.mintUserSession,
}));

import { GET, POST } from '../../../../routes/api/auth/identity/+server';
import { POST as DEV_LOGIN } from '../../../../routes/api/auth/dev/login/+server';
import { POST as LEGACY_EXCHANGE } from '../../../../routes/api/auth/oauth/legacy-exchange/+server';

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

describe('POST /api/auth/oauth/legacy-exchange (upgrade-on-read)', () => {
  it('401 without a valid internal token (never re-decodes or mints)', async () => {
    const res = await LEGACY_EXCHANGE(
      ev({ auth: 'Bearer wrong', body: { legacyToken: 'legacy.jwe' } })
    );
    expect(res.status).toBe(401);
    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });

  it('400 when no legacyToken is supplied', async () => {
    expect((await LEGACY_EXCHANGE(ev({ auth: 'Bearer secret-123', body: {} }))).status).toBe(400);
    expect(h.verifyToken).not.toHaveBeenCalled();
  });

  it('re-decodes the legacy cookie and mints a civ-token for the SAME user', async () => {
    const res = await LEGACY_EXCHANGE(
      ev({ auth: 'Bearer secret-123', body: { legacyToken: 'legacy.jwe' } })
    );
    expect(res.status).toBe(200);
    // Returns the minted civ-token PLUS a deviceId (no civ-device cookie in this request → the handler mints
    // one via randomUUID) so the spoke can set civ-device on the upgraded session, matching establishSession.
    expect(await res.json()).toEqual({ token: 'civ.minted.jwt', deviceId: expect.any(String) });
    expect(h.verifyToken).toHaveBeenCalledWith('legacy.jwe');
    expect(h.getOrProduce).toHaveBeenCalledWith(5);
    expect(h.mintUserSession).toHaveBeenCalledWith({ id: 5, username: 'alice' });
  });

  it('NEVER trusts a caller-supplied userId — only the decoded cookie identity', async () => {
    await LEGACY_EXCHANGE(
      ev({ auth: 'Bearer secret-123', body: { legacyToken: 'legacy.jwe', userId: 999 } })
    );
    // 5 comes from verifyToken (the cookie), not the 999 in the body.
    expect(h.getOrProduce).toHaveBeenCalledWith(5);
    expect(h.getOrProduce).not.toHaveBeenCalledWith(999);
  });

  it('401 when the legacy cookie fails to decode (never mints)', async () => {
    h.verifyToken.mockResolvedValue(null);
    const res = await LEGACY_EXCHANGE(
      ev({ auth: 'Bearer secret-123', body: { legacyToken: 'bad' } })
    );
    expect(res.status).toBe(401);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });

  it('404 when the decoded user no longer exists', async () => {
    h.getOrProduce.mockResolvedValue(null);
    const res = await LEGACY_EXCHANGE(
      ev({ auth: 'Bearer secret-123', body: { legacyToken: 'legacy.jwe' } })
    );
    expect(res.status).toBe(404);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/dev/login (dev-gated)', () => {
  it('mints a session token for the userId with a valid internal token', async () => {
    const res = await DEV_LOGIN(ev({ auth: 'Bearer secret-123', body: { userId: 5 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'minted.jwt.token', userId: 5 });
    expect(h.mintSessionToken).toHaveBeenCalled();
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
