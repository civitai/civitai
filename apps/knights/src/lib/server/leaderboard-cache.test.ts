import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_FRESH_MS, createBoardCache, utcDay, type BoardStore } from './leaderboard-cache';
import type { Board } from './leaderboard';

const board: Board = {
  rows: [{ userId: 1, username: 'a', image: null, rankType: 'Knight', level: 1, fervor: 100 }],
  badges: {},
};
const DAY_1 = new Date('2026-12-15T08:00:00Z');
const LATER_DAY_1 = new Date('2026-12-15T08:02:00Z');
const DAY_2 = new Date('2026-12-16T00:05:00Z');

function memoryStore() {
  const values = new Map<string, { value: string; ttl: number }>();
  const store: BoardStore = {
    get: vi.fn(async (key) => values.get(key)?.value ?? null),
    set: vi.fn(async (key, value, ttl) => void values.set(key, { value, ttl })),
  };
  return { store, values };
}

let build: ReturnType<typeof vi.fn<() => Promise<Board>>>;
beforeEach(() => {
  build = vi.fn(async () => board);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('createBoardCache', () => {
  it('builds on the first request and answers the next without querying again', async () => {
    const { store, values } = memoryStore();
    const cache = createBoardCache(store);

    await cache.get(DAY_1, build);
    expect(await cache.get(LATER_DAY_1, build)).toMatchObject(board);

    expect(build).toHaveBeenCalledTimes(1);
    expect(values.has('knights:leaderboard:2026-12-15')).toBe(true);
  });

  it('shares the stored board with another instance of the app', async () => {
    const { store } = memoryStore();
    await createBoardCache(store).get(DAY_1, build);

    expect(await createBoardCache(store).get(DAY_1, build)).toMatchObject(board);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('rebuilds on a new UTC day, and the key expires about when that day ends', async () => {
    const { store, values } = memoryStore();
    const cache = createBoardCache(store);

    await cache.get(DAY_1, build);
    await cache.get(DAY_2, build);

    expect(build).toHaveBeenCalledTimes(2);
    expect(utcDay(DAY_2)).toBe('2026-12-16');
    expect(values.has('knights:leaderboard:2026-12-16')).toBe(true);
  });

  it('answers within the freshness window without rebuilding, and rebuilds once it has passed', async () => {
    const { store } = memoryStore();
    const cache = createBoardCache(store);
    const at = (ms: number) => new Date(DAY_1.getTime() + ms);

    await cache.get(at(0), build);
    await cache.get(at(BOARD_FRESH_MS - 1), build);
    expect(build).toHaveBeenCalledTimes(1);

    await cache.get(at(BOARD_FRESH_MS + 1), build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a stored board that is older than the window, as another instance left it', async () => {
    const { store } = memoryStore();
    await createBoardCache(store).get(DAY_1, build);

    await createBoardCache(store).get(new Date(DAY_1.getTime() + BOARD_FRESH_MS + 1), build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('stamps the board with when it was built and expires the stored copy with the window', async () => {
    const { store, values } = memoryStore();
    const cache = createBoardCache(store);

    const built = await cache.get(DAY_1, build);
    const later = await cache.get(new Date(DAY_1.getTime() + 60_000), build);

    expect(built.builtAt).toBe(DAY_1.getTime());
    expect(later.builtAt).toBe(DAY_1.getTime());
    expect(values.get('knights:leaderboard:2026-12-15')!.ttl).toBe(BOARD_FRESH_MS / 1000);
  });

  it('builds once for concurrent requests after the window has passed', async () => {
    const { store } = memoryStore();
    const cache = createBoardCache(store);
    await cache.get(DAY_1, build);
    const stale = new Date(DAY_1.getTime() + BOARD_FRESH_MS + 1);

    await Promise.all([cache.get(stale, build), cache.get(stale, build), cache.get(stale, build)]);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('builds once for concurrent requests', async () => {
    const { store } = memoryStore();
    const cache = createBoardCache(store);

    await Promise.all([cache.get(DAY_1, build), cache.get(DAY_1, build), cache.get(DAY_1, build)]);

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('falls back to a direct query when Redis throws', async () => {
    const store: BoardStore = {
      get: vi.fn(async () => {
        throw new Error('down');
      }),
      set: vi.fn(),
    };

    expect(await createBoardCache(store).get(DAY_1, build)).toMatchObject(board);
    expect(build).toHaveBeenCalledTimes(1);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('falls back to a direct query when Redis never answers', async () => {
    const store: BoardStore = { get: () => new Promise(() => undefined), set: vi.fn() };

    expect(await createBoardCache(store, 20).get(DAY_1, build)).toMatchObject(board);
  });

  it('still answers when writing the cache fails, and rebuilds an unreadable stored value', async () => {
    const store: BoardStore = {
      get: vi.fn(async () => 'not json'),
      set: vi.fn(async () => {
        throw new Error('read-only');
      }),
    };

    expect(await createBoardCache(store).get(DAY_1, build)).toMatchObject(board);
  });
});
