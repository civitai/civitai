import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the Phase 3 (git-push self-service) dev-git-access service:
 *   - ensureForgejoIdentity create-path (provisions Forgejo user, mints token,
 *     encrypts + inserts the identity row, returns the decrypted token)
 *   - ensureForgejoIdentity reuse-path (existing row → decrypt + return, with
 *     ZERO Forgejo calls)
 *   - the "Forgejo user exists but no DB row" edge (delete + recreate to get a
 *     known password)
 *   - the encrypt/decrypt round-trip (AES-256-GCM keyed on NEXTAUTH_SECRET)
 *
 * Mocking strategy mirrors the sibling block service tests: vi.hoisted carries
 * the mock surfaces; ~/server/db/client, ~/env/server, and ./forgejo.service
 * are mocked at the module boundary so no Prisma/env/Forgejo is booted.
 */

const { mockDbRead, mockDbWrite, mockForgejo } = vi.hoisted(() => ({
  mockDbRead: {
    appDevForgejoIdentity: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    appDevForgejoIdentity: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockForgejo: {
    createForgejoUser: vi.fn(),
    mintForgejoUserToken: vi.fn(),
    deleteForgejoUser: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/env/server', () => ({ env: { NEXTAUTH_SECRET: 'unit-test-secret-key' } }));
vi.mock('../forgejo.service', () => mockForgejo);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

describe('encrypt/decrypt round-trip', () => {
  it('round-trips a token through AES-256-GCM', async () => {
    const { __testing } = await import('../dev-git-access.service');
    const secret = 'some-server-secret';
    const token = 'sha1-deadbeefcafebabe1234567890';
    const packed = __testing.encryptToken(token, secret);

    // Self-describing iv:tag:ciphertext format; not plaintext.
    expect(packed.split(':')).toHaveLength(3);
    expect(packed).not.toContain(token);

    expect(__testing.decryptToken(packed, secret)).toBe(token);
  });

  it('fails decryption with the wrong secret (GCM auth tag)', async () => {
    const { __testing } = await import('../dev-git-access.service');
    const packed = __testing.encryptToken('tok', 'right-secret');
    expect(() => __testing.decryptToken(packed, 'wrong-secret')).toThrow();
  });

  it('throws on a malformed packed string', async () => {
    const { __testing } = await import('../dev-git-access.service');
    expect(() => __testing.decryptToken('not-packed', 'secret')).toThrow(/malformed/);
  });
});

describe('ensureForgejoIdentity — reuse-path', () => {
  it('returns the decrypted stored token without any Forgejo calls', async () => {
    const mod = await import('../dev-git-access.service');
    // Pre-encrypt a token the same way the service would, so the stored row is
    // realistic.
    const encrypted = mod.__testing.encryptToken('stored-token-sha1', 'unit-test-secret-key');
    mockDbRead.appDevForgejoIdentity.findUnique.mockResolvedValue({
      forgejoUsername: 'dev-7',
      forgejoTokenEncrypted: encrypted,
    });

    const res = await mod.ensureForgejoIdentity(7);
    expect(res).toEqual({ forgejoUsername: 'dev-7', token: 'stored-token-sha1' });

    // No provisioning happened.
    expect(mockForgejo.createForgejoUser).not.toHaveBeenCalled();
    expect(mockForgejo.mintForgejoUserToken).not.toHaveBeenCalled();
    expect(mockDbWrite.appDevForgejoIdentity.create).not.toHaveBeenCalled();
  });
});

describe('ensureForgejoIdentity — owner (provisioning) path', () => {
  it('claims a placeholder row, provisions the user, mints a write:repository token, UPDATEs the row with the encrypted token, returns', async () => {
    const mod = await import('../dev-git-access.service');
    mockDbRead.appDevForgejoIdentity.findUnique.mockResolvedValue(null); // fast-path miss
    mockDbWrite.appDevForgejoIdentity.create.mockResolvedValue({}); // claim wins
    mockForgejo.createForgejoUser.mockResolvedValue({
      user: { id: 100, username: 'dev-42' },
      password: 'fresh-password-1234567890abcdef',
      created: true,
    });
    mockForgejo.mintForgejoUserToken.mockResolvedValue('minted-token-sha1');
    mockDbWrite.appDevForgejoIdentity.update.mockResolvedValue({});

    const res = await mod.ensureForgejoIdentity(42);
    expect(res).toEqual({ forgejoUsername: 'dev-42', token: 'minted-token-sha1' });

    // CLAIM: placeholder row with an EMPTY token, on the dev-<id> handle.
    expect(mockDbWrite.appDevForgejoIdentity.create).toHaveBeenCalledTimes(1);
    const claim = mockDbWrite.appDevForgejoIdentity.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ userId: 42, forgejoUsername: 'dev-42', forgejoTokenEncrypted: '' });

    expect(mockForgejo.createForgejoUser).toHaveBeenCalledWith({
      username: 'dev-42',
      email: 'dev-42@apps.civitai.invalid',
    });
    expect(mockForgejo.mintForgejoUserToken).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'dev-42',
        password: 'fresh-password-1234567890abcdef',
        scopes: ['write:repository'],
      })
    );

    // FILL: UPDATE the claim row with the ENCRYPTED token (not plaintext).
    expect(mockDbWrite.appDevForgejoIdentity.update).toHaveBeenCalledTimes(1);
    const upd = mockDbWrite.appDevForgejoIdentity.update.mock.calls[0][0];
    expect(upd.where).toEqual({ userId: 42 });
    expect(upd.data.forgejoTokenEncrypted).not.toContain('minted-token-sha1');
    expect(mod.__testing.decryptToken(upd.data.forgejoTokenEncrypted, 'unit-test-secret-key')).toBe(
      'minted-token-sha1'
    );

    expect(mockForgejo.deleteForgejoUser).not.toHaveBeenCalled();
    expect(mockDbWrite.appDevForgejoIdentity.delete).not.toHaveBeenCalled();
  });

  it('true-orphan edge (we hold the claim, Forgejo user exists) — deletes + recreates for a known password', async () => {
    const mod = await import('../dev-git-access.service');
    mockDbRead.appDevForgejoIdentity.findUnique.mockResolvedValue(null);
    mockDbWrite.appDevForgejoIdentity.create.mockResolvedValue({});
    mockForgejo.createForgejoUser
      .mockResolvedValueOnce({ user: { id: 1, username: 'dev-9' }, password: null, created: false })
      .mockResolvedValueOnce({
        user: { id: 2, username: 'dev-9' },
        password: 'recreated-pw-abcdef1234567890',
        created: true,
      });
    mockForgejo.mintForgejoUserToken.mockResolvedValue('recreated-token-sha1');
    mockDbWrite.appDevForgejoIdentity.update.mockResolvedValue({});

    const res = await mod.ensureForgejoIdentity(9);
    expect(res.token).toBe('recreated-token-sha1');
    expect(mockForgejo.deleteForgejoUser).toHaveBeenCalledWith('dev-9');
    expect(mockForgejo.createForgejoUser).toHaveBeenCalledTimes(2);
    expect(mockDbWrite.appDevForgejoIdentity.update).toHaveBeenCalledTimes(1);
  });

  it('rolls back the claim row if provisioning throws (so a retry can re-provision)', async () => {
    const mod = await import('../dev-git-access.service');
    mockDbRead.appDevForgejoIdentity.findUnique.mockResolvedValue(null);
    mockDbWrite.appDevForgejoIdentity.create.mockResolvedValue({});
    mockForgejo.createForgejoUser.mockResolvedValue({
      user: { id: 3, username: 'dev-3' },
      password: 'pw-xxxxxxxxxxxxxxxxxxxxxxxx',
      created: true,
    });
    mockForgejo.mintForgejoUserToken.mockRejectedValue(new Error('forgejo down'));
    mockDbWrite.appDevForgejoIdentity.delete.mockResolvedValue({});

    await expect(mod.ensureForgejoIdentity(3)).rejects.toThrow(/forgejo down/);
    // Placeholder claim rolled back so the next attempt isn't wedged.
    expect(mockDbWrite.appDevForgejoIdentity.delete).toHaveBeenCalledWith({ where: { userId: 3 } });
  });
});

describe('ensureForgejoIdentity — recovers from an abandoned (wedged) claim', () => {
  it('reclaims a stale empty-token row (owner died mid-provision) and provisions it itself', async () => {
    const mod = await import('../dev-git-access.service');
    const staleCreatedAt = new Date(Date.now() - 120_000); // 2 min old → past the 60s stale threshold
    mockDbRead.appDevForgejoIdentity.findUnique
      .mockResolvedValueOnce(null) // fast-path miss
      .mockResolvedValue({
        forgejoUsername: 'dev-8',
        forgejoTokenEncrypted: '', // abandoned: claimed but never filled
        createdAt: staleCreatedAt,
      });
    // We lose the fresh claim (the dead owner's row already occupies the PK)...
    mockDbWrite.appDevForgejoIdentity.create.mockRejectedValue({ code: 'P2002' });
    // ...but we atomically reclaim the stale row and become the owner.
    mockDbWrite.appDevForgejoIdentity.updateMany.mockResolvedValue({ count: 1 });
    mockForgejo.createForgejoUser.mockResolvedValue({
      user: { id: 8, username: 'dev-8' },
      password: 'pw-reclaim-1234567890abcdef',
      created: true,
    });
    mockForgejo.mintForgejoUserToken.mockResolvedValue('reclaimed-token-sha1');
    mockDbWrite.appDevForgejoIdentity.update.mockResolvedValue({});

    const res = await mod.ensureForgejoIdentity(8);
    expect(res).toEqual({ forgejoUsername: 'dev-8', token: 'reclaimed-token-sha1' });
    // Reclaim was optimistic-concurrency guarded on the empty token + createdAt.
    expect(mockDbWrite.appDevForgejoIdentity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 8, forgejoTokenEncrypted: '', createdAt: staleCreatedAt },
      })
    );
    // Then it provisioned + filled the token (no permanent wedge).
    expect(mockForgejo.mintForgejoUserToken).toHaveBeenCalled();
    expect(mockDbWrite.appDevForgejoIdentity.update).toHaveBeenCalledTimes(1);
  });
});

describe('ensureForgejoIdentity — concurrent non-owner waits for the owner', () => {
  it('on a P2002 claim race, waits for the owner to land the token and returns it (no Forgejo calls of its own)', async () => {
    const mod = await import('../dev-git-access.service');
    const winnerEncrypted = mod.__testing.encryptToken('winner-token', 'unit-test-secret-key');
    // fast-path miss, then the wait-loop sees the owner's completed row.
    mockDbRead.appDevForgejoIdentity.findUnique
      .mockResolvedValueOnce(null) // fast path
      .mockResolvedValue({ forgejoUsername: 'dev-5', forgejoTokenEncrypted: winnerEncrypted }); // wait loop
    mockDbWrite.appDevForgejoIdentity.create.mockRejectedValue({ code: 'P2002' }); // lost the claim

    const res = await mod.ensureForgejoIdentity(5);
    expect(res).toEqual({ forgejoUsername: 'dev-5', token: 'winner-token' });
    // Non-owner does NO provisioning of its own.
    expect(mockForgejo.createForgejoUser).not.toHaveBeenCalled();
    expect(mockForgejo.mintForgejoUserToken).not.toHaveBeenCalled();
  });
});
