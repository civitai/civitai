import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionClaims, SessionUser } from '@civitai/auth';

const h = vi.hoisted(() => ({ mintSessionToken: vi.fn(async () => 'minted-token') }));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => ({ mintSessionToken: h.mintSessionToken, maxAge: 30 * 86_400 }),
}));
vi.mock('../registry', () => ({ sessions: { trackToken: vi.fn(async () => {}) } }));
vi.mock('../verifier', () => ({ verifier: { verifyToken: vi.fn() } }));
vi.mock('../cookie', () => ({ cookieDomain: () => undefined }));
vi.mock('../device', () => ({ getOrCreateDeviceId: vi.fn(), linkAccount: vi.fn() }));
vi.mock('../../db/db', () => ({ db: {} }));
vi.mock('../../redis', () => ({ getRedis: () => null, getSysRedis: () => null }));

const { mintUserSession, reissueSession } = await import('../session');

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const target = { id: 7, username: 'target' } as unknown as SessionUser;
const modSession: SessionClaims = { sub: '100', jti: 'mod-jti', iat0: NOW - 10 * 86_400_000 };

const minted = () => {
  const calls = h.mintSessionToken.mock.calls as unknown as [
    Record<string, unknown>,
    { expiresIn: number }
  ][];
  const [claims, opts] = calls.at(-1)!;
  return { claims, expiresIn: opts.expiresIn };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('impersonation session lifetime', () => {
  it('ends an hour after it starts', async () => {
    await mintUserSession(target, { parent: modSession, impersonatedBy: 100 });
    const { claims, expiresIn } = minted();
    expect(claims).toMatchObject({ impersonatedBy: 100, impExp: NOW + HOUR });
    expect(expiresIn).toBe(HOUR / 1000);
  });

  it('keeps the same end when refreshed, and runs out at it', async () => {
    await mintUserSession(target, { parent: modSession, impersonatedBy: 100 });
    const started = minted().claims as SessionClaims;

    vi.setSystemTime(NOW + 50 * 60 * 1000);
    await reissueSession({ ...started, jti: 'imp-jti' }, 7, 'imp-jti');
    const { claims, expiresIn } = minted();
    expect(claims.impExp).toBe(NOW + HOUR);
    expect(expiresIn).toBe(10 * 60);
  });

  it("gives a moderator's own session no end time of its own", async () => {
    await mintUserSession(target, { parent: modSession });
    expect(minted().claims).not.toHaveProperty('impExp');
  });
});
