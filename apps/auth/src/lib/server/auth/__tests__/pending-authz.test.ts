import { describe, it, expect, vi, beforeEach } from 'vitest';

// The pending record is the ONLY thing standing in for a session on the hop from the login callback to
// /api/auth/oauth/authorize, so its two guards are load-bearing: it is consumed exactly once, and it only
// authorizes the redirect_uri it was minted for. Both are asserted here directly against a fake redis.

const store = new Map<string, string>();
const sys = {
  set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  del: vi.fn(async (key: string) => void store.delete(key)),
};
const getSysRedis = vi.fn((): typeof sys | null => sys);

vi.mock('../../redis', () => ({ getSysRedis: () => getSysRedis() }));

import { consumePendingAuthz, issuePendingAuthz } from '../pending-authz';
import type { Cookies } from '@sveltejs/kit';

const RED_DOMAIN = 'civitai.red';
const RED_CALLBACK = 'https://civitai.red/api/auth/callback';

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

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  getSysRedis.mockReturnValue(sys);
});

describe('issue → consume', () => {
  it('returns the user for a redirect_uri on the domain it was minted for', async () => {
    const cookies = makeCookies();
    expect(await issuePendingAuthz(cookies, 200, RED_DOMAIN)).toBe(true);

    expect(await consumePendingAuthz(cookies, RED_CALLBACK)).toBe(200);
  });

  it('is SINGLE USE — a replay of the same cookie gets nothing', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, RED_DOMAIN);
    // Capture the name BEFORE consuming empties the jar. Reading it after and defaulting to a literal
    // `civ-pending` would silently re-present under a name the code never reads whenever isSecureCookie() is
    // true (NEXT_PUBLIC_BASE_URL / AUTH_JWT_ISSUER set to an https url in a shell or CI), and the replay
    // would then "pass" for the wrong reason.
    const [[name, id]] = [...cookies._store.entries()];

    expect(await consumePendingAuthz(cookies, RED_CALLBACK)).toBe(200);

    // Re-present the same id, as a back-button would.
    cookies._store.set(name, id);
    expect(await consumePendingAuthz(cookies, RED_CALLBACK)).toBeUndefined();
  });

  it('refuses a redirect_uri on a DIFFERENT registrable domain than it was minted for', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, RED_DOMAIN);

    expect(
      await consumePendingAuthz(cookies, 'https://civitai.com/api/auth/callback')
    ).toBeUndefined();
  });

  it('refuses when the authorization names no redirect_uri', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, RED_DOMAIN);

    expect(await consumePendingAuthz(cookies, undefined)).toBeUndefined();
  });

  it('LEAVES the record on a mismatch, so a concurrent authorize cannot burn it', async () => {
    const cookies = makeCookies();
    await issuePendingAuthz(cookies, 200, RED_DOMAIN);

    await consumePendingAuthz(cookies, 'https://civitai.com/api/auth/callback');

    expect(cookies.delete).not.toHaveBeenCalled();
    expect(cookies._store.size).toBe(1); // cookie still set
    expect(store.size).toBe(1); // record still in redis
    // ...and the flow it belongs to still works.
    expect(await consumePendingAuthz(cookies, RED_CALLBACK)).toBe(200);
  });

  it('stores nothing and reports failure when redis is unavailable', async () => {
    getSysRedis.mockReturnValue(null);
    const cookies = makeCookies();

    expect(await issuePendingAuthz(cookies, 200, RED_DOMAIN)).toBe(false);
    expect(cookies._store.size).toBe(0); // no cookie without a record behind it
  });

  it('returns nothing when the request carries no pending cookie', async () => {
    expect(await consumePendingAuthz(makeCookies(), RED_CALLBACK)).toBeUndefined();
    expect(sys.get).not.toHaveBeenCalled();
  });
});

// The counters are the ONLY signal that this mechanism is live in prod: every failure mode falls back to
// writing the hub session, so a broken deploy still logs people in and looks identical to a working one.
// An unasserted metric is decoration, so pin that each outcome actually moves its own counter.
describe('observability', () => {
  const read = async (name: string, outcome: string) => {
    const { register } = await import('../../metrics');
    const metric = await register.getSingleMetric(name)?.get();
    return metric?.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
  };
  const issued = () => read('hub_cross_domain_handoff_total', 'issued');
  const fellBack = () => read('hub_cross_domain_handoff_total', 'fell_back');
  const consumed = (outcome: string) => read('hub_cross_domain_handoff_consume_total', outcome);

  it('counts a stored record as issued, and a redis-less one as fell_back', async () => {
    const before = { issued: await issued(), fellBack: await fellBack() };

    await issuePendingAuthz(makeCookies(), 200, RED_DOMAIN);
    expect(await issued()).toBe(before.issued + 1);

    getSysRedis.mockReturnValue(null);
    await issuePendingAuthz(makeCookies(), 200, RED_DOMAIN);
    expect(await fellBack()).toBe(before.fellBack + 1);
  });

  it('counts each consume outcome under its own label', async () => {
    const before = {
      matched: await consumed('matched'),
      mismatch: await consumed('domain_mismatch'),
      absent: await consumed('absent'),
    };

    const a = makeCookies();
    await issuePendingAuthz(a, 200, RED_DOMAIN);
    await consumePendingAuthz(a, RED_CALLBACK);
    expect(await consumed('matched')).toBe(before.matched + 1);

    const b = makeCookies();
    await issuePendingAuthz(b, 200, RED_DOMAIN);
    await consumePendingAuthz(b, 'https://civitai.com/api/auth/callback');
    expect(await consumed('domain_mismatch')).toBe(before.mismatch + 1);

    const c = makeCookies();
    await issuePendingAuthz(c, 200, RED_DOMAIN);
    store.clear(); // record expired out from under the cookie
    await consumePendingAuthz(c, RED_CALLBACK);
    expect(await consumed('absent')).toBe(before.absent + 1);
  });
});
