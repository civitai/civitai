import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the endpoints' collaborators (producer / verifier / signer). `isInternalRequest` is left real — it
// reads AUTH_INTERNAL_TOKEN via the $env stub (process.env), set per-test below.
const h = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getOrProduce: vi.fn(),
  invalidate: vi.fn(),
  produce: vi.fn(),
  mintSessionToken: vi.fn(),
}));
vi.mock('$lib/server/auth/verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduce,
  invalidateSessionUser: h.invalidate,
  produceSessionUser: h.produce,
}));
vi.mock('$lib/server/auth/session', () => ({
  SESSION_COOKIE: 'civ-token',
  getSigner: () => ({ mintSessionToken: h.mintSessionToken }),
}));

import { GET, POST } from '../../../../routes/api/auth/identity/+server';
import { POST as DEV_LOGIN } from '../../../../routes/api/auth/dev/login/+server';

// Loosely typed (`any`): the same mock event is fed to handlers with different route generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (opts: { method?: string; auth?: string; cookie?: string; body?: unknown } = {}): any => ({
  request: new Request('http://h/api/auth/identity', {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.auth ? { authorization: opts.auth, 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }),
  cookies: { get: (n: string) => (n === 'civ-token' ? opts.cookie : undefined) },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_TOKEN = 'secret-123';
  h.verifyToken.mockResolvedValue({ sub: '5', iss: 'https://auth.test' });
  h.getOrProduce.mockResolvedValue({ id: 5, username: 'alice' });
  h.produce.mockResolvedValue({ id: 5, username: 'alice' });
  h.invalidate.mockResolvedValue(undefined);
  h.mintSessionToken.mockResolvedValue('minted.jwt.token');
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
    expect((await POST(ev({ auth: 'Bearer secret-123', body: { userId: 'nope' } }))).status).toBe(400);
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
    await expect(DEV_LOGIN(ev({ auth: 'Bearer wrong', body: { userId: 5 } }))).rejects.toMatchObject({
      status: 404,
    });
    expect(h.mintSessionToken).not.toHaveBeenCalled();
  });
});
