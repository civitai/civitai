import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionUser } from '@civitai/auth';

// The shared Civitai Moderation account is never minted a session, so no app that trusts the hub's tokens
// can be signed into as it, by login, account switch or impersonation.

const h = vi.hoisted(() => ({
  mintSessionToken: vi.fn(async () => 'minted-token'),
  logToAxiom: vi.fn(async () => undefined),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => ({ mintSessionToken: h.mintSessionToken, maxAge: 1234 }),
}));
vi.mock('../registry', () => ({ sessions: { trackToken: vi.fn(async () => {}) } }));
vi.mock('../verifier', () => ({ verifier: { verifyToken: vi.fn() } }));
vi.mock('../cookie', () => ({ cookieDomain: () => undefined }));
vi.mock('../device', () => ({ getOrCreateDeviceId: vi.fn(), linkAccount: vi.fn() }));
vi.mock('../../axiom', () => ({ logToAxiom: h.logToAxiom }));

const { mintUserSession } = await import('../session');

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
