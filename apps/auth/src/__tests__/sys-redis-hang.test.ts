import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// With the sys redis accepting commands and never answering, the identity endpoint must still answer in
// about the 2 s read deadline. Every sys call on that path (revocation, family liveness, the permissions
// map) fails open, so a hung store would otherwise cost each request the client's own 30 s backstop, once
// per call. Runs the hub's real verifier, registry, lineage and session producer; only the DB row and the
// redis clients are faked.

const h = await vi.hoisted(async () => {
  // The package env is memoized on first read, so it must be set before the verifier module loads.
  const { generateKeyPairSync } = await import('node:crypto');
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.AUTH_JWT_PUBLIC_KEY = kp.publicKey;
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  const never = () => new Promise<never>(() => undefined);
  // Every command on the sys client hangs.
  const hungSys = new Proxy({}, { get: () => never });
  return { kp, hungSys, never };
});

vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.hungSys,
  getRedis: () => null,
  evalSys: () => h.never(),
}));
vi.mock('$lib/server/axiom', () => ({
  logAxiomError: vi.fn(),
  logToAxiom: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.where = () => qb;
      qb.select = () => qb;
      qb.executeTakeFirst = async () => ({
        id: 7,
        username: 'seven',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        showNsfw: false,
        blurNsfw: true,
        browsingLevel: 1,
        onboarding: 0,
        muted: false,
        subscriptionRows: [],
        roleRows: [],
        membershipOverride: null,
      });
      return qb;
    },
  },
}));

import { createSessionSigner } from '@civitai/auth';

const DAY_MS = 24 * 60 * 60 * 1000;
let freshToken: string;
let oldToken: string;

beforeAll(async () => {
  const signer = createSessionSigner({
    privateKeyPem: h.kp.privateKey,
    publicKeyPem: h.kp.publicKey,
    kid: 'k1',
    issuer: 'https://auth.test',
    maxAge: 3600,
  });
  freshToken = await signer.mintSessionToken(
    { sub: '7', signedAt: Date.now(), iat0: Date.now() },
    { jti: 'j-fresh' }
  );
  // Signed 40 days ago with a family, so the cookie path must ask whether the family is still live.
  oldToken = await signer.mintSessionToken(
    { sub: '7', signedAt: Date.now() - 40 * DAY_MS, iat0: Date.now(), sid: 'fam-7' },
    { jti: 'j-old' }
  );
});

// A fresh module graph per case, so no state from an earlier case (a trip, a memoized client) carries over.
beforeEach(() => {
  vi.resetModules();
});

async function identity(opts: { bearer?: string; cookie?: string }) {
  const { GET } = await import('../routes/api/auth/identity/+server');
  const { SESSION_COOKIE } = await import('$lib/server/auth/session');
  return GET({
    request: new Request('https://auth.test/api/auth/identity', {
      headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    }),
    url: new URL('https://auth.test/api/auth/identity'),
    cookies: { get: (name: string) => (name === SESSION_COOKIE ? opts.cookie : undefined) },
  } as never);
}

async function within(ms: number, run: () => Promise<Response>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), ms)));
  try {
    return await Promise.race([run(), hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe('GET /api/auth/identity with a hung sys redis', () => {
  it('answers a bearer request within 2.5 s', async () => {
    const started = Date.now();
    const res = await within(4000, () => identity({ bearer: freshToken }));
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 7 });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('answers a cookie request whose family must be checked within 2.5 s', async () => {
    const started = Date.now();
    const res = await within(4000, () => identity({ cookie: oldToken }));
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2500);
  });
}, 15_000);
