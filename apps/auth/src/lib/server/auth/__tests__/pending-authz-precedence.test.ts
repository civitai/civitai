import { describe, it, expect, vi, beforeEach } from 'vitest';

// The precedence between `locals.user` and the pending record, which /api/auth/oauth/authorize applies to
// decide WHOSE authorization code it issues.
//
// 🔴 This is where the first version of the fix was actively worse than the bug. It read
// `locals.user ?? pending`, and the pending record only exists BECAUSE the hub cookie was deliberately left
// on the previous user — so "add account on civitai.red while signed in on civitai.com as A" issued the code
// for A, and the user landed on .red as the account they had just switched away from. Two independent
// reviewers found it; no test did, because nothing covered this hop at all.
//
// consumePendingAuthz is the real module here (only redis is faked), so the domain binding and the
// spend-once behaviour are exercised rather than mocked.

const store = new Map<string, string>();
const sys = {
  set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  del: vi.fn(async (key: string) => void store.delete(key)),
};
vi.mock('../../redis', () => ({ getSysRedis: () => sys }));

import { issuePendingAuthz, resolveAuthorizingUser } from '../pending-authz';
import type { Cookies } from '@sveltejs/kit';

const RED_CALLBACK = 'https://civitai.red/api/auth/callback';
const GREEN_CALLBACK = 'https://civitai.com/api/auth/callback';

function makeCookies(): Cookies & { _store: Map<string, string> } {
  const jar = new Map<string, string>();
  return {
    _store: jar,
    set: vi.fn((name: string, value: string) => void jar.set(name, value)),
    get: (name: string) => jar.get(name),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    delete: vi.fn((name: string) => void jar.delete(name)),
    serialize: (name: string, value: string) => `${name}=${value}`,
  };
}

/**
 * The REAL decision function the route calls. An earlier version of this file re-implemented the precedence
 * line locally and asserted against the copy — so reverting the route to the broken order left all 425 tests
 * green. Drive the shipped function, never a restatement of it.
 */
async function resolveAuthorizingUser_(
  cookies: Cookies,
  redirectUri: string | undefined,
  localsUserId: number | undefined,
  resolveUser: (id: number) => Promise<number | null> = async (id) => id
): Promise<number | undefined> {
  return resolveAuthorizingUser({ cookies, redirectUri, sessionUser: localsUserId, resolveUser });
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('add-account on a foreign-scope spoke', () => {
  it('issues the code for the account just authenticated, NOT the stale hub session', async () => {
    // Signed in on civitai.com as 100; authenticates on civitai.red as 200.
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');

    expect(await resolveAuthorizingUser_(cookies, RED_CALLBACK, 100)).toBe(200);
  });

  it('spends the record, so a replay falls back to the hub session', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');
    await resolveAuthorizingUser_(cookies, RED_CALLBACK, 100);

    expect(await resolveAuthorizingUser_(cookies, RED_CALLBACK, 100)).toBe(100);
  });
});

describe('everything else still resolves from the hub session', () => {
  it('no pending record at all', async () => {
    expect(await resolveAuthorizingUser_(makeCookies(), GREEN_CALLBACK, 100)).toBe(100);
  });

  it('a record for ANOTHER domain does not hijack this authorization', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');

    // A green (or third-party) authorization running in another tab.
    expect(await resolveAuthorizingUser_(cookies, GREEN_CALLBACK, 100)).toBe(100);
  });

  it('and does NOT burn that record — the .red flow it belongs to still completes', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');

    await resolveAuthorizingUser_(cookies, GREEN_CALLBACK, 100);

    expect(await resolveAuthorizingUser_(cookies, RED_CALLBACK, 100)).toBe(200);
  });

  it('nobody signed in and no usable record → no user, so /authorize bounces to /login', async () => {
    expect(await resolveAuthorizingUser_(makeCookies(), RED_CALLBACK, undefined)).toBeUndefined();
  });
});

describe('host variation within the spoke domain is tolerated', () => {
  // The record's domain and the authorization's redirect_uri are derived on different requests by different
  // code; www/apex and SERVER_DOMAIN_*_ALIASES mean they can disagree on host. A refusal here would silently
  // fall back to writing the hub session — i.e. straight back to the bug — so the binding is domain-level.
  it.each([
    'https://www.civitai.red/api/auth/callback',
    'https://CIVITAI.RED/api/auth/callback',
    'https://test-auth.civitai.red/api/auth/callback',
  ])('%s still matches a record minted for civitai.red', async (redirectUri) => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');

    expect(await resolveAuthorizingUser_(cookies, redirectUri, 100)).toBe(200);
  });

  it('but a different registrable domain never does', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');

    expect(await resolveAuthorizingUser_(cookies, 'https://evil.example/cb', 100)).toBe(100);
  });
});

describe('fail closed', () => {
  // Once a record has been SPENT, the session is no longer an acceptable answer — it is by construction the
  // account being switched away from. A db blip while resolving the record's user must bounce the browser to
  // /login (which recovers: the retry is hub-relative, writes the hub session, and completes), NOT quietly
  // issue the code for the previous account. That fallback was the round-2 defect arriving through a
  // different door.
  it('a spent record whose user cannot be resolved yields NOBODY, not the previous account', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');

    const resolved = await resolveAuthorizingUser_(cookies, RED_CALLBACK, 100, async () => null);

    expect(resolved).toBeUndefined();
  });

  it('same when resolving throws', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, 'civitai.red');

    const resolved = await resolveAuthorizingUser_(cookies, RED_CALLBACK, 100, async () => {
      throw new Error('pool exhausted');
    });

    expect(resolved).toBeUndefined();
  });

  it('but an ordinary session request is unaffected when there is no record', async () => {
    const resolved = await resolveAuthorizingUser_(
      makeCookies(),
      GREEN_CALLBACK,
      100,
      async () => null
    );

    expect(resolved).toBe(100);
  });
});
