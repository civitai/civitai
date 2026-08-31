import { describe, it, expect, vi, beforeEach } from 'vitest';

// Blocklist reads the shared `system:blocklist:EmailDomain` cache first, then falls back to the
// `Blocklist` DB table. Mock both collaborators (`../redis` + `../db/db`) so the unit under test —
// the redis→DB fallback + repopulate + degrade-open behavior — runs for real.
const h = vi.hoisted(() => ({
  getRedis: vi.fn(),
  executeTakeFirst: vi.fn(),
}));
vi.mock('../../redis', () => ({ getRedis: h.getRedis }));
vi.mock('../../db/db', () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: h.executeTakeFirst }),
      }),
    }),
  },
}));

import {
  emailDomain,
  getBlockedEmailDomains,
  isBlockedDomain,
  normalizeEmailAddress,
} from '../blocklist';

const BLOCKLIST_KEY = 'system:blocklist:EmailDomain';

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

describe('isBlockedDomain', () => {
  // Both sides must go through the same normalizer. Stripping the input but not the entry would
  // make a hand-typed `provider.com.` enforced by the main app and silently inert here.
  it('matches a list entry that carries a trailing FQDN dot', () => {
    expect(isBlockedDomain(['blocked.test.'], 'blocked.test')).toBe(true);
  });

  it('matches an entry with case and whitespace', () => {
    expect(isBlockedDomain(['  Blocked.TEST  '], 'blocked.test')).toBe(true);
  });

  it('matches the WHOLE domain, not a substring', () => {
    expect(isBlockedDomain(['ocked.test', 'test'], 'blocked.test')).toBe(false);
  });

  it('never matches an empty domain, whatever the list holds', () => {
    expect(isBlockedDomain([''], '')).toBe(false);
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
