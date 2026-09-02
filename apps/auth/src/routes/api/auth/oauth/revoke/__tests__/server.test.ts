import { describe, it, expect, vi, beforeEach } from 'vitest';

// The db fake FILTERS on every `.where` rather than returning canned rows: the token lookup keys on
// `key` + `type`, and every authorisation arm turns on `userId` / `clientId`, so a fake that ignored
// `.where` would let the wrong-client and wrong-user cases pass whatever the route actually does.

const h = vi.hoisted(() => {
  // generateSecretHash salts with NEXTAUTH_SECRET (and @civitai/auth memoises its env on first
  // read), so this must be set before any module in the graph calls it.
  process.env.NEXTAUTH_SECRET = 'revoke-test-secret';
  return {
    clientIp: '203.0.113.9',
    clients: [] as Record<string, unknown>[],
    apiKeys: [] as Record<string, unknown>[],
    rateLimitAllow: true,
    rateLimitCalls: [] as [string, string | null | undefined][],
    auditEvents: [] as Record<string, unknown>[],
  };
});

type Row = Record<string, unknown>;
type Clause = (row: Row) => boolean;

function clause(column: string, op: string, value: unknown): Clause {
  if (op !== '=') throw new Error(`the db fake does not implement operator "${op}"`);
  const field = column.split('.').pop() as string;
  return (row) => row[field] === value;
}

function rowsFor(table: string): Row[] {
  if (table === 'OauthClient') return h.clients;
  if (table === 'ApiKey') return h.apiKeys;
  throw new Error(`the db fake does not know the table "${table}"`);
}

vi.mock('$lib/server/db/db', () => {
  const builder = (table: string) => {
    const clauses: Clause[] = [];
    const qb: Record<string, unknown> = {};
    qb.select = () => qb;
    qb.where = (column: string, op: string, value: unknown) => {
      clauses.push(clause(column, op, value));
      return qb;
    };
    qb.executeTakeFirst = () =>
      Promise.resolve(rowsFor(table).find((row) => clauses.every((c) => c(row))));
    qb.execute = () => {
      const rows = rowsFor(table);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (clauses.every((c) => c(rows[i]))) rows.splice(i, 1);
      }
      return Promise.resolve([]);
    };
    return qb;
  };
  return { db: { selectFrom: builder, deleteFrom: builder } };
});

vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: vi.fn(async (bucket: string, id: string | null | undefined) => {
    h.rateLimitCalls.push([bucket, id]);
    return h.rateLimitAllow;
  }),
}));

vi.mock('$lib/server/oauth/audit-log', () => ({
  logOAuthEvent: vi.fn((event: Record<string, unknown>) => {
    h.auditEvents.push(event);
  }),
}));

vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => h.clientIp }));

import { generateSecretHash } from '@civitai/auth/secret-hash';
import { POST } from '../+server';

const PUBLIC_CLIENT = 'civitai-link-desktop';
const OTHER_PUBLIC_CLIENT = 'other-desktop';
const CONFIDENTIAL_CLIENT = 'link-service';
const CONFIDENTIAL_SECRET = 'link-service-secret';
const TOKEN_OWNER = 4242;
const CONFIDENTIAL_OWNER = 99;

function post(body: Record<string, string>, opts: { user?: { id: number }; origin?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.origin) headers.origin = opts.origin;
  return POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/revoke', {
      method: 'POST',
      headers,
      body: new URLSearchParams(body).toString(),
    }),
    locals: { user: opts.user },
  } as never);
}

const stored = (token: string) => h.apiKeys.some((row) => row.key === generateSecretHash(token));

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimitAllow = true;
  h.rateLimitCalls = [];
  h.auditEvents = [];
  h.clients = [
    {
      id: PUBLIC_CLIENT,
      userId: 1,
      secret: null,
      isConfidential: false,
      allowedOrigins: ['https://link.civitai.com'],
    },
    { id: OTHER_PUBLIC_CLIENT, userId: 1, secret: null, isConfidential: false, allowedOrigins: [] },
    {
      id: CONFIDENTIAL_CLIENT,
      userId: CONFIDENTIAL_OWNER,
      secret: generateSecretHash(CONFIDENTIAL_SECRET),
      isConfidential: true,
      allowedOrigins: [],
    },
    // Registered confidential, but its stored secret is NULL — must never authenticate.
    {
      id: 'secretless-service',
      userId: 5,
      secret: null,
      isConfidential: true,
      allowedOrigins: [],
    },
  ];
  // Distinct `id`s matter: the route deletes the matched row BY id, so rows sharing one (or all
  // missing it) would let a single revoke wipe the table and every isolation assertion below.
  h.apiKeys = [
    {
      id: 1,
      key: generateSecretHash('link_refresh'),
      type: 'Refresh',
      userId: TOKEN_OWNER,
      clientId: PUBLIC_CLIENT,
    },
    {
      id: 2,
      key: generateSecretHash('link_access'),
      type: 'Access',
      userId: TOKEN_OWNER,
      clientId: PUBLIC_CLIENT,
    },
    {
      id: 3,
      key: generateSecretHash('link_access_2'),
      type: 'Access',
      userId: TOKEN_OWNER,
      clientId: PUBLIC_CLIENT,
    },
    {
      id: 4,
      key: generateSecretHash('other_access'),
      type: 'Access',
      userId: TOKEN_OWNER,
      clientId: OTHER_PUBLIC_CLIENT,
    },
    {
      id: 5,
      key: generateSecretHash('conf_access'),
      type: 'Access',
      userId: CONFIDENTIAL_OWNER,
      clientId: CONFIDENTIAL_CLIENT,
    },
    {
      id: 6,
      key: generateSecretHash('stranger_access'),
      type: 'Access',
      userId: 7,
      clientId: null,
    },
  ];
});

describe('revoke — a public client may revoke a token it holds', () => {
  it('revokes an access token issued to the client presenting it', async () => {
    const res = await post({ token: 'link_access', client_id: PUBLIC_CLIENT });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(stored('link_access')).toBe(false);
    expect(h.auditEvents).toEqual([
      { type: 'token.revoked', userId: TOKEN_OWNER, clientId: PUBLIC_CLIENT, ip: h.clientIp },
    ]);
  });

  it('revokes a refresh token and cascades that (user, client) access tokens only', async () => {
    const res = await post({
      token: 'link_refresh',
      token_type_hint: 'refresh_token',
      client_id: PUBLIC_CLIENT,
    });

    expect(res.status).toBe(200);
    expect(stored('link_refresh')).toBe(false);
    expect(stored('link_access')).toBe(false);
    expect(stored('link_access_2')).toBe(false);
    // Another client's token for the SAME user survives the cascade.
    expect(stored('other_access')).toBe(true);
  });

  it('honours the client allowedOrigins gate for a browser-origin request', async () => {
    const res = await post(
      { token: 'link_access', client_id: PUBLIC_CLIENT },
      { origin: 'https://evil.example' }
    );

    expect(res.status).toBe(403);
    expect(stored('link_access')).toBe(true);
  });
});

describe('revoke — a public client may NOT revoke anything else', () => {
  it('leaves a token issued to a DIFFERENT client alone', async () => {
    const res = await post({ token: 'other_access', client_id: PUBLIC_CLIENT });

    expect(res.status).toBe(200);
    expect(stored('other_access')).toBe(true);
    expect(h.auditEvents).toEqual([]);
  });

  it('leaves a token with no client alone', async () => {
    const res = await post({ token: 'stranger_access', client_id: PUBLIC_CLIENT });

    expect(res.status).toBe(200);
    expect(stored('stranger_access')).toBe(true);
  });

  it('gains nothing from naming a client that is not registered', async () => {
    const res = await post({ token: 'link_access', client_id: 'not-registered' });

    expect(res.status).toBe(200);
    expect(stored('link_access')).toBe(true);
  });

  it('answers byte-identical 200s whether or not a token was revoked', async () => {
    const hit = await post({ token: 'link_access', client_id: PUBLIC_CLIENT });
    const miss = await post({ token: 'never-issued', client_id: PUBLIC_CLIENT });
    const refused = await post({ token: 'other_access', client_id: PUBLIC_CLIENT });

    expect([hit.status, miss.status, refused.status]).toEqual([200, 200, 200]);
    const bodies = await Promise.all([hit.json(), miss.json(), refused.json()]);
    expect(bodies).toEqual([{}, {}, {}]);
  });
});

describe('revoke — the confidential-client gate is unchanged', () => {
  it('refuses a confidential client that presents no secret', async () => {
    const res = await post({ token: 'conf_access', client_id: CONFIDENTIAL_CLIENT });

    expect(res.status).toBe(200);
    expect(stored('conf_access')).toBe(true);
    expect(h.auditEvents).toEqual([]);
  });

  it('refuses a confidential client that presents the wrong secret', async () => {
    const res = await post({
      token: 'conf_access',
      client_id: CONFIDENTIAL_CLIENT,
      client_secret: 'not-the-secret',
    });

    expect(res.status).toBe(200);
    expect(stored('conf_access')).toBe(true);
  });

  it('refuses a confidential client whose stored secret is null', async () => {
    const res = await post({
      token: 'conf_access',
      client_id: 'secretless-service',
      client_secret: 'anything',
    });

    expect(res.status).toBe(200);
    expect(stored('conf_access')).toBe(true);
  });

  it('still revokes for a confidential client that proves its secret', async () => {
    const res = await post({
      token: 'conf_access',
      client_id: CONFIDENTIAL_CLIENT,
      client_secret: CONFIDENTIAL_SECRET,
    });

    expect(res.status).toBe(200);
    expect(stored('conf_access')).toBe(false);
  });
});

describe('revoke — the session-cookie path is unchanged', () => {
  it('revokes the signed-in user own token', async () => {
    const res = await post({ token: 'link_access' }, { user: { id: TOKEN_OWNER } });

    expect(res.status).toBe(200);
    expect(stored('link_access')).toBe(false);
  });

  it('leaves another user token alone', async () => {
    const res = await post({ token: 'stranger_access' }, { user: { id: TOKEN_OWNER } });

    expect(res.status).toBe(200);
    expect(stored('stranger_access')).toBe(true);
  });

  it('revokes nothing for an anonymous request with no client_id', async () => {
    const res = await post({ token: 'link_access' });

    expect(res.status).toBe(200);
    expect(stored('link_access')).toBe(true);
  });
});

describe('revoke — request handling is unchanged', () => {
  it('400s a request with no token', async () => {
    const res = await post({ client_id: PUBLIC_CLIENT });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('429s on the per-IP bucket before touching the database', async () => {
    h.rateLimitAllow = false;
    const res = await post({ token: 'link_access', client_id: PUBLIC_CLIENT });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(h.rateLimitCalls).toEqual([['revoke', h.clientIp]]);
    expect(stored('link_access')).toBe(true);
  });
});
