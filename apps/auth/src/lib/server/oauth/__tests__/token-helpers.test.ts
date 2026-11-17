import { describe, it, expect, vi, beforeEach } from 'vitest';

// Parity test for createOAuthTokenPair (Kysely port). The token-minting path is security-load-bearing:
// it must (1) force the UserRead baseline bit onto BOTH rows, (2) insert exactly one Access + one Refresh
// ApiKey row, (3) prefix tokens with `civitai_`, and (4) set 1h / 30d expiries. We capture the Kysely
// insert payloads via a mock db.

const h = vi.hoisted(() => ({ inserts: [] as any[] }));

vi.mock('$lib/server/db/db', () => ({
  db: {
    insertInto() {
      const qb: any = {};
      qb.values = (v: any) => {
        h.inserts.push(v);
        return qb;
      };
      qb.execute = () => Promise.resolve([{}]);
      return qb;
    },
  },
}));

let keyCounter = 0;
vi.mock('@civitai/auth/secret-hash', () => ({
  generateKey: () => `key${keyCounter++}`,
  generateSecretHash: (s: string) => `hash:${s}`,
}));

import { createOAuthTokenPair } from '../token-helpers';

const VaultWrite = 1n << 24n;

beforeEach(() => {
  vi.clearAllMocks();
  h.inserts.length = 0;
  keyCounter = 0;
});

describe('createOAuthTokenPair (parity)', () => {
  it('inserts one Access + one Refresh row, both carrying the requested scope OR UserRead', async () => {
    const pair = await createOAuthTokenPair(42, 'client-x', VaultWrite);

    expect(h.inserts).toHaveLength(2);
    const [access, refresh] = h.inserts;

    expect(access.type).toBe('Access');
    expect(refresh.type).toBe('Refresh');
    expect(access.userId).toBe(42);
    expect(access.clientId).toBe('client-x');

    // UserRead forced on regardless of request: VaultWrite (16777216) | UserRead (1).
    expect(access.tokenScope).toBe(16777217);
    expect(access.tokenScopeWide).toBe('16777217');
    expect(refresh.tokenScope).toBe(16777217);
    expect(refresh.tokenScopeWide).toBe('16777217');

    // tokens are civitai_-prefixed and the stored key is the salted hash
    expect(pair.accessToken.startsWith('civitai_')).toBe(true);
    expect(pair.refreshToken.startsWith('civitai_')).toBe(true);
    expect(access.key).toBe(`hash:${pair.accessToken}`);
    expect(refresh.key).toBe(`hash:${pair.refreshToken}`);
  });

  it('forces UserRead even when scope is 0', async () => {
    await createOAuthTokenPair(1, 'c', 0n);
    expect(h.inserts[0].tokenScope).toBe(1);
    expect(h.inserts[0].tokenScopeWide).toBe('1');
  });

  it('writes bits 31 and 32 to tokenScopeWide only, and the low 31 bits to tokenScope', async () => {
    // AppsRead (2^31) | AppDataRead (2^32) | VaultWrite (2^24); UserRead (1) is forced on.
    await createOAuthTokenPair(1, 'c', 2147483648n | 4294967296n | VaultWrite);
    for (const row of h.inserts) {
      expect(row.tokenScopeWide).toBe('6459228161');
      // The 32-bit column a pod on the previous build reads: the same mask without bits 31 and 32.
      expect(row.tokenScope).toBe(16777217);
    }
  });

  it('sets ~1h access expiry and ~30d refresh expiry', async () => {
    const pair = await createOAuthTokenPair(1, 'c', 0n);
    const accessMs = pair.accessTokenExpiresAt.getTime() - Date.now();
    const refreshMs = pair.refreshTokenExpiresAt.getTime() - Date.now();
    expect(Math.abs(accessMs - 60 * 60 * 1000)).toBeLessThan(5000);
    expect(Math.abs(refreshMs - 30 * 24 * 60 * 60 * 1000)).toBeLessThan(5000);
  });
});
