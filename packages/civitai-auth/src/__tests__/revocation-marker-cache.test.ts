import { describe, it, expect, vi } from 'vitest';
import { createRevocationMarkerCache } from '../revocation-marker-cache';
import type { SessionRegistryRedis } from '../session-registry';

const TOKEN_STATE = 'session:token-state';
const USER_CUT = 'session:user-cut';

function setup(opts: { maxEntries?: number; ttlMs?: number } = {}) {
  let clock = 1_000_000;
  const values = new Map<string, unknown>();
  const upstream = {
    hGet: vi.fn(async (key: string, field: string) => values.get(`${key}|${field}`) ?? null),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
  };
  const cache = createRevocationMarkerCache({
    maxEntries: opts.maxEntries ?? 100,
    ttlMs: opts.ttlMs ?? 60_000,
    now: () => clock,
  });
  return {
    cache,
    // The sys client can return Buffers where the type says string, so the fake returns `unknown`.
    observed: cache.observe(upstream as unknown as SessionRegistryRedis),
    reader: cache.reader(),
    upstream,
    values,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createRevocationMarkerCache', () => {
  it('passes reads through unchanged and records what they returned', async () => {
    const { observed, reader, values } = setup();
    values.set(`${TOKEN_STATE}|t1`, 'invalid');
    values.set(`${USER_CUT}:7`, '5000');

    expect(await observed.hGet(TOKEN_STATE, 't1')).toBe('invalid');
    expect(await observed.get(`${USER_CUT}:7`)).toBe('5000');
    expect(await reader.hGet(TOKEN_STATE, 't1')).toBe('invalid');
    expect(await reader.get(`${USER_CUT}:7`)).toBe('5000');
    // Never read, so not known.
    expect(await reader.hGet(TOKEN_STATE, 't2')).toBeNull();
    expect(await reader.get(`${USER_CUT}:8`)).toBeNull();
  });

  it('records a token state only when it is a revocation, not a refresh flag', async () => {
    const { cache, observed, reader, values } = setup();
    values.set(`${TOKEN_STATE}|t1`, 'refresh');
    expect(await observed.hGet(TOKEN_STATE, 't1')).toBe('refresh');
    expect(await reader.hGet(TOKEN_STATE, 't1')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('normalises Buffer replies, as the sys client returns them', async () => {
    const { observed, reader, values } = setup();
    values.set(`${TOKEN_STATE}|t1`, Buffer.from('invalid'));
    values.set(`${USER_CUT}:7`, Buffer.from('5000'));
    await observed.hGet(TOKEN_STATE, 't1');
    await observed.get(`${USER_CUT}:7`);
    expect(await reader.hGet(TOKEN_STATE, 't1')).toBe('invalid');
    expect(await reader.get(`${USER_CUT}:7`)).toBe('5000');
  });

  it('forgets a marker when a later read no longer returns it', async () => {
    const { observed, reader, values } = setup();
    values.set(`${USER_CUT}:7`, '5000');
    await observed.get(`${USER_CUT}:7`);
    values.delete(`${USER_CUT}:7`);
    await observed.get(`${USER_CUT}:7`);
    expect(await reader.get(`${USER_CUT}:7`)).toBeNull();
  });

  it('keeps the newest value a read returned', async () => {
    const { observed, reader, values } = setup();
    values.set(`${USER_CUT}:7`, '5000');
    await observed.get(`${USER_CUT}:7`);
    values.set(`${USER_CUT}:7`, '9000');
    await observed.get(`${USER_CUT}:7`);
    expect(await reader.get(`${USER_CUT}:7`)).toBe('9000');
  });

  it('does not record a read that failed', async () => {
    const { cache, observed, upstream } = setup();
    upstream.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(observed.get(`${USER_CUT}:7`)).rejects.toThrow('ECONNREFUSED');
    expect(cache.size).toBe(0);
  });

  it('keeps a hash field and a plain key with the same text apart', async () => {
    const { observed, reader, values } = setup();
    values.set(`${TOKEN_STATE}|t1`, 'invalid');
    await observed.hGet(TOKEN_STATE, 't1');
    expect(await reader.get(TOKEN_STATE)).toBeNull();
    expect(await reader.get(`${TOKEN_STATE}t1`)).toBeNull();
  });

  describe('bound', () => {
    it('holds at most maxEntries, dropping the least recently read first', async () => {
      // maxEntries 3 with 5 distinct markers, so eviction runs more than once.
      const { cache, observed, reader, values } = setup({ maxEntries: 3 });
      for (const id of [1, 2, 3, 4, 5]) values.set(`${USER_CUT}:${id}`, String(id * 1000));

      await observed.get(`${USER_CUT}:1`);
      await observed.get(`${USER_CUT}:2`);
      await observed.get(`${USER_CUT}:3`);
      // Reading 1 again makes 2 the least recently read.
      expect(await reader.get(`${USER_CUT}:1`)).toBe('1000');
      await observed.get(`${USER_CUT}:4`);
      expect(cache.size).toBe(3);
      expect(await reader.get(`${USER_CUT}:2`)).toBeNull();

      await observed.get(`${USER_CUT}:5`);
      expect(cache.size).toBe(3);
      expect(await reader.get(`${USER_CUT}:3`)).toBeNull();
      expect(await reader.get(`${USER_CUT}:1`)).toBe('1000');
      expect(await reader.get(`${USER_CUT}:4`)).toBe('4000');
      expect(await reader.get(`${USER_CUT}:5`)).toBe('5000');
    });
  });

  describe('expiry', () => {
    it('drops an entry ttlMs after the read that recorded it', async () => {
      const { cache, observed, reader, values, advance } = setup({ ttlMs: 60_000 });
      values.set(`${USER_CUT}:7`, '5000');
      await observed.get(`${USER_CUT}:7`);

      advance(59_999);
      expect(await reader.get(`${USER_CUT}:7`)).toBe('5000');
      advance(1);
      expect(await reader.get(`${USER_CUT}:7`)).toBeNull();
      expect(cache.size).toBe(0);
    });

    it('a fresh read restarts the clock; a lookup does not', async () => {
      const { observed, reader, values, advance } = setup({ ttlMs: 60_000 });
      values.set(`${USER_CUT}:7`, '5000');
      await observed.get(`${USER_CUT}:7`);
      advance(40_000);
      expect(await reader.get(`${USER_CUT}:7`)).toBe('5000'); // lookup only
      await observed.get(`${USER_CUT}:7`); // re-recorded at +40s
      advance(50_000); // +90s overall, +50s since the re-read
      expect(await reader.get(`${USER_CUT}:7`)).toBe('5000');
      advance(10_000);
      expect(await reader.get(`${USER_CUT}:7`)).toBeNull();
    });
  });

  it('the reader never reaches the real client and refuses writes', async () => {
    const { reader, upstream } = setup();
    await reader.hGet(TOKEN_STATE, 't1');
    await reader.get(`${USER_CUT}:7`);
    expect(upstream.hGet).not.toHaveBeenCalled();
    expect(upstream.get).not.toHaveBeenCalled();
    expect(() => reader.set('k', 'v')).toThrow('read-only');
  });
});
