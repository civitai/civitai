import { describe, expect, it, vi } from 'vitest';
import {
  createScannerVerdictCache,
  csamRestrictedSql,
  siblingsServable,
  URL_SIBLING_CAP,
  urlSiblingsSql,
  type ScannerVerdict,
} from '../retracted-media-tier';

describe('createScannerVerdictCache', () => {
  const setup = (answers: (ScannerVerdict | null)[]) => {
    let t = 0;
    const read = vi.fn(async () => answers.shift() ?? null);
    const cache = createScannerVerdictCache(read, { ttlMs: 1000, max: 2, now: () => t });
    return { read, cache, advance: (ms: number) => (t += ms) };
  };

  it('asks ClickHouse once per image within the ttl, and again after it', async () => {
    const { read, cache, advance } = setup(['clear', 'hit']);
    expect(await cache.read(1)).toBe('clear');
    expect(await cache.read(1)).toBe('clear');
    expect(read).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(await cache.read(1)).toBe('hit');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never keeps an unreadable answer', async () => {
    const { read, cache } = setup([null, 'clear']);
    expect(await cache.read(1)).toBeNull();
    expect(await cache.read(1)).toBe('clear');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never keeps a missing verdict, since rows can land after it', async () => {
    const { read, cache } = setup(['none', 'hit']);
    expect(await cache.read(1)).toBe('none');
    expect(await cache.read(1)).toBe('hit');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops the oldest entry past its size', async () => {
    const { read, cache } = setup(['clear', 'clear', 'clear', 'hit']);
    await cache.read(1);
    await cache.read(2);
    await cache.read(3);
    expect(await cache.read(1)).toBe('hit');
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe('csamRestrictedSql and urlSiblingsSql', () => {
  it.each(['cs', 'CS', 'cu', 'Cu', 'hr', 'cpth', 'cuph'])(
    'refuse the alias %s, which their SQL uses',
    (alias) => {
      expect(() => csamRestrictedSql(alias)).toThrow(/Bad table alias/);
    }
  );

  it('refuses the alias its own subquery uses', () => {
    expect(() => urlSiblingsSql('us')).toThrow(/Bad table alias/);
    expect(() => urlSiblingsSql('i')).not.toThrow();
  });
});

describe('siblingsServable', () => {
  const routine = (blockedFor: string | null) => blockedFor === 'unlisted';
  const clear = async (): Promise<ScannerVerdict | null> => 'clear';

  it('serves a url no other row marks', async () => {
    expect(await siblingsServable([], routine, clear)).toBe(true);
    expect(await siblingsServable([{ id: 1, blockedFor: 'moderated' }], routine, clear)).toBe(true);
  });

  it('refuses a url another row has a block-reason signal on', async () => {
    expect(await siblingsServable([{ id: 1, blockedFor: 'unlisted' }], routine)).toBe(false);
  });

  it.each([['hit'], [null]] as const)(
    'refuses a url another row has a scanner verdict of %s on',
    async (v) => {
      const read = vi.fn(async (id: number) => (id === 2 ? v : 'clear'));
      expect(
        await siblingsServable(
          [
            { id: 1, blockedFor: null },
            { id: 2, blockedFor: null },
          ],
          routine,
          read
        )
      ).toBe(false);
    }
  );

  it('refuses a url with as many other rows as it reads', async () => {
    const rows = Array.from({ length: URL_SIBLING_CAP }, (_, id) => ({ id, blockedFor: null }));
    expect(await siblingsServable(rows, routine, clear)).toBe(false);
    expect(await siblingsServable(rows.slice(1), routine, clear)).toBe(true);
  });
});
