import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

vi.mock('$lib/server/auth/rate-limit', () => ({ checkRateLimit: async () => true }));
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
  process.env.DISCORD_CLIENT_ID = 'client-123';
  process.env.DISCORD_CLIENT_SECRET = 'secret';
});

describe('/login/discord start', () => {
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
