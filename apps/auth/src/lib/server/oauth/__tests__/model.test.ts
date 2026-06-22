import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OriginNotAllowedError } from '../errors';

// Parity tests for the hub's Kysely OAuth model, adapted from the main app's
// src/server/oauth/__tests__/model.test.ts. The security-load-bearing behaviour MUST match the Prisma
// original: public-client origin enforcement, confidential-client timing-safe secret compare, scope
// bitmask round-trip, and cascade revocation. We mock the Kysely `db` query builder (chainable) and the
// hub redis so the model's logic is exercised without a real DB/Redis.

// ── Kysely db mock ────────────────────────────────────────────────────────────
// A tiny chainable builder: every method returns `this`; the terminal executeTakeFirst/execute resolve
// from per-test queues so we can script what each query returns.
const h = vi.hoisted(() => {
  const selectResults: unknown[] = [];
  const deleteResults: unknown[] = [];
  const selectWheres: unknown[][] = [];
  const evalCalls: unknown[][] = [];
  const calls = { inserts: [] as unknown[], deletes: [] as unknown[] };
  // controllable redis handle — set to null in a test to exercise fail-closed paths.
  const state: { redis: unknown } = { redis: null };
  return { selectResults, deleteResults, selectWheres, evalCalls, calls, state };
});

function makeDb() {
  return {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.selectAll = () => qb;
      qb.where = (...args: unknown[]) => {
        h.selectWheres.push(args);
        return qb;
      };
      qb.executeTakeFirst = () => Promise.resolve(h.selectResults.shift());
      qb.execute = () => Promise.resolve([h.selectResults.shift()].filter(Boolean));
      return qb;
    },
    insertInto() {
      const qb: Record<string, unknown> = {};
      qb.values = (v: unknown) => {
        h.calls.inserts.push(v);
        return qb;
      };
      qb.execute = () => Promise.resolve([{}]);
      return qb;
    },
    deleteFrom() {
      const where: Record<string, unknown> = {};
      const qb: Record<string, unknown> = {};
      qb.where = (...args: unknown[]) => {
        h.calls.deletes.push(args);
        return qb;
      };
      qb.executeTakeFirst = () => Promise.resolve(h.deleteResults.shift() ?? { numDeletedRows: 0n });
      qb.execute = () => Promise.resolve([]);
      return qb;
    },
  };
}

vi.mock('$lib/server/db/db', () => ({ db: makeDb() }));

// hub redis — getClient/validateScope don't use it. The auth-code paths do; we return a controllable
// handle (h.state.redis) so a test can set it to null and exercise the fail-closed branch.
vi.mock('$lib/server/redis', () => ({
  getRedis: () => h.state.redis,
}));

// Shared hash: deterministic stub so timing-safe compare is exercised with equal-length buffers.
vi.mock('@civitai/auth/secret-hash', () => ({
  generateSecretHash: (s: string) => `hash:${s}`,
  generateKey: () => 'k'.repeat(36),
}));

import { oauthModel } from '../model';

const baseClient = {
  id: 'pub-1',
  isConfidential: false,
  secret: null,
  grants: ['authorization_code', 'refresh_token'],
  redirectUris: ['https://app.example.com/cb'],
  allowedOrigins: ['https://app.example.com'],
  allowedScopes: 33554431,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.selectResults.length = 0;
  h.deleteResults.length = 0;
  h.selectWheres.length = 0;
  h.evalCalls.length = 0;
  h.calls.inserts.length = 0;
  h.calls.deletes.length = 0;
  // default: redis present, eval-capable (hSetWithTTL casts and calls .eval) with a benign packed store.
  h.state.redis = {
    eval: (...args: unknown[]) => {
      h.evalCalls.push(args);
      return Promise.resolve(1);
    },
    packed: { hGet: () => Promise.resolve(null) },
    hDel: () => Promise.resolve(1),
    hExpire: () => Promise.resolve(),
  };
});

// Token-exchange requests are detected by the presence of `grant_type` in the body. Authorize-flow
// requests have `response_type` instead.
const tokenExchangeBody = { grant_type: 'authorization_code', code: 'abc' };
const authorizeBody = { response_type: 'code', code_challenge: 'x' };

describe('oauthModel.getClient — origin enforcement (parity)', () => {
  it('returns enriched Client and stashes record on Request when origin matches', async () => {
    h.selectResults.push(baseClient);
    const request: any = { headers: { origin: 'https://app.example.com' }, body: tokenExchangeBody };

    const client = await oauthModel.getClient('pub-1', null, request);

    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
    expect(request.oauthClient).toMatchObject({
      id: 'pub-1',
      allowedOrigins: ['https://app.example.com'],
    });
  });

  it('throws OriginNotAllowedError when public client Origin is not allowlisted', async () => {
    h.selectResults.push(baseClient);
    const request: any = { headers: { origin: 'https://evil.example.com' }, body: tokenExchangeBody };
    await expect(oauthModel.getClient('pub-1', null, request)).rejects.toBeInstanceOf(
      OriginNotAllowedError
    );
  });

  it('allows public client request with no Origin header (native/mobile path)', async () => {
    h.selectResults.push(baseClient);
    const request: any = { headers: {}, body: tokenExchangeBody };
    const client = await oauthModel.getClient('pub-1', null, request);
    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
  });

  it('throws OriginNotAllowedError when a browser sends an Origin not on the allowlist (empty allowlist)', async () => {
    h.selectResults.push({ ...baseClient, allowedOrigins: [] });
    const request: any = { headers: { origin: 'https://random.example.com' }, body: tokenExchangeBody };
    await expect(oauthModel.getClient('pub-1', null, request)).rejects.toBeInstanceOf(
      OriginNotAllowedError
    );
  });

  it('skips origin enforcement for confidential clients (timing-safe secret match)', async () => {
    h.selectResults.push({
      ...baseClient,
      isConfidential: true,
      secret: 'hash:s3cret',
      allowedOrigins: [],
    });
    const request: any = { headers: { origin: 'https://random.example.com' }, body: tokenExchangeBody };
    const client = await oauthModel.getClient('conf-1', 's3cret', request);
    expect(client).toMatchObject({ isConfidential: true });
  });

  it('skips origin enforcement when called without a request (legacy authorize callers)', async () => {
    h.selectResults.push(baseClient);
    const client = await oauthModel.getClient('pub-1', null);
    expect(client).toMatchObject({ id: 'pub-1' });
  });

  it('allows native client with no Origin even when allowlist is empty', async () => {
    h.selectResults.push({ ...baseClient, allowedOrigins: [] });
    const request: any = { headers: {}, body: tokenExchangeBody };
    const client = await oauthModel.getClient('native-1', null, request);
    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
  });

  it('skips origin enforcement on the authorize flow (no grant_type in body)', async () => {
    h.selectResults.push(baseClient);
    const request: any = {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: authorizeBody,
    };
    const client = await oauthModel.getClient('pub-1', null, request);
    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
  });

  it('returns false when the client does not exist', async () => {
    h.selectResults.push(undefined);
    const client = await oauthModel.getClient('nope', null, { headers: {} } as any);
    expect(client).toBe(false);
  });

  it('returns false for confidential client with wrong secret', async () => {
    h.selectResults.push({ ...baseClient, isConfidential: true, secret: 'hash:right' });
    const client = await oauthModel.getClient('conf-1', 'wrong', { headers: {} } as any);
    expect(client).toBe(false);
  });
});

describe('oauthModel.validateScope — UserRead baseline + allowed-scope gate (parity)', () => {
  const UserRead = 1;
  const VaultWrite = 1 << 24;

  it('forces UserRead into the granted scope even if not requested', async () => {
    const granted = await oauthModel.validateScope(
      { id: 1 } as any,
      { allowedScopes: 33554431 } as any,
      ['0'] // requested nothing
    );
    expect(granted).toEqual([String(UserRead)]);
  });

  it('grants a requested scope within the client allowlist (OR-ed with UserRead)', async () => {
    const granted = await oauthModel.validateScope(
      { id: 1 } as any,
      { allowedScopes: VaultWrite } as any,
      [String(VaultWrite)]
    );
    expect(granted).toEqual([String(VaultWrite | UserRead)]);
  });

  it('rejects a scope outside the client allowlist', async () => {
    const granted = await oauthModel.validateScope(
      { id: 1 } as any,
      { allowedScopes: UserRead } as any, // only UserRead allowed
      [String(VaultWrite)]
    );
    expect(granted).toBe(false);
  });
});

describe('oauthModel.verifyScope (parity)', () => {
  it('passes when the token carries the required bit', async () => {
    expect(await oauthModel.verifyScope({ scope: ['3'] } as any, '1')).toBe(true);
  });
  it('fails when the token is missing the required bit', async () => {
    expect(await oauthModel.verifyScope({ scope: ['1'] } as any, '2')).toBe(false);
  });
});

describe('oauthModel.getAccessToken — expiry filter + mapping (parity)', () => {
  it('applies key + type + an (expiry OR null) predicate and maps the row to a Token', async () => {
    h.selectResults.push({ userId: 9, tokenScope: 3, expiresAt: null, clientId: 'c1' });
    const tok = await oauthModel.getAccessToken('civitai_abc');

    expect(tok).toMatchObject({
      accessToken: 'civitai_abc',
      scope: ['3'],
      user: { id: 9 },
      client: { id: 'c1' },
    });
    // structural pin: a regression that dropped the expiry filter (the OR predicate is a callback) or the
    // key/type filters would be caught here — the simple chainable mock can't evaluate SQL, but it records
    // which columns/predicates were filtered on.
    const cols = h.selectWheres.map((w) => w[0]);
    expect(cols).toContain('key');
    expect(cols).toContain('type');
    expect(h.selectWheres.some((w) => typeof w[0] === 'function')).toBe(true); // the OR(expiry) group
  });

  it('returns false when no row matches (expired or absent)', async () => {
    h.selectResults.push(undefined);
    expect(await oauthModel.getAccessToken('civitai_x')).toBe(false);
  });
});

describe('oauthModel.saveAuthorizationCode — fail-closed + hashed atomic store (parity)', () => {
  const mkCode = () =>
    ({
      authorizationCode: 'raw-code-value',
      scope: ['3'],
      redirectUri: 'https://app.example.com/cb',
      codeChallenge: 'chal',
      codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + 600_000),
    }) as any;

  it('throws when redis is unavailable — an un-storable code must NOT be issued', async () => {
    h.state.redis = null;
    await expect(
      oauthModel.saveAuthorizationCode(mkCode(), { id: 'c1' } as any, { id: 1 } as any)
    ).rejects.toThrow();
  });

  it('stores the code via a single atomic EVAL, keyed by a hash (raw code never persisted)', async () => {
    await oauthModel.saveAuthorizationCode(mkCode(), { id: 'c1' } as any, { id: 1 } as any);
    expect(h.evalCalls).toHaveLength(1);
    const [, opts] = h.evalCalls[0] as [unknown, { arguments: unknown[] }];
    // arguments[0] is the hash field — must be a sha256 hex, not the raw code.
    expect(opts.arguments[0]).not.toBe('raw-code-value');
    expect(opts.arguments[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('oauthModel.revokeToken — routine rotation does NOT cascade (resolved 2026-06-19, §D.x)', () => {
  it('deletes ONLY the rotated refresh token, never the (user, client) access tokens', async () => {
    h.deleteResults.push({ numDeletedRows: 1n }); // refresh delete
    const ok = await oauthModel.revokeToken({
      refreshToken: 'rt',
      client: { id: 'pub-1' },
      user: { id: 7 },
    } as any);
    expect(ok).toBe(true);
    // Exactly ONE deleteFrom('ApiKey') chain ran (the refresh, keyed by hash + type). The access-token
    // cascade was moved to the /revoke endpoint — routine refresh rotation calls this and must not log a
    // user out of a second concurrent session. So `clientId` must NEVER appear in a delete WHERE here.
    const whereColumns = h.calls.deletes.map((c: any) => c[0]);
    expect(whereColumns).toContain('key');
    expect(whereColumns).toContain('type');
    expect(whereColumns).not.toContain('clientId');
  });

  it('returns false when no refresh token row was deleted', async () => {
    h.deleteResults.push({ numDeletedRows: 0n });
    const ok = await oauthModel.revokeToken({ refreshToken: 'nope', client: {}, user: {} } as any);
    expect(ok).toBe(false);
  });
});
