import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionUser } from '@civitai/auth';

// The shared Civitai Moderation account is never minted a session, so no app that trusts the hub's tokens
// can be signed into as it, by login, account switch or impersonation.

const h = vi.hoisted(() => ({
  mintSessionToken: vi.fn(async () => 'minted-token'),
  logToAxiom: vi.fn(async () => undefined),
  verifyToken: vi.fn(async () => ({ sub: '901', jti: 't' })),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => ({ mintSessionToken: h.mintSessionToken, maxAge: 1234 }),
}));
vi.mock('../registry', () => ({ sessions: { trackToken: vi.fn(async () => {}) } }));
vi.mock('../verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('../cookie', () => ({ cookieDomain: () => undefined }));
vi.mock('../device', () => ({ getOrCreateDeviceId: vi.fn(), linkAccount: vi.fn() }));
vi.mock('../../axiom', () => ({ logToAxiom: h.logToAxiom }));
vi.mock('../../db/db', () => ({ db: {} }));
vi.mock('../../redis', () => ({
  getRedis: () => ({
    packed: {
      get: async (key: string) => ({ id: Number(key.split(':').pop()), username: 'cached' }),
    },
  }),
  getSysRedis: () => null,
}));

const { mintUserSession, establishSession } = await import('../session');
const { getOrProduceSessionUser } = await import('../session-producer');
const { createOAuthTokenPair } = await import('../../oauth/token-helpers');

const user = (id: number, username: string) => ({ id, username } as unknown as SessionUser);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CIVITAI_MODERATION_USER_ID = '900';
});

describe('mintUserSession and the moderation account', () => {
  it('refuses the account by id, including as an impersonation target', async () => {
    await expect(mintUserSession(user(900, 'renamed'))).rejects.toMatchObject({ status: 403 });
    await expect(
      mintUserSession(user(900, 'renamed'), { impersonatedBy: 7 })
    ).rejects.toMatchObject({ status: 403 });
    expect(h.mintSessionToken).not.toHaveBeenCalled();
    expect(h.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'moderation-account-session-refused', type: 'error' })
    );
  });

  it('refuses it by username when this app has no id configured', async () => {
    delete process.env.CIVITAI_MODERATION_USER_ID;
    await expect(mintUserSession(user(900, 'CivitaiModeration'))).rejects.toMatchObject({
      status: 403,
    });
    expect(h.mintSessionToken).not.toHaveBeenCalled();
  });

  it('mints for everyone else', async () => {
    await expect(mintUserSession(user(901, 'someone'))).resolves.toBe('minted-token');
  });
});

describe('other ways to become the moderation account at the hub', () => {
  it('a login is refused before any cookie or hand-off', async () => {
    // A prior session for someone else is what routes a login into the cross-domain hand-off, which
    // never mints; the refusal has to come first.
    const cookies = { get: () => 'prior-token', set: vi.fn(), delete: vi.fn() };
    await expect(establishSession(cookies as never, user(900, 'renamed'))).rejects.toMatchObject({
      status: 403,
    });
    expect(cookies.set).not.toHaveBeenCalled();
    expect(h.verifyToken).not.toHaveBeenCalled();
  });

  it('a token, pending authorization or id resolves to no user', async () => {
    expect(await getOrProduceSessionUser(900)).toBeNull();
    expect(await getOrProduceSessionUser(901)).toMatchObject({ id: 901 });
  });

  it('no OAuth token pair is issued for it', async () => {
    await expect(createOAuthTokenPair(900, 'client', 1)).rejects.toMatchObject({ status: 403 });
  });
});
