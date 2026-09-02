import { describe, it, expect, vi, beforeEach } from 'vitest';

// The db fake below FILTERS rather than returning a canned row: `type = 'Access'` and the
// not-expired disjunction are enforced in SQL, so a fake that ignores `.where` would make the
// expired-token and wrong-type arms pass no matter what the route queries.

const h = vi.hoisted(() => {
  // generateSecretHash salts with NEXTAUTH_SECRET (and @civitai/auth memoises its env on first
  // read), so this must be set before any module in the graph calls it.
  process.env.NEXTAUTH_SECRET = 'introspect-test-secret';
  return {
    clients: [] as Record<string, unknown>[],
    apiKeys: [] as Record<string, unknown>[],
    rateLimitOk: true,
    rateLimitCalls: [] as (string | null | undefined)[],
  };
});

type Row = Record<string, unknown>;
type Clause = (row: Row) => boolean;

const eb = Object.assign(
  (column: string, op: string, value: unknown): Clause => {
    const field = column.split('.').pop() as string;
    return (row) => {
      const actual = row[field];
      if (op === '=' || op === 'is') return actual === value;
      if (op === '>=')
        return (
          actual instanceof Date && value instanceof Date && actual.getTime() >= value.getTime()
        );
      throw new Error(`the db fake does not implement operator "${op}"`);
    };
  },
  { or: (clauses: Clause[]): Clause => (row) => clauses.some((c) => c(row)) }
);

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const clauses: Clause[] = [];
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.innerJoin = () => qb;
      qb.where = (a: unknown, op?: string, value?: unknown) => {
        clauses.push(
          typeof a === 'function'
            ? (a as (b: typeof eb) => Clause)(eb)
            : eb(a as string, op as string, value)
        );
        return qb;
      };
      qb.executeTakeFirst = () => {
        const rows = table === 'OauthClient' ? h.clients : h.apiKeys;
        return Promise.resolve(rows.find((row) => clauses.every((c) => c(row))));
      };
      return qb;
    },
  },
}));

vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: vi.fn(async (_bucket: string, id: string | null | undefined) => {
    h.rateLimitCalls.push(id);
    return h.rateLimitOk;
  }),
}));

import { generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { POST } from '../+server';

const LINK_SCOPE =
  TokenScope.UserRead | TokenScope.VaultRead | TokenScope.VaultWrite | TokenScope.LinkConnect;
const CALLER = 'link-service';
const CALLER_SECRET = 'link-service-secret';
const EXPIRES_AT = new Date('2030-01-01T00:00:00.000Z');

function post(body: Record<string, string>, headers: Record<string, string> = {}) {
  return POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/introspect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body).toString(),
    }),
  } as never);
}

function basic(id: string, secret: string) {
  return {
    authorization: `Basic ${Buffer.from(
      `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`
    ).toString('base64')}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A space after the comma on purpose — the parser must trim.
  process.env.OAUTH_INTROSPECTION_CLIENT_IDS = `${CALLER}, civitai-link-desktop`;
  h.rateLimitOk = true;
  h.rateLimitCalls = [];
  h.clients = [
    { id: CALLER, secret: generateSecretHash(CALLER_SECRET), isConfidential: true },
    // Allowlisted but PUBLIC — must still be refused.
    { id: 'civitai-link-desktop', secret: null, isConfidential: false },
    // Confidential with a real secret, but NOT on the allowlist.
    { id: 'rogue-service', secret: generateSecretHash('rogue-secret'), isConfidential: true },
  ];
  h.apiKeys = [
    {
      key: generateSecretHash('civitai_live'),
      type: 'Access',
      userId: 4242,
      username: 'manuel',
      tokenScope: LINK_SCOPE,
      clientId: 'civitai-link-desktop',
      expiresAt: EXPIRES_AT,
    },
    {
      key: generateSecretHash('civitai_expired'),
      type: 'Access',
      userId: 4242,
      username: 'manuel',
      tokenScope: LINK_SCOPE,
      clientId: 'civitai-link-desktop',
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    },
    {
      key: generateSecretHash('civitai_refresh'),
      type: 'Refresh',
      userId: 4242,
      username: 'manuel',
      tokenScope: LINK_SCOPE,
      clientId: 'civitai-link-desktop',
      expiresAt: EXPIRES_AT,
    },
    {
      key: generateSecretHash('civitai_forever'),
      type: 'Access',
      userId: 77,
      username: 'ops',
      tokenScope: TokenScope.UserRead,
      clientId: null,
      expiresAt: null,
    },
  ];
});

describe('introspect — active tokens', () => {
  it('returns the full RFC 7662 body for a live access token', async () => {
    const res = await post({
      token: 'civitai_live',
      client_id: CALLER,
      client_secret: CALLER_SECRET,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      active: true,
      sub: '4242',
      username: 'manuel',
      scope: String(LINK_SCOPE),
      client_id: 'civitai-link-desktop',
      exp: Math.floor(EXPIRES_AT.getTime() / 1000),
      token_type: 'Bearer',
    });
    // `scope` is the DECIMAL BITMASK STRING this provider uses everywhere, not the RFC's
    // space-separated list — link-service tests the LinkConnect bit against it.
    expect(Number(body.scope) & TokenScope.LinkConnect).toBe(TokenScope.LinkConnect);
  });

  it('omits exp for a token with no expiry', async () => {
    const res = await post({
      token: 'civitai_forever',
      client_id: CALLER,
      client_secret: CALLER_SECRET,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.active).toBe(true);
    expect(body.sub).toBe('77');
    expect(body.username).toBe('ops');
    expect('exp' in body).toBe(false);
    expect(body.client_id).toBeUndefined();
  });

  it('is no-store and sets no CORS headers (server-to-server only)', async () => {
    const res = await post({
      token: 'civitai_live',
      client_id: CALLER,
      client_secret: CALLER_SECRET,
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts client credentials over HTTP Basic, in preference to the body', async () => {
    const res = await post(
      { token: 'civitai_live', client_id: 'rogue-service', client_secret: 'wrong' },
      basic(CALLER, CALLER_SECRET)
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { active: boolean }).active).toBe(true);
  });
});

describe('introspect — inactive tokens all answer 200 {active:false}', () => {
  it.each([
    ['an expired access token', 'civitai_expired'],
    ['a refresh token (wrong type)', 'civitai_refresh'],
    ['an unknown token', 'civitai_nope'],
    ['a missing token parameter', ''],
  ])('%s', async (_label, token) => {
    const res = await post({ token, client_id: CALLER, client_secret: CALLER_SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('introspect — client authentication', () => {
  it('401 invalid_client on a wrong secret, even for a token that IS active', async () => {
    const res = await post({
      token: 'civitai_live',
      client_id: CALLER,
      client_secret: 'not-the-secret',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_client' });
  });

  it('401 invalid_client for a PUBLIC client, even though it is allowlisted', async () => {
    const res = await post({
      token: 'civitai_live',
      client_id: 'civitai-link-desktop',
      client_secret: 'anything',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_client' });
  });

  it('401 invalid_client for a confidential client that is NOT allowlisted', async () => {
    const res = await post({
      token: 'civitai_live',
      client_id: 'rogue-service',
      client_secret: 'rogue-secret',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_client' });
  });

  it('401 invalid_client when the allowlist is empty (unset env locks the endpoint down)', async () => {
    process.env.OAUTH_INTROSPECTION_CLIENT_IDS = '';
    const res = await post({
      token: 'civitai_live',
      client_id: CALLER,
      client_secret: CALLER_SECRET,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_client' });
  });
});

describe('introspect — rate limiting', () => {
  it('429 rate_limited, keyed on client_id', async () => {
    h.rateLimitOk = false;
    const res = await post({
      token: 'civitai_live',
      client_id: CALLER,
      client_secret: CALLER_SECRET,
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(h.rateLimitCalls).toEqual([CALLER]);
  });

  it('reads the limiter with the client id from HTTP Basic too', async () => {
    h.rateLimitOk = false;
    const res = await post({ token: 'civitai_live' }, basic(CALLER, CALLER_SECRET));
    expect(res.status).toBe(429);
    expect(h.rateLimitCalls).toEqual([CALLER]);
  });
});
