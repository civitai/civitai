import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  delete process.env.AUTH_COOKIE_DOMAIN;
});
vi.mock('$lib/server/auth/registry', () => ({ sessions: { invalidateToken: vi.fn() } }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: async () => () => true,
}));
vi.mock('$lib/server/db/db', () => ({ db: {} }));

import { POST } from '../+server';

// The hub's cookie jar as the browser holds it. `domain` undefined = host-only on auth.civitai.com. A delete
// only removes the entry whose scope it names, and the browser ignores a `__Host-` write that has a Domain or
// lacks Secure — so a test passes only if the hub emits a delete the browser would actually apply.
type Entry = { name: string; value: string; domain?: string };
const norm = (d?: string) => d?.replace(/^\./, '');

function hubJar(entries: Entry[]) {
  const jar = [...entries];
  const cookies = {
    get: (name: string) => jar.find((e) => e.name === name)?.value,
    getAll: () => jar.map(({ name, value }) => ({ name, value })),
    set: vi.fn(),
    serialize: vi.fn(),
    delete: (name: string, opts: { path: string; domain?: string; secure?: boolean }) => {
      if (name.startsWith('__Host-') && (opts.domain || opts.secure === false || opts.path !== '/'))
        return;
      const i = jar.findIndex((e) => e.name === name && norm(e.domain) === norm(opts.domain));
      if (i !== -1) jar.splice(i, 1);
    },
  };
  return { jar, cookies };
}

const NAMES = [
  '__Host-civ-token',
  '__Host-civ-device',
  '__Secure-civ-token',
  '__Secure-civ-device',
];

async function logout(cookies: unknown) {
  try {
    await POST({
      cookies,
      locals: {},
      url: new URL('https://auth.civitai.com/logout?returnUrl=https://civitai.com/'),
    } as never);
  } catch (e) {
    if ((e as { status?: number }).status !== 302) throw e;
  }
}

describe('POST /logout clears every session and device name from the hub', () => {
  it('leaves none of the four names in the hub jar', async () => {
    const { jar, cookies } = hubJar([
      { name: '__Host-civ-token', value: 'J' },
      { name: '__Host-civ-device', value: 'D' },
      { name: '__Secure-civ-token', value: 'J0', domain: '.civitai.com' },
      { name: '__Secure-civ-device', value: 'D', domain: '.civitai.com' },
    ]);
    await logout(cookies);
    expect(jar.filter((e) => NAMES.includes(e.name))).toEqual([]);
  });

  it('also clears a host-only copy of the shared names', async () => {
    const { jar, cookies } = hubJar([
      { name: '__Secure-civ-token', value: 'J0' },
      { name: '__Secure-civ-device', value: 'D' },
    ]);
    await logout(cookies);
    expect(jar).toEqual([]);
  });
});
