import { describe, expect, it, vi } from 'vitest';
import { createScannerVerdictCache, type ScannerVerdict } from '../retracted-media-tier';

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
