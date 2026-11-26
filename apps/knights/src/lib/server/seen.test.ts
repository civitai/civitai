import { describe, expect, it, vi } from 'vitest';
import {
  dismissGuide,
  dismissProgress,
  dismissUpdates,
  dismissWhatsNew,
  memorySeenStore,
  readNotices,
  readUpdatesSeen,
  redisSeenStore,
} from './seen';
import { LATEST_UPDATE_ID } from './whats-new/entries';

const at = (rank: string, level: number) => ({ rank, level });

describe('readNotices', () => {
  it("shows what's new on the first look, holds the guide back, and records where the player stands", async () => {
    const store = memorySeenStore();
    expect(await readNotices(store, 1, at('Knight', 4))).toEqual({
      whatsNew: true,
      guide: false,
      progress: null,
    });
    // A newcomer starts with every "What's new" entry so far counted as seen.
    expect(await store.get(1)).toEqual({
      rank: 'Knight',
      level: 4,
      guide: false,
      whatsNew: false,
      consent: false,
      updatesSeen: LATEST_UPDATE_ID,
    });
  });

  it("offers the guide once what's new is dismissed, until the guide is dismissed too", async () => {
    const store = memorySeenStore();
    await readNotices(store, 1, at('Knight', 4));
    expect(await readNotices(store, 1, at('Knight', 4))).toMatchObject({
      whatsNew: true,
      guide: false,
    });
    expect(await dismissWhatsNew(store, 1, at('Knight', 4))).toBe(true);
    expect(await readNotices(store, 1, at('Knight', 4))).toMatchObject({
      whatsNew: false,
      guide: true,
    });
    await dismissGuide(store, 1, at('Knight', 4));
    expect(await readNotices(store, 1, at('Knight', 4))).toMatchObject({
      whatsNew: false,
      guide: false,
    });
  });

  it("shows what's new to a player whose record predates it, keeping the guide they already dismissed", async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Knight', level: 9, guide: true, whatsNew: false, consent: true });
    expect(await readNotices(store, 1, at('Templar', 50))).toEqual({
      whatsNew: true,
      guide: false,
      progress: null,
    });
    await dismissWhatsNew(store, 1, at('Templar', 50));
    // Closing the launch dialog covers the entries written so far.
    expect(await store.get(1)).toEqual({
      rank: 'Knight',
      level: 9,
      guide: true,
      whatsNew: true,
      consent: true,
      updatesSeen: LATEST_UPDATE_ID,
    });
    // The rank-up held back while what's new was open is announced after it.
    expect((await readNotices(store, 1, at('Templar', 50))).progress).toMatchObject({
      kind: 'rank',
    });
  });

  it('reports a new rank once, and the level reached with it', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Knight', level: 9, guide: true, whatsNew: true, consent: true });
    expect((await readNotices(store, 1, at('Templar', 10))).progress).toMatchObject({
      kind: 'rank',
      rank: 'Templar',
      level: 10,
    });
    await dismissProgress(store, 1, at('Templar', 10));
    expect((await readNotices(store, 1, at('Templar', 10))).progress).toBeNull();
  });

  it('reports a new level inside the same rank', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Knight', level: 4, guide: true, whatsNew: true, consent: true });
    expect((await readNotices(store, 1, at('Knight', 5))).progress).toMatchObject({
      kind: 'level',
      rank: 'Knight',
      level: 5,
    });
  });

  it('announces the Acolyte to Knight step as a rank-up', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Acolyte', level: 20, guide: true, whatsNew: true, consent: true });
    expect((await readNotices(store, 1, at('Knight', 20))).progress).toMatchObject({
      kind: 'rank',
      rank: 'Knight',
      level: 20,
    });
  });

  it('stays quiet about a drop, as after a career reset, and counts from the new standing', async () => {
    const store = memorySeenStore();
    await store.set(1, { rank: 'Templar', level: 12, guide: true, whatsNew: true, consent: true });
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
    expect(await readNotices(down, 1, at('Knight', 4))).toEqual({
      whatsNew: false,
      guide: false,
      progress: null,
    });
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
    expect(await dismissWhatsNew(down, 1, at('Knight', 4))).toBe(false);
    expect(await dismissProgress(memorySeenStore(), 1, at('Knight', 4))).toBe(true);
  });

  it("keep what's new dismissed when the progress or the guide is dismissed later", async () => {
    const store = memorySeenStore();
    await dismissWhatsNew(store, 1, at('Knight', 4));
    await dismissProgress(store, 1, at('Knight', 5));
    await dismissGuide(store, 1, at('Knight', 5));
    expect(await store.get(1)).toEqual({
      rank: 'Knight',
      level: 5,
      guide: true,
      whatsNew: true,
      consent: false,
      updatesSeen: LATEST_UPDATE_ID,
    });
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
    await store.set(7, { rank: 'Paladin', level: 30, guide: true, whatsNew: true, consent: true });
    expect([...data.keys()]).toEqual(['knights:seen:7']);
    expect(await store.get(7)).toEqual({
      rank: 'Paladin',
      level: 30,
      guide: true,
      whatsNew: true,
      consent: true,
      updatesSeen: null,
    });
    await store.set(7, { ...(await store.get(7))!, updatesSeen: '2030-01-01-a' });
    expect((await store.get(7))?.updatesSeen).toBe('2030-01-01-a');
    data.set('knights:seen:7', '{"rank":3}');
    expect(await store.get(7)).toBeNull();
  });

  it("reads a record stored before what's new existed as not seen, keeping its guide flag", async () => {
    const data = new Map([['knights:seen:7', '{"rank":"Knight","level":4,"guide":true}']]);
    const client = {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => void data.set(key, value),
    };
    expect(await redisSeenStore(() => client).get(7)).toEqual({
      rank: 'Knight',
      level: 4,
      guide: true,
      whatsNew: false,
      consent: false,
      updatesSeen: null,
    });
  });

  it('stores only its own fields when handed a wider standing', async () => {
    const data = new Map<string, string>();
    const client = {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => void data.set(key, value),
    };
    const status = {
      rank: 'Knight',
      level: 3,
      fervor: 12,
      goldPending: 40,
      guide: false,
      whatsNew: true,
      consent: true,
    };
    await redisSeenStore(() => client).set(7, status);
    expect(JSON.parse(data.get('knights:seen:7') ?? '')).toEqual({
      rank: 'Knight',
      level: 3,
      guide: false,
      whatsNew: true,
      consent: true,
      updatesSeen: null,
    });
  });
});

describe('"What\'s new" entries seen', () => {
  const record = { rank: 'Knight', level: 4, guide: true, whatsNew: true, consent: true };

  it('reads a record from before entries existed as having seen none, so its player gets every entry', async () => {
    const store = memorySeenStore();
    await store.set(1, record);
    expect(await readUpdatesSeen(store, 1)).toEqual({ launchSeen: true, updatesSeen: null });
  });

  it('records every entry so far as seen, and keeps the rest of the record', async () => {
    const store = memorySeenStore();
    await store.set(1, record);
    expect(await dismissUpdates(store, 1)).toBe(true);
    expect(await store.get(1)).toEqual({ ...record, updatesSeen: LATEST_UPDATE_ID });
  });

  it('has nothing to read or record for a player with no record yet', async () => {
    const store = memorySeenStore();
    expect(await readUpdatesSeen(store, 1)).toBeNull();
    expect(await dismissUpdates(store, 1)).toBe(true);
    expect(await store.get(1)).toBeNull();
  });

  it('reports a store that is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = {
      get: async () => {
        throw new Error('down');
      },
      set: async () => undefined,
    };
    expect(await readUpdatesSeen(down, 1)).toBeNull();
    expect(await dismissUpdates(down, 1)).toBe(false);
  });
});
