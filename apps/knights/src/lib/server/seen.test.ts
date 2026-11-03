import { describe, expect, it, vi } from 'vitest';
import {
  dismissGuide,
  dismissProgress,
  memorySeenStore,
  readNotices,
  redisSeenStore,
} from './seen';

const at = (rank: string, level: number) => ({ rank, level });

describe('readNotices', () => {
  it('shows the rating guide on the first look and records where the player stands, without a rank notice', async () => {
    const store = memorySeenStore();
    expect(await readNotices(store, 1, at('Knight', 4))).toEqual({ guide: true, progress: null });
    expect(await store.get(1)).toEqual({ rank: 'Knight', level: 4, guide: false });
  });

  it('shows the guide until it is dismissed, then never again', async () => {
    const store = memorySeenStore();
    await readNotices(store, 1, at('Knight', 4));
    expect((await readNotices(store, 1, at('Knight', 4))).guide).toBe(true);
    await dismissGuide(store, 1, at('Knight', 4));
    expect((await readNotices(store, 1, at('Knight', 4))).guide).toBe(false);
  });

  it('reports a new rank once, and the level reached with it', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Knight', level: 9, guide: true });
    expect((await readNotices(store, 1, at('Templar', 10))).progress).toEqual({
      kind: 'rank',
      rank: 'Templar',
      level: 10,
    });
    await dismissProgress(store, 1, at('Templar', 10));
    expect((await readNotices(store, 1, at('Templar', 10))).progress).toBeNull();
  });

  it('reports a new level inside the same rank', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Knight', level: 4, guide: true });
    expect((await readNotices(store, 1, at('Knight', 5))).progress).toEqual({
      kind: 'level',
      rank: 'Knight',
      level: 5,
    });
  });

  it('announces the Acolyte to Knight step as a rank-up', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Acolyte', level: 20, guide: true });
    expect((await readNotices(store, 1, at('Knight', 20))).progress).toEqual({
      kind: 'rank',
      rank: 'Knight',
      level: 20,
    });
  });

  it('stays quiet about a drop, as after a career reset, and counts from the new standing', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Templar', level: 12, guide: true });
    expect((await readNotices(store, 1, at('Acolyte', 1))).progress).toBeNull();
    expect((await readNotices(store, 1, at('Acolyte', 2))).progress).toMatchObject({
      kind: 'level',
    });
  });

  it('shows nothing when the store is down, rather than nagging on every load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = {
      get: async () => {
        throw new Error('down');
      },
      set: async () => undefined,
    };
    expect(await readNotices(down, 1, at('Knight', 4))).toEqual({ guide: false, progress: null });
  });
});

describe('dismissals', () => {
  it('report whether the store took them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = {
      get: async () => null,
      set: async () => {
        throw new Error('down');
      },
    };
    expect(await dismissGuide(down, 1, at('Knight', 4))).toBe(false);
    expect(await dismissProgress(memorySeenStore(), 1, at('Knight', 4))).toBe(true);
  });
});

describe('redisSeenStore', () => {
  it('round-trips a record under one key per player and ignores a malformed value', async () => {
    const data = new Map<string, string>();
    const client = {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => void data.set(key, value),
    };
    const store = redisSeenStore(() => client);
    await store.set(7, { rank: 'Paladin', level: 30, guide: true });
    expect([...data.keys()]).toEqual(['knights:seen:7']);
    expect(await store.get(7)).toEqual({ rank: 'Paladin', level: 30, guide: true });
    data.set('knights:seen:7', '{"rank":3}');
    expect(await store.get(7)).toBeNull();
  });

  it('stores only the rank, level and guide flag when handed a wider standing', async () => {
    const data = new Map<string, string>();
    const client = {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => void data.set(key, value),
    };
    const status = { rank: 'Knight', level: 3, fervor: 12, goldPending: 40, guide: false };
    await redisSeenStore(() => client).set(7, status);
    expect(JSON.parse(data.get('knights:seen:7') ?? '')).toEqual({
      rank: 'Knight',
      level: 3,
      guide: false,
    });
  });
});
