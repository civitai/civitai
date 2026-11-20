import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

const limit = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; retryAfter: number },
}));
vi.mock('$lib/server/auth/rate-limit', () => ({ consumeRateLimit: async () => limit.result }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));

import { GET } from '../+server';
import { NO_PKCE_COOKIE } from '$lib/server/auth/providers';

function start(query: Record<string, string>) {
  const url = new URL('https://auth.civitai.com/login/discord');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const set = new Map<string, string>();
  const deleted: string[] = [];
  const cookies = {
    set: (name: string, value: string) => set.set(name, value),
    delete: (name: string) => deleted.push(name),
    get: () => undefined,
  };
  const run = async () => {
    try {
      await GET({
        params: { provider: 'discord' },
        url,
        cookies,
        locals: { user: { id: 7 } },
        request: new Request(url),
      } as never);
    } catch (e) {
      if (isRedirect(e)) return new URL(e.location);
      throw e;
    }
    throw new Error('start route did not redirect');
  };
  return { run, set, deleted };
}

beforeEach(() => {
  limit.result = { ok: true };
  process.env.DISCORD_CLIENT_ID = 'client-123';
  process.env.DISCORD_CLIENT_SECRET = 'secret';
});

describe('/login/discord start', () => {
  const spent = (accept?: string) => {
    limit.result = { ok: false, retryAfter: 42 };
    const url = new URL('https://auth.civitai.com/login/discord');
    return GET({
      params: { provider: 'discord' },
      url,
      cookies: { set: vi.fn(), delete: vi.fn(), get: () => undefined },
      locals: {},
      request: new Request(url, accept ? { headers: { accept } } : undefined),
    } as never) as Promise<Response>;
  };

  it('answers a spent limit with a 429 that says when to retry, before any provider work', async () => {
    const res = await spent('application/json');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(await res.json()).toMatchObject({ error: 'rate_limited', retry_after: 42 });
  });

  it('shows a browser following the sign-in link a readable page, not JSON', async () => {
    const res = await spent('text/html,application/xhtml+xml,*/*;q=0.8');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain(
      'Too many sign-in attempts from your network. Try again in 42 seconds.'
    );
  });

  it('roles leg: no PKCE challenge, no verifier cookie, marks the flow as no-PKCE', async () => {
    const { run, set, deleted } = start({ link: 'true', roles: 'true' });
    const authorize = await run();
    expect(authorize.searchParams.get('scope')).toBe('identify email role_connections.write');
    expect(authorize.searchParams.has('code_challenge')).toBe(false);
    expect(authorize.searchParams.get('state')).toBe(set.get('oauth_state'));
    expect(set.has('oauth_verifier')).toBe(false);
    expect(deleted).toContain('oauth_verifier');
    expect(set.get(NO_PKCE_COOKIE)).toBe('discord');
  });

  it('login leg: PKCE challenge + verifier cookie, and clears any no-PKCE marker', async () => {
    const { run, set, deleted } = start({});
    const authorize = await run();
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    expect(set.get('oauth_verifier')).toBeTruthy();
    expect(set.has(NO_PKCE_COOKIE)).toBe(false);
    expect(deleted).toContain(NO_PKCE_COOKIE);
  });

  it.each([
    ['a plain link (no roles)', { link: 'true' }],
    ['roles without link', { roles: 'true' }],
  ])('%s keeps PKCE', async (_, query) => {
    const { run, set } = start(query);
    const authorize = await run();
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    expect(set.get('oauth_verifier')).toBeTruthy();
    expect(set.has(NO_PKCE_COOKIE)).toBe(false);
  });
});
