import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

/**
 * The token route's rate limits: the per-IP `token` bucket as before, and past it, a confidential
 * system app with a staff-set `tokenRateLimit` that authenticates goes on under that limit, and only failed
 * secret checks count against the per-IP `token-overflow` budget. The per-IP
 * limit is unchanged for every caller; the overflow path only ever lets more through. Runs the real route and OAuth library
 * with a client_credentials grant; the database, redis and side effects are stubbed.
 */

const h = vi.hoisted(() => ({
  client: undefined as Record<string, unknown> | undefined,
  // Buckets that are exhausted for this test; every other check passes.
  exhausted: new Set<string>(),
  checks: [] as Array<[string, string | null | undefined]>,
}));

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.selectAll = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(table === 'OauthClient' ? h.client : undefined);
      qb.execute = () => Promise.resolve([]);
      return qb;
    },
    insertInto() {
      const qb: Record<string, unknown> = {};
      qb.values = () => qb;
      qb.execute = () => Promise.resolve([{}]);
      return qb;
    },
  },
}));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('@civitai/auth/secret-hash', () => ({
  generateSecretHash: (s: string) => `hash:${s}`,
  generateKey: () => 'k'.repeat(36),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => undefined,
}));
vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: async (bucket: string, id: string | null | undefined) => {
    h.checks.push([bucket, id]);
    return !h.exhausted.has(bucket);
  },
  tokenOverflowExhausted: async () => h.exhausted.has('token-overflow'),
  checkClientTokenRateLimit: async (id: string, limit: number) => {
    h.checks.push([`token-client:${limit}`, id]);
    return !h.exhausted.has('token-client');
  },
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));

import { POST } from '../+server';

const IP = '203.0.113.9';
const SECRET = 'the-client-secret';

function client(over: Record<string, unknown> = {}) {
  return {
    id: 'ads',
    isConfidential: true,
    secret: `hash:${SECRET}`,
    grants: ['authorization_code', 'refresh_token', 'client_credentials'],
    redirectUris: ['https://ads.example.com/auth/callback'],
    allowedOrigins: [],
    allowedScopes: 1,
    tokenRateLimit: 1000,
    userId: -1, // a system app: only those keep a token limit
    ...over,
  };
}

async function token(
  opts: { secret?: string | null; basic?: boolean; grantType?: string } = {}
): Promise<number> {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const body = new URLSearchParams({ grant_type: opts.grantType ?? 'client_credentials' });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.basic && secret !== null) {
    headers.authorization = `Basic ${Buffer.from(`ads:${secret}`).toString('base64')}`;
  } else {
    body.set('client_id', 'ads');
    if (secret !== null) body.set('client_secret', secret);
  }
  const res = await POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers,
      body,
    }),
  } as never);
  return res.status;
}

const bucketsChecked = () => h.checks.map(([bucket]) => bucket);

beforeEach(() => {
  h.client = client();
  h.exhausted.clear();
  h.checks.length = 0;
});

describe('token rate limits', () => {
  it('under the per-IP limit, charges only the IP, as before', async () => {
    expect(await token()).toBe(200);
    expect(h.checks).toEqual([['token', IP]]);
  });

  it('past the per-IP limit, lets an authenticated system app through under its staff-set limit', async () => {
    h.exhausted.add('token');
    for (const basic of [false, true]) {
      h.checks.length = 0;
      expect(await token({ basic })).toBe(200);
      // A secret that checks out never counts against the failed-check budget.
      expect(h.checks).toEqual([
        ['token', IP],
        ['token-client:1000', 'ads'],
      ]);
    }
  });

  it('is never held to the failed-check budget, so its own limit can exceed it', async () => {
    // One app's pods share an egress IP: hundreds of good requests a minute must not use up token-overflow.
    h.exhausted.add('token');
    for (let i = 0; i < 200; i++) expect(await token()).toBe(200);
    expect(bucketsChecked()).not.toContain('token-overflow');
  });

  it('counts a wrong secret against the failed-check budget, never the client bucket', async () => {
    h.exhausted.add('token');
    expect(await token({ secret: 'wrong' })).toBe(429);
    expect(bucketsChecked()).toEqual(['token', 'token-overflow']);
  });

  it('gives a public client, or a request with no secret, the per-IP limit only', async () => {
    h.exhausted.add('token');
    expect(await token({ secret: null })).toBe(429);
    expect(bucketsChecked()).toEqual(['token']);

    h.checks.length = 0;
    h.client = client({ isConfidential: false, secret: null });
    expect(await token()).toBe(429);
    expect(bucketsChecked()).not.toContain('token-client:1000');
  });

  it('refuses an IP that used up its failed-check budget before checking any secret', async () => {
    h.exhausted.add('token').add('token-overflow');
    h.client = undefined; // would 401 if the secret were checked
    expect(await token()).toBe(429);
    expect(bucketsChecked()).toEqual(['token']);
  });

  it('gives a client with no staff-set limit, or one that is not a system app, the per-IP limit only', async () => {
    for (const over of [{ tokenRateLimit: null }, { userId: 7 }]) {
      h.exhausted.add('token');
      h.checks.length = 0;
      h.client = client(over);
      expect(await token()).toBe(429);
      expect(bucketsChecked()).toEqual(['token']);
    }
  });

  it('refuses a client past its own limit', async () => {
    h.exhausted.add('token').add('token-client');
    expect(await token()).toBe(429);
  });

  it('leaves the worker exchange on its own per-IP bucket', async () => {
    h.exhausted.add('worker-token');
    expect(await token({ grantType: 'urn:ietf:params:oauth:grant-type:token-exchange' })).toBe(429);
    expect(bucketsChecked()).toEqual(['worker-token']);
  });
});
