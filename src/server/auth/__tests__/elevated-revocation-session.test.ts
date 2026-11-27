import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiRedis from '@civitai/redis';
import { sessionCookieName } from '@civitai/auth';
import { envMock, redisMock } from '~/__tests__/mocks';

// civitai/civitai#10695: the main app's real session client and session verifier, over a failing sysRedis.
// A moderator or impersonation session whose revocation read failed is signed out for that request only:
// no cookie is written, and /login sends it home instead of to the hub (which would send it back). An
// ordinary session is allowed. Only the shared session cache and the clock-free keys cross the boundary.
const h = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  process.env.AUTH_JWT_PUBLIC_KEY = kp.publicKey;
  return { kp, user: {} as Record<string, unknown> };
});

vi.mock('@civitai/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiRedis>()),
  createCacheRedis: () => ({ packed: { get: async () => h.user } }),
}));

envMock.set({ SESSION_REVOCATION_CACHE: false });
const { createSessionSigner } = await import('@civitai/auth');
const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');
const { isSessionUnconfirmed } = await import('~/server/auth/session-client');
const { getServerSideProps: loginProps } = await import('~/pages/login/index');

const signer = createSessionSigner({
  privateKeyPem: h.kp.privateKey,
  publicKeyPem: h.kp.publicKey,
  kid: 'k1',
  issuer: 'https://auth.test',
  maxAge: 3600,
});
let moderatorToken: string;
let impersonationToken: string;
let ordinaryToken: string;
beforeAll(async () => {
  const base = { signedAt: Date.now(), iat0: Date.now() };
  moderatorToken = await signer.mintSessionToken({ sub: '7', ...base }, { jti: 'jti-mod' });
  impersonationToken = await signer.mintSessionToken(
    { sub: '7', ...base, impersonatedBy: 99, impExp: Date.now() + 3_600_000 },
    { jti: 'jti-imp' }
  );
  ordinaryToken = await signer.mintSessionToken({ sub: '7', ...base }, { jti: 'jti-user' });
});

const storeDown = () => {
  redisMock.sysRedis.hGet.mockRejectedValue(new Error('The client is closed'));
  redisMock.sysRedis.get.mockRejectedValue(new Error('The client is closed'));
};
const storeUp = () => {
  redisMock.sysRedis.hGet.mockResolvedValue(null);
  redisMock.sysRedis.get.mockResolvedValue(null);
};

function request(token: string) {
  const setHeader = vi.fn();
  const req = {
    headers: { host: 'civitai.com' },
    cookies: { [sessionCookieName()]: token },
    url: '/',
  };
  const res = { setHeader, getHeader: () => undefined };
  return { req, res, setHeader };
}

const read = async (token: string) => {
  const r = request(token);
  const session = await getServerAuthSession({ req: r.req as never, res: r.res as never });
  return { ...r, session };
};

beforeEach(() => {
  h.user = { id: 7, username: 'seven', isModerator: true };
  storeUp();
});

describe('the main app session for an elevated user whose revocation read failed', () => {
  it('resolves the moderator while the store answers', async () => {
    expect((await read(moderatorToken)).session?.user).toMatchObject({ id: 7, isModerator: true });
  });

  it('signs the moderator out for this request, writes no cookie, and marks the request', async () => {
    storeDown();
    const { session, setHeader, req } = await read(moderatorToken);
    expect(session).toBeNull();
    expect(setHeader).not.toHaveBeenCalled();
    expect(isSessionUnconfirmed(req)).toBe(true);
  });

  it('signs an impersonation session out for this request', async () => {
    h.user = { id: 7, username: 'seven' };
    storeDown();
    expect((await read(impersonationToken)).session).toBeNull();
  });

  it('allows an ordinary session', async () => {
    h.user = { id: 7, username: 'seven' };
    storeDown();
    const { session, req } = await read(ordinaryToken);
    expect(session?.user).toMatchObject({ id: 7 });
    expect(isSessionUnconfirmed(req)).toBe(false);
  });

  it('answers the same moderator normally once the store is back', async () => {
    storeDown();
    expect((await read(moderatorToken)).session).toBeNull();
    storeUp();
    expect((await read(moderatorToken)).session?.user).toMatchObject({ id: 7 });
  });

  it('sends an unconfirmed moderator from /login home, not to the hub', async () => {
    storeDown();
    const { req, res } = request(moderatorToken);
    const result = await loginProps({
      req,
      res,
      query: { returnUrl: '/moderator/reports' },
      resolvedUrl: '/login?returnUrl=%2Fmoderator%2Freports',
    } as never);
    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
  });
});
