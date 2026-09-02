import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope, ALL_SCOPES } from '@civitai/auth/token-scope';

/**
 * Device-authorization (RFC 8628) SCOPE VALIDATION — `POST /api/auth/oauth/device`.
 *
 * This is the FIRST of the two places a device-flow token's ceiling is enforced
 * (the second is the mint in `device-token/+server.ts`, covered by its own test).
 * It is also the one that decides whether `civitai login` succeeds at all, so its
 * exact semantics matter to every CLI release:
 *
 *   🔴 the check REJECTS, it does not CLAMP. `hasScope(allowedScopes, requested)`
 *   is all-or-nothing — a request carrying ONE bit outside the client's ceiling
 *   gets `invalid_scope` / 400 and the whole login fails. That is why widening a
 *   client's `allowedScopes` (a manual-apply DB migration) must land BEFORE any
 *   CLI release that requests the wider scope. Issue #3681.
 *
 * The `civitai-cli` cases below are written as a BEFORE/AFTER pair against the two
 * real `allowedScopes` values so the deploy-ordering constraint is asserted rather
 * than only described: the pre-fix ceiling REJECTS the AI-services request; the
 * post-fix ceiling ACCEPTS it.
 */

const h = vi.hoisted(() => ({
  hSet: vi.fn(),
  hExpire: vi.fn(),
  getClientIp: vi.fn<() => string | null>(),
  checkRateLimit: vi.fn<(bucket: string, id: string | null) => Promise<boolean>>(),
  clientRow: undefined as unknown,
}));

// Kysely db — the handler selects the whole OauthClient row.
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.selectAll = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(h.clientRow);
      return qb;
    },
  },
}));

vi.mock('$lib/server/redis', () => ({
  getRedis: () => ({ packed: { hSet: h.hSet }, hExpire: h.hExpire }),
}));

vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: h.checkRateLimit,
}));

vi.mock('$lib/server/auth/request', () => ({ getClientIp: h.getClientIp }));

import { POST } from '../+server';

/** The client's `allowedScopes` before this fix — bits 0/25/26. */
const CLI_ALLOWED_BEFORE = 100663297;
/** ...and after the AI-services widening — bits 0/14/15/16/25/26. */
const CLI_ALLOWED_AFTER = 100777985;
/** What `civitai generate` needs: AIServicesRead|AIServicesWrite|BuzzRead. */
const AI_SERVICES_REQUEST =
  TokenScope.AIServicesRead | TokenScope.AIServicesWrite | TokenScope.BuzzRead;

function clientRow(allowedScopes: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 'civitai-cli',
    grants: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    allowedScopes,
    ...overrides,
  };
}

function makeEvent(body: Record<string, string>) {
  return {
    request: new Request('https://auth.civitai.com/api/auth/oauth/device', {
      method: 'POST',
      body: new URLSearchParams(body),
    }),
    url: new URL('https://auth.civitai.com/api/auth/oauth/device'),
  } as never;
}

/**
 * The `scope` field the handler persisted onto the pending device code, as a number.
 * The handler writes TWO hashes (the device-code record and the user-code → device-code
 * index); only the first carries a record object, so it is selected by shape rather
 * than by call order.
 */
function storedScope(): number {
  const records = h.hSet.mock.calls
    .map((c) => c[2])
    .filter(
      (v): v is { scope: string } =>
        typeof v === 'object' && v !== null && typeof (v as { scope?: unknown }).scope === 'string'
    );
  expect(records).toHaveLength(1);
  return parseInt(records[0].scope, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.clientRow = undefined;
  h.hSet.mockResolvedValue(1);
  h.hExpire.mockResolvedValue(1);
  h.getClientIp.mockReturnValue('203.0.113.7');
  h.checkRateLimit.mockResolvedValue(true);
});

describe('device authorization — requested-scope validation', () => {
  it('accepts a request that is a strict SUBSET of allowedScopes', async () => {
    h.clientRow = clientRow(CLI_ALLOWED_AFTER);
    const res = await POST(
      makeEvent({ client_id: 'civitai-cli', scope: String(TokenScope.AIServicesRead) })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.device_code).toEqual(expect.any(String));
    expect(body.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Subset preserved intact (plus the UserRead baseline), never clamped away.
    expect(storedScope()).toBe(TokenScope.AIServicesRead | TokenScope.UserRead);
  });

  it('rejects a request carrying ANY bit outside allowedScopes, with invalid_scope', async () => {
    h.clientRow = clientRow(CLI_ALLOWED_AFTER);
    // One bit outside the ceiling (VaultRead is not granted), everything else inside.
    const res = await POST(
      makeEvent({
        client_id: 'civitai-cli',
        scope: String(AI_SERVICES_REQUEST | TokenScope.VaultRead),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_scope',
      error_description: 'Requested scope exceeds client permissions',
    });
    // Fail closed: nothing is persisted for a rejected request.
    expect(h.hSet).not.toHaveBeenCalled();
  });

  it('REJECTS rather than CLAMPS — the whole request dies, the in-ceiling bits are not granted', async () => {
    h.clientRow = clientRow(CLI_ALLOWED_AFTER);
    const res = await POST(
      makeEvent({
        client_id: 'civitai-cli',
        scope: String(AI_SERVICES_REQUEST | TokenScope.VaultRead),
      })
    );
    expect(res.status).toBe(400);
    // The distinguishing assertion: a CLAMPING implementation would have stored
    // AI_SERVICES_REQUEST|UserRead here and returned 200.
    expect(h.hSet).not.toHaveBeenCalled();
  });

  it('OR-s the UserRead baseline in even when the request omits it', async () => {
    h.clientRow = clientRow(CLI_ALLOWED_AFTER);
    const res = await POST(
      makeEvent({ client_id: 'civitai-cli', scope: String(AI_SERVICES_REQUEST) })
    );
    expect(res.status).toBe(200);
    expect(AI_SERVICES_REQUEST & TokenScope.UserRead).toBe(0); // control: it really was absent
    expect(storedScope() & TokenScope.UserRead).toBe(TokenScope.UserRead);
    expect(storedScope()).toBe(AI_SERVICES_REQUEST | TokenScope.UserRead);
  });

  it('allows the UserRead baseline even when the client does not list it', async () => {
    // The ceiling the handler enforces is `allowedScopes | UserRead`, so a client
    // whose grant omits bit 0 still gets it rather than a 400.
    h.clientRow = clientRow(TokenScope.AIServicesRead); // no UserRead in allowedScopes
    const res = await POST(
      makeEvent({ client_id: 'civitai-cli', scope: String(TokenScope.AIServicesRead) })
    );
    expect(res.status).toBe(200);
    expect(storedScope()).toBe(TokenScope.AIServicesRead | TokenScope.UserRead);
  });

  it('rejects a scope value above ALL_SCOPES', async () => {
    h.clientRow = clientRow(CLI_ALLOWED_AFTER);
    const res = await POST(makeEvent({ client_id: 'civitai-cli', scope: String(ALL_SCOPES + 1) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' }); // the bound check, no description
    expect(h.hSet).not.toHaveBeenCalled();
  });

  describe('issue #3681 — the civitai-cli AI-services grant, before and after', () => {
    it('the PRE-fix ceiling rejects the generate scopes (this is the reported bug)', async () => {
      h.clientRow = clientRow(CLI_ALLOWED_BEFORE);
      // Control: the request really does exceed the pre-fix ceiling.
      expect(AI_SERVICES_REQUEST & ~CLI_ALLOWED_BEFORE).not.toBe(0);

      const res = await POST(
        makeEvent({ client_id: 'civitai-cli', scope: String(AI_SERVICES_REQUEST) })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_scope');
      expect(h.hSet).not.toHaveBeenCalled();
    });

    it('the POST-fix ceiling accepts them, with every requested bit preserved', async () => {
      h.clientRow = clientRow(CLI_ALLOWED_AFTER);
      const res = await POST(
        makeEvent({ client_id: 'civitai-cli', scope: String(AI_SERVICES_REQUEST) })
      );
      expect(res.status).toBe(200);
      const stored = storedScope();
      expect(stored & TokenScope.AIServicesRead).toBe(TokenScope.AIServicesRead);
      expect(stored & TokenScope.AIServicesWrite).toBe(TokenScope.AIServicesWrite);
      expect(stored & TokenScope.BuzzRead).toBe(TokenScope.BuzzRead);
    });

    it('the app-block scopes still round-trip on the widened ceiling (no regression)', async () => {
      h.clientRow = clientRow(CLI_ALLOWED_AFTER);
      const appBlockRequest = TokenScope.AppBlocksSubmit | TokenScope.AppBlocksDevTunnel;
      const res = await POST(
        makeEvent({ client_id: 'civitai-cli', scope: String(appBlockRequest) })
      );
      expect(res.status).toBe(200);
      expect(storedScope()).toBe(appBlockRequest | TokenScope.UserRead);
    });

    it('the widened ceiling is still NOT a superset of Full', () => {
      // The invariant `blocks.router.getMyAppAnalytics` depends on; asserted here too
      // because this file is where the number is most likely to be edited next.
      expect(CLI_ALLOWED_AFTER | TokenScope.Full).not.toBe(CLI_ALLOWED_AFTER);
      expect(CLI_ALLOWED_AFTER).toBe(
        TokenScope.UserRead |
          TokenScope.AIServicesRead |
          TokenScope.AIServicesWrite |
          TokenScope.BuzzRead |
          TokenScope.AppBlocksSubmit |
          TokenScope.AppBlocksDevTunnel
      );
    });
  });
});

describe('device +server — the authorization request is bounded per caller, not per fleet', () => {
  // A device-flow client_id is public and identical across every install, so charging it here caps the
  // entire fleet at one budget AND lets anyone who knows the id exhaust it for everyone. This fails if
  // the identifier regresses to client_id.
  it('charges the caller IP, never the client id', async () => {
    h.clientRow = {
      allowedScopes: CLI_ALLOWED_AFTER,
      grants: ['urn:ietf:params:oauth:grant-type:device_code'],
    };

    await POST(makeEvent({ client_id: 'civitai-cli', scope: String(TokenScope.AIServicesRead) }));

    expect(h.checkRateLimit).toHaveBeenCalledWith('device', '203.0.113.7');
    const identifiers = h.checkRateLimit.mock.calls.map(([, id]) => id);
    expect(identifiers).not.toContain('civitai-cli');
  });

  it('429s when that ceiling is spent, without reaching the client lookup', async () => {
    h.checkRateLimit.mockResolvedValue(false);
    h.clientRow = {
      allowedScopes: CLI_ALLOWED_AFTER,
      grants: ['urn:ietf:params:oauth:grant-type:device_code'],
    };

    const res = await POST(
      makeEvent({ client_id: 'civitai-cli', scope: String(TokenScope.AIServicesRead) })
    );

    expect(res.status).toBe(429);
    expect(h.hSet).not.toHaveBeenCalled();
  });
});
