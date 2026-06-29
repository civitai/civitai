import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

// Relocated from the main app's src/server/oauth/__tests__/device-token-scope.test.ts. The device-token
// endpoint was ported to this SvelteKit hub during the first-party-OAuth migration, so the
// scope-intersection coverage moves with it. Contract DIFFERS from the old Prisma handler in two ways the
// assertions reflect: the scope is bounded against ALL_SCOPES (not `Full`), and a deleted/unknown client
// now fails closed with `invalid_grant` (the old handler returned `invalid_client`). This is the only test
// of device-token/+server.ts — it exercises the security-load-bearing path: an opt-in AppBlocksSubmit bit
// (which exceeds `Full`) must survive the bound + per-client allowedScopes intersection and reach
// createOAuthTokenPair INTACT, and must be rejected when the client doesn't allow it.

const h = vi.hoisted(() => ({
  hGet: vi.fn(),
  hDel: vi.fn(),
  createPair: vi.fn(),
  // controllable Kysely client-row result for the OauthClient lookup
  clientRow: undefined as unknown,
}));

// Kysely db — only OauthClient.allowedScopes is selected by the handler.
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(h.clientRow);
      return qb;
    },
  },
}));

vi.mock('$lib/server/redis', () => ({
  getRedis: () => ({
    packed: { hGet: h.hGet },
    hDel: h.hDel,
  }),
}));

vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/oauth/token-helpers', () => ({ createOAuthTokenPair: h.createPair }));

import { POST } from '../+server';

const CLI_SCOPE = TokenScope.UserRead | TokenScope.AppBlocksSubmit; // 33554433 (bit 25 set)

function makeEvent(body: Record<string, unknown>) {
  return {
    request: new Request('https://auth.civitai.com/api/auth/oauth/device-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    getClientAddress: () => '203.0.113.7',
  } as never;
}

const approvedCode = {
  clientId: 'civitai-cli',
  userCode: 'ABCD-EFGH',
  scope: CLI_SCOPE.toString(),
  status: 'approved' as const,
  userId: 7,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.clientRow = undefined;
  h.hDel.mockResolvedValue(1); // claim succeeds by default (atomic HDEL returns 1)
  h.createPair.mockResolvedValue({
    accessToken: 'civitai_access',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    refreshToken: 'civitai_refresh',
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
  });
});

describe('device-token +server — AppBlocksSubmit scope survives into the minted token', () => {
  it('mints a token carrying AppBlocksSubmit when the approved device code requested it', async () => {
    h.hGet.mockResolvedValueOnce(approvedCode);
    h.clientRow = { allowedScopes: CLI_SCOPE }; // client allows exactly UserRead|AppBlocksSubmit

    const res = await POST(
      makeEvent({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'devcode',
        client_id: 'civitai-cli',
      })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // The ALL_SCOPES bound did NOT reject the bit-25 value.
    expect(json.token_type).toBe('Bearer');
    expect(json.scope).toBe(CLI_SCOPE.toString());
    expect(json.refresh_token).toBe('civitai_refresh');
    expect(json.expires_in).toBe(3600);
    // createOAuthTokenPair received the scope INTACT (bit 25 preserved).
    expect(h.createPair).toHaveBeenCalledTimes(1);
    expect(h.createPair).toHaveBeenCalledWith(7, 'civitai-cli', CLI_SCOPE);
  });

  it('rejects with invalid_scope when the client allowedScopes does NOT include AppBlocksSubmit', async () => {
    h.hGet.mockResolvedValueOnce(approvedCode);
    h.clientRow = { allowedScopes: TokenScope.UserRead }; // intersection must reject the submit bit

    const res = await POST(
      makeEvent({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'devcode',
        client_id: 'civitai-cli',
      })
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
    expect(h.createPair).not.toHaveBeenCalled();
  });

  it('fails closed with invalid_grant when the client row is absent (deleted within the device-code TTL)', async () => {
    // The reusable provider tightened the deleted-client case: the allowedScopes intersection cannot be
    // evaluated, so the endpoint rejects rather than minting. (The old main-app handler returned
    // invalid_client here; the port returns invalid_grant — the contract this test pins.)
    h.hGet.mockResolvedValueOnce(approvedCode);
    h.clientRow = undefined;

    const res = await POST(
      makeEvent({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'devcode',
        client_id: 'civitai-cli',
      })
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    expect(h.createPair).not.toHaveBeenCalled();
  });
});
