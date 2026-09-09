import { describe, it, expect, vi, beforeEach } from 'vitest';

// Blocklist reads a shared `system:blocklist:<type>` cache first, then falls back to the `Blocklist`
// DB table. There are TWO of those now — `EmailDomain` (exact) and `EmailDomainSuffix` (opt-in,
// covers subdomains) — and the key is derived from the type rather than passed beside it. Mock both
// collaborators (`../redis` + `../db/db`) so the unit under test — the redis→DB fallback +
// repopulate + degrade-open behavior — runs for real.
const h = vi.hoisted(() => ({
  getRedis: vi.fn(),
  executeTakeFirst: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
}));
vi.mock('../../redis', () => ({ getRedis: h.getRedis }));
vi.mock('../../db/db', () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: (...args: unknown[]) => {
          h.where(...args);
          // `orderBy` is modelled because the read now DEPENDS on it: without it a type with two
          // rows lets this app enforce a different list than the main app, which pins
          // `orderBy: id asc`. A mock that tolerated its absence would hide exactly that.
          return {
            orderBy: (...orderArgs: unknown[]) => {
              h.orderBy(...orderArgs);
              return { executeTakeFirst: h.executeTakeFirst };
            },
          };
        },
      }),
    }),
  },
}));

import {
  emailDomain,
  getBlockedEmailDomains,
  getBlockedEmailDomainSuffixes,
  isBlockedExactDomain,
  isBlockedEmailDomain,
  isBlockedSuffix,
  normalizeEmailAddress,
} from '../blocklist';

const BLOCKLIST_KEY = 'system:blocklist:EmailDomain';
const SUFFIX_KEY = 'system:blocklist:EmailDomainSuffix';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    // The options argument is modelled because the EXPIRY is now part of what this file asserts.
    // A fake narrower than the real client is a ceiling on what any test here can see.
    set: vi.fn(async (k: string, v: string, _options?: { EX: number }) => {
      store.set(k, v);
      return 'OK';
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('getBlockedEmailDomains', () => {
  it('returns the warm redis cache without touching the DB', async () => {
    const redis = makeRedis();
    redis._store.set(
      BLOCKLIST_KEY,
      JSON.stringify({ type: 'EmailDomain', data: ['evil.com', 'bad.io'] })
    );
    h.getRedis.mockReturnValue(redis);

    expect(await getBlockedEmailDomains()).toEqual(['evil.com', 'bad.io']);
    expect(h.executeTakeFirst).not.toHaveBeenCalled();
  });

  it('treats a cached blob with no data array as empty (no DB call)', async () => {
    const redis = makeRedis();
    redis._store.set(BLOCKLIST_KEY, JSON.stringify({ type: 'EmailDomain' }));
    h.getRedis.mockReturnValue(redis);
    expect(await getBlockedEmailDomains()).toEqual([]);
    expect(h.executeTakeFirst).not.toHaveBeenCalled();
  });

  it('falls back to the DB on a cold cache and repopulates redis', async () => {
    const redis = makeRedis(); // empty cache
    h.getRedis.mockReturnValue(redis);
    h.executeTakeFirst.mockResolvedValue({ data: ['db1.com', 'db2.com'] });

    expect(await getBlockedEmailDomains()).toEqual(['db1.com', 'db2.com']);
    expect(h.executeTakeFirst).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      BLOCKLIST_KEY,
      JSON.stringify({ type: 'EmailDomain', data: ['db1.com', 'db2.com'] }),
      { EX: expect.any(Number) }
    );
  });

  /**
   * This repopulate is what a moderator's edit has to outlive. The writers DELETE the key, so an
   * edit normally lands on the next read; what the delete cannot reach is a read that started
   * before the write and finishes after it, writing its pre-write copy back. The expiry is the
   * only bound on that, and it used to be a month.
   *
   * A ceiling rather than the exact number, so tuning the value needs no test edit while restoring
   * the month fails. The main app and the moderator spoke populate this same key and carry the
   * same bound.
   */
  it('repopulates with a bound of minutes, not a month', async () => {
    const redis = makeRedis();
    h.getRedis.mockReturnValue(redis);
    h.executeTakeFirst.mockResolvedValue({ data: ['db1.com'] });

    await getBlockedEmailDomains();

    const options = redis.set.mock.calls.at(-1)?.[2] as { EX?: number } | undefined;
    expect(options?.EX, 'the repopulate must set an expiry').toBeGreaterThan(0);
    expect(options?.EX, 'a stale copy must not be able to serve for hours').toBeLessThanOrEqual(
      15 * 60
    );
  });

  it('falls through to the DB when the cached JSON is corrupt', async () => {
    const redis = makeRedis();
    redis._store.set(BLOCKLIST_KEY, '{not valid json');
    h.getRedis.mockReturnValue(redis);
    h.executeTakeFirst.mockResolvedValue({ data: ['db.com'] });
    expect(await getBlockedEmailDomains()).toEqual(['db.com']);
    expect(h.executeTakeFirst).toHaveBeenCalledTimes(1);
  });

  it('queries the DB directly when redis is not configured (null)', async () => {
    h.getRedis.mockReturnValue(null);
    h.executeTakeFirst.mockResolvedValue({ data: ['db.com'] });
    expect(await getBlockedEmailDomains()).toEqual(['db.com']);
  });

  it('returns [] when the DB row is missing (empty blocklist)', async () => {
    h.getRedis.mockReturnValue(null);
    h.executeTakeFirst.mockResolvedValue(undefined);
    expect(await getBlockedEmailDomains()).toEqual([]);
  });

  it('degrades OPEN (returns []) when the DB query throws — a lookup failure must not block every login', async () => {
    h.getRedis.mockReturnValue(null);
    h.executeTakeFirst.mockRejectedValue(new Error('db unreachable'));
    expect(await getBlockedEmailDomains()).toEqual([]);
  });

  it('a redis get error still resolves via the DB fallback', async () => {
    const redis = makeRedis();
    redis.get.mockRejectedValue(new Error('redis down'));
    h.getRedis.mockReturnValue(redis);
    h.executeTakeFirst.mockResolvedValue({ data: ['db.com'] });
    expect(await getBlockedEmailDomains()).toEqual(['db.com']);
  });
});

describe('emailDomain', () => {
  // Both hub call sites go through this, so reverting either one to `split('@')[1]` cannot pass
  // unnoticed. The main app carries its own copy of the rule and its own test for it.
  it('reads the domain after the LAST @, not the first', () => {
    expect(emailDomain('"a@b"@example.com')).toBe('example.com');
  });

  it('lowercases and trims', () => {
    expect(emailDomain('someone@ Example.COM ')).toBe('example.com');
  });

  it('returns empty string for an address with no @', () => {
    expect(emailDomain('not-an-email')).toBe('');
  });

  it('returns empty string for a trailing @', () => {
    expect(emailDomain('someone@')).toBe('');
  });
});

describe('isBlockedExactDomain', () => {
  // Both sides must go through the same normalizer. Stripping the input but not the entry would
  // make a hand-typed `provider.com.` enforced by the main app and silently inert here.
  it('matches a list entry that carries a trailing FQDN dot', () => {
    expect(isBlockedExactDomain(['blocked.test.'], 'blocked.test')).toBe(true);
  });

  it('matches an entry with case and whitespace', () => {
    expect(isBlockedExactDomain(['  Blocked.TEST  '], 'blocked.test')).toBe(true);
  });

  it('matches the WHOLE domain, not a substring', () => {
    expect(isBlockedExactDomain(['ocked.test', 'test'], 'blocked.test')).toBe(false);
  });

  it('never matches an empty domain, whatever the list holds', () => {
    expect(isBlockedExactDomain([''], '')).toBe(false);
  });
});

describe('normalizeEmailAddress', () => {
  // `userExistsByEmail` is both the returning-user exemption and the `+`-alias gate, and both key
  // on the exact stored string, so a trailing dot would be a free second identity against both.
  it('strips a trailing FQDN dot from the domain', () => {
    expect(normalizeEmailAddress('someone@gmail.com.')).toBe('someone@gmail.com');
  });

  it('lowercases the domain and leaves the local part intact', () => {
    expect(normalizeEmailAddress('Someone@GMAIL.com')).toBe('Someone@gmail.com');
  });

  it('normalizes the domain after the LAST @', () => {
    expect(normalizeEmailAddress('"a@b"@GMAIL.com.')).toBe('"a@b"@gmail.com');
  });

  it('leaves an address with no @ alone beyond trim and case', () => {
    expect(normalizeEmailAddress(' NotAnEmail ')).toBe('notanemail');
  });
});

describe('EmailDomainSuffix', () => {
  /**
   * 🔴 A SEPARATE, opt-in list. The exact list stays exact on purpose: making it cover subdomains
   * would apply suffix semantics to the ~8,800 entries the main app's weekly upstream sync
   * maintains, 1,357 of which are already subdomains of a shared parent (`dynv6.net` alone has 337;
   * `co.uk` and `org.uk` are on it). Measured on production 2026-09-09.
   *
   * These must stay in step with `matchesBlockedSuffix` in the main app's
   * `src/server/services/blocklist.service.ts` — the same rule in two separately-released apps, and
   * changing one side only is how they diverge. Keep this case table identical to the one beside
   * that function.
   */
  it('matches the opted-in domain and anything under it', () => {
    expect(isBlockedSuffix(['farm.test'], 'farm.test')).toBe(true);
    expect(isBlockedSuffix(['farm.test'], 'a.farm.test')).toBe(true);
    expect(isBlockedSuffix(['farm.test'], 'a.b.c.farm.test')).toBe(true);
  });

  it('does NOT match a different registrable domain that merely ENDS with the entry', () => {
    // The branch that separates `endsWith('.' + entry)` from `endsWith(entry)`. Without the dot,
    // an entry of `farm.test` also blocks `notfarm.test`, which belongs to someone else.
    expect(isBlockedSuffix(['farm.test'], 'notfarm.test')).toBe(false);
  });

  it('does NOT match an unrelated domain while entries are present', () => {
    // Negative control: a matcher returning true unconditionally passes every case above.
    expect(isBlockedSuffix(['farm.test'], 'example.test')).toBe(false);
  });

  it('matches an entry written as a wildcard, with a leading dot, or messily', () => {
    expect(isBlockedSuffix(['*.farm.test'], 'a.farm.test')).toBe(true);
    expect(isBlockedSuffix(['.farm.test'], 'a.farm.test')).toBe(true);
    expect(isBlockedSuffix(['  Farm.TEST.  '], 'a.farm.test')).toBe(true);
  });

  it('matches a wildcard entry that ALSO carries leading whitespace', () => {
    // 🔴 The PRODUCT of the two cases above, and the cell where this function and the main app's
    // `matchesBlockedSuffix` actually disagreed: `SUFFIX_ENTRY_PREFIX` is `^`-anchored, so stripping
    // before trimming leaves the `*.` in place and the entry matches nothing. The table above
    // enumerated whitespace and wildcards independently and never their combination, which is how a
    // review found this and the tests did not.
    expect(isBlockedSuffix(['  *.farm.test'], 'a.farm.test')).toBe(true);
    expect(isBlockedSuffix(['	*.farm.test  '], 'farm.test')).toBe(true);
  });

  it('refuses a SINGLE-LABEL entry, so one typo cannot block a whole TLD', () => {
    // `com` is one keystroke from `com.example`, and nothing validates what a moderator types.
    // Without the `entry.includes('.')` guard this matches every domain under `.test`.
    expect(isBlockedSuffix(['test'], 'single-label.test')).toBe(false);
    expect(isBlockedSuffix(['*.test'], 'single-label.test')).toBe(false);
  });

  it('an entry that normalizes to EMPTY matches nothing, even for a domain ending in a dot', () => {
    // The trailing-dot domain is what makes this capable of failing. Delete the `if (!entry)` guard
    // and a `'.'` entry reduces to `''`, whose `endsWith('.')` is TRUE for `example.test.` — every
    // address on the site blocked by one stray character. Asserting only `example.test` here passes
    // with the guard removed, because a normalized domain never ends in a dot; the guard exists for
    // callers that hand this function a domain they have not normalized.
    expect(isBlockedSuffix(['.'], 'example.test.')).toBe(false);
    expect(isBlockedSuffix([''], 'example.test')).toBe(false);
    expect(isBlockedSuffix(['   '], 'example.test')).toBe(false);
  });

  it('reads the suffix list from its OWN redis key, not the exact list', async () => {
    const redis = makeRedis();
    redis._store.set(BLOCKLIST_KEY, JSON.stringify({ type: 'EmailDomain', data: ['exact.test'] }));
    redis._store.set(
      SUFFIX_KEY,
      JSON.stringify({ type: 'EmailDomainSuffix', data: ['suffix.test'] })
    );
    h.getRedis.mockReturnValue(redis);

    await expect(getBlockedEmailDomainSuffixes()).resolves.toEqual(['suffix.test']);
    await expect(getBlockedEmailDomains()).resolves.toEqual(['exact.test']);
  });

  it('orders the DB fallback by id so this app and the main app read the SAME row', async () => {
    // 🔴 Pins the fix for the duplicate-row divergence. The main app's `readBlocklistRow` pins
    // `orderBy: { id: 'asc' }`; this used to be `executeTakeFirst()` with no ordering, so with two
    // rows for a type the signup path here could enforce a list the main app did not.
    h.getRedis.mockReturnValue(null);
    h.executeTakeFirst.mockResolvedValue({ data: ['whatever.test'] });

    await getBlockedEmailDomainSuffixes();

    expect(h.orderBy).toHaveBeenCalledWith('id', 'asc');
    // Pins WHICH row it read. Without this, changing the type string leaves the whole file green
    // while the hub reads the wrong `Blocklist` row on a cold cache and enforces an empty list.
    expect(h.where).toHaveBeenCalledWith('type', '=', 'EmailDomainSuffix');
  });

  it('blocks on the suffix list when the exact list misses', async () => {
    const redis = makeRedis();
    redis._store.set(BLOCKLIST_KEY, JSON.stringify({ type: 'EmailDomain', data: [] }));
    redis._store.set(
      SUFFIX_KEY,
      JSON.stringify({ type: 'EmailDomainSuffix', data: ['farm.test'] })
    );
    h.getRedis.mockReturnValue(redis);

    await expect(isBlockedEmailDomain('a.farm.test')).resolves.toBe(true);
    await expect(isBlockedEmailDomain('unrelated.test')).resolves.toBe(false);
  });

  it('does not read the suffix list when the exact list already matched', async () => {
    // Ordering is deliberate: the second lookup stays off the path an ordinary signup takes.
    const redis = makeRedis();
    redis._store.set(BLOCKLIST_KEY, JSON.stringify({ type: 'EmailDomain', data: ['exact.test'] }));
    redis._store.set(SUFFIX_KEY, JSON.stringify({ type: 'EmailDomainSuffix', data: [] }));
    h.getRedis.mockReturnValue(redis);

    await expect(isBlockedEmailDomain('exact.test')).resolves.toBe(true);

    expect(redis.get).toHaveBeenCalledWith(BLOCKLIST_KEY);
    expect(redis.get).not.toHaveBeenCalledWith(SUFFIX_KEY);
  });
});
