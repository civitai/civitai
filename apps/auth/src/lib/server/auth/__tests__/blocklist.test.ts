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

import { getBlockedEmailDomains } from '../blocklist';

const BLOCKLIST_KEY = 'system:blocklist:EmailDomain';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('getBlockedEmailDomains', () => {
  it('returns the warm redis cache without touching the DB', async () => {
    const redis = makeRedis();
    redis._store.set(BLOCKLIST_KEY, JSON.stringify({ type: 'EmailDomain', data: ['evil.com', 'bad.io'] }));
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
    // best-effort repopulate with a 30d TTL
    expect(redis.set).toHaveBeenCalledWith(
      BLOCKLIST_KEY,
      JSON.stringify({ type: 'EmailDomain', data: ['db1.com', 'db2.com'] }),
      { EX: 60 * 60 * 24 * 30 }
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
