import { describe, expect, it } from 'vitest';
import {
  WATCH_MEMORY_LIMIT,
  readWatchedMs,
  rememberWatchedMs,
  watchMemoryKey,
} from '~/components/Crucible/judge-watch-memory';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

const KEY = watchMemoryKey(7, 1);

describe('judge watch memory', () => {
  it('keeps each judge and each crucible apart', () => {
    expect(new Set([watchMemoryKey(7, 1), watchMemoryKey(8, 1), watchMemoryKey(7, 2)]).size).toBe(
      3
    );
  });

  it('keeps the most watched so far', () => {
    const storage = memoryStorage();
    rememberWatchedMs(storage, KEY, 10, 3000);
    rememberWatchedMs(storage, KEY, 10, 1000);

    expect(readWatchedMs(storage, KEY, 10)).toBe(3000);
    expect(readWatchedMs(storage, KEY, 11)).toBe(0);
  });

  it('drops the clip watched longest ago past the limit', () => {
    const storage = memoryStorage();
    for (let id = 1; id <= WATCH_MEMORY_LIMIT + 1; id++) rememberWatchedMs(storage, KEY, id, 1000);

    expect(readWatchedMs(storage, KEY, 1)).toBe(0);
    expect(readWatchedMs(storage, KEY, 2)).toBe(1000);
    expect(readWatchedMs(storage, KEY, WATCH_MEMORY_LIMIT + 1)).toBe(1000);
  });

  it('reads a corrupt or foreign value as nothing watched, and recovers on the next write', () => {
    const storage = memoryStorage({ [KEY]: 'garbage' });
    expect(readWatchedMs(storage, KEY, 10)).toBe(0);

    rememberWatchedMs(storage, KEY, 10, 2000);
    expect(readWatchedMs(storage, KEY, 10)).toBe(2000);
  });

  it('survives storage that throws or is missing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readWatchedMs(throwing, KEY, 10)).toBe(0);
    expect(() => rememberWatchedMs(throwing, KEY, 10, 1000)).not.toThrow();
    expect(readWatchedMs(undefined, KEY, 10)).toBe(0);
  });
});
