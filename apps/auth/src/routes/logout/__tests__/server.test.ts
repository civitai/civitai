import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/registry', () => ({ sessions: { invalidateToken: vi.fn() } }));
vi.mock('$lib/server/oauth/first-party', () => ({ buildPostLoginOriginCheck: vi.fn() }));
vi.mock('$lib/server/db/db', () => ({ db: {} }));

import { GET } from '../+server';

describe('GET /logout landing page', () => {
  // Its auto-submitted POST must carry the hub's Origin; under `no-referrer` browsers send `Origin: null`,
  // which the logout origin check refuses, and the cross-domain logout stops halfway.
  it('lets its own form POST send the hub Origin', async () => {
    const res = await GET({
      url: new URL('https://auth.civitai.com/logout?returnUrl=https://civitai.red/'),
    } as never);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(await res.text()).not.toMatch(/noreferrer|name="referrer"/);
  });
});
