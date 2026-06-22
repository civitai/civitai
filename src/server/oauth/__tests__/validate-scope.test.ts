import { describe, it, expect, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Authorization_code path's scope gate (oauthModel.validateScope). Uses the
// REAL Flags + TokenScope so the bit-math is genuinely exercised: a client
// whose allowedScopes is TokenScope.Full (bits 0..24, EXCLUDES AppBlocksSubmit)
// cannot escalate to a token carrying AppBlocksSubmit (bit 25) — mirrors the
// device-flow intersection, but on the authorize grant. (audit LOW-2)

vi.mock('~/server/db/client', () => ({
  dbRead: { oauthClient: { findUnique: vi.fn() } },
  dbWrite: { apiKey: {} },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { packed: {}, hExpire: vi.fn(), hDel: vi.fn() },
  REDIS_KEYS: { OAUTH: {} },
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/utils/key-generator', () => ({
  generateSecretHash: (s: string) => `hash:${s}`,
}));
vi.mock('~/server/oauth/token-helpers', () => ({ createOAuthTokenPair: vi.fn() }));

import { oauthModel } from '../model';

const user = { id: 7 } as any;
const baseClient = { id: 'civitai-cli', grants: ['authorization_code'] } as any;

describe('oauthModel.validateScope — authorize-flow scope intersection', () => {
  it('rejects a client requesting AppBlocksSubmit when allowedScopes is Full (no bit 25)', async () => {
    // allowedScopes = Full (33554431) deliberately EXCLUDES AppBlocksSubmit.
    const client = { ...baseClient, allowedScopes: TokenScope.Full };
    const requested = (TokenScope.UserRead | TokenScope.AppBlocksSubmit).toString(); // 33554433

    const result = await oauthModel.validateScope(user, client, [requested]);

    expect(result).toBe(false);
  });

  it('grants when allowedScopes includes AppBlocksSubmit', async () => {
    const client = {
      ...baseClient,
      allowedScopes: TokenScope.UserRead | TokenScope.AppBlocksSubmit,
    };
    const requested = (TokenScope.UserRead | TokenScope.AppBlocksSubmit).toString();

    const result = await oauthModel.validateScope(user, client, [requested]);

    // Returns the granted scope string array (UserRead is always folded in).
    expect(result).toEqual([(TokenScope.UserRead | TokenScope.AppBlocksSubmit).toString()]);
  });
});
