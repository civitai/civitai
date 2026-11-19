import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActivityCounter, getRail, railStanding } from './rail';

const rows = [
  { userId: 10, username: 'Aldric', fervor: 458 },
  { userId: 7, username: 'Me', fervor: 420 },
  { userId: 11, username: 'Brynn', fervor: 401 },
];

describe('railStanding', () => {
  it('gives the place, its neighbours and the gap to overtake the one above', () => {
    expect(railStanding({ rows }, 7)).toEqual({
      position: 2,
      total: 3,
      fervor: 420,
      above: { position: 1, username: 'Aldric', fervor: 458 },
      below: { position: 3, username: 'Brynn', fervor: 401 },
      gap: 38,
    });
  });

  it('has no gap and no one above in first place, and no one below in last', () => {
    expect(railStanding({ rows }, 10)).toMatchObject({ position: 1, above: null, gap: null });
    expect(railStanding({ rows }, 11)).toMatchObject({ position: 3, below: null, gap: 19 });
  });

  it('is null for a player the board does not rank', () => {
    expect(railStanding({ rows }, 99)).toBeNull();
    expect(railStanding({ rows: [] }, 7)).toBeNull();
  });

  it('reports a tie as a gap of 0', () => {
    const tied = [
      { userId: 1, username: 'A', fervor: 100 },
      { userId: 2, username: 'B', fervor: 100 },
    ];
    expect(railStanding({ rows: tied }, 2)).toMatchObject({ position: 2, gap: 0 });
  });
});

describe('railStanding with live fervor', () => {
  it('moves the player row and the gap to live fervor, keeping the cached neighbours', () => {
    // Snapshot says 420 (2nd); live says 25 under it: last place, below nobody, gap to Brynn.
    expect(railStanding({ rows }, 7, 25)).toEqual({
      position: 3,
      total: 3,
      fervor: 25,
      above: { position: 2, username: 'Brynn', fervor: 401 },
      below: null,
      gap: 376,
    });
  });

  it('climbs past neighbours the live number has overtaken', () => {
    expect(railStanding({ rows }, 7, 500)).toMatchObject({
      position: 1,
      fervor: 500,
      above: null,
      gap: null,
      below: { position: 2, username: 'Aldric', fervor: 458 },
    });
  });

  it('agrees with the cached board when live equals the snapshot', () => {
    expect(railStanding({ rows }, 7, 420)).toEqual(railStanding({ rows }, 7));
  });

  it('keeps the snapshot side of a tie', () => {
    const tied = [
      { userId: 1, username: 'A', fervor: 100 },
      { userId: 2, username: 'B', fervor: 100 },
    ];
    expect(railStanding({ rows: tied }, 2, 100)).toMatchObject({ position: 2, gap: 0 });
    expect(railStanding({ rows: tied }, 1, 100)).toMatchObject({ position: 1, gap: null });
  });

  it('is still null for a player the board does not rank', () => {
    expect(railStanding({ rows }, 99, 50)).toBeNull();
  });
});

describe('createActivityCounter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads once per ttl and again once the day or the ttl has moved on', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(120)
      .mockResolvedValueOnce(150)
      .mockResolvedValueOnce(7);
    const activity = createActivityCounter(read, 60_000);
    const noon = new Date('2026-12-15T12:00:00Z');
    expect(await activity(noon)).toBe(120);
    expect(await activity(new Date(noon.getTime() + 30_000))).toBe(120);
    expect(await activity(new Date(noon.getTime() + 61_000))).toBe(150);
    expect(await activity(new Date('2026-12-16T00:00:10Z'))).toBe(7);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith('2026-12-16');
  });

  it('is null, and does not throw, when the read fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const activity = createActivityCounter(async () => {
      throw new Error('down');
    });
    expect(await activity(new Date())).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('serves the last good value of the same day on a failed refresh, and does not re-read during the backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = vi.fn().mockResolvedValueOnce(120).mockRejectedValue(new Error('down'));
    const activity = createActivityCounter(read, 60_000);
    const noon = new Date('2026-12-15T12:00:00Z');
    expect(await activity(noon)).toBe(120);
    expect(await activity(new Date(noon.getTime() + 61_000))).toBe(120);
    expect(await activity(new Date(noon.getTime() + 90_000))).toBe(120);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(200);
    expect(await activity(new Date(noon.getTime() + 125_000))).toBe(200);
  });

  it("is null, not yesterday's number, when the read fails after the day rolled over", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = vi.fn().mockResolvedValueOnce(120).mockRejectedValue(new Error('down'));
    const activity = createActivityCounter(read, 60_000);
    expect(await activity(new Date('2026-12-15T23:59:00Z'))).toBe(120);
    expect(await activity(new Date('2026-12-16T00:01:00Z'))).toBeNull();
  });

  it('shares one read between concurrent callers that miss together', async () => {
    let finish: (n: number) => void = () => undefined;
    const read = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)));
    const activity = createActivityCounter(read, 60_000);
    const noon = new Date('2026-12-15T12:00:00Z');
    const calls = [activity(noon), activity(noon), activity(noon)];
    finish(42);
    expect(await Promise.all(calls)).toEqual([42, 42, 42]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('getRail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('combines the standing and the activity', async () => {
    const rail = await getRail(7, new Date(), {
      getBoard: async () => ({ rows }),
      activity: async () => 1240,
    });
    expect(rail).toMatchObject({ standing: { position: 2 }, activity: 1240 });
  });

  it('places the player at their live fervor', async () => {
    const rail = await getRail(
      7,
      new Date(),
      { getBoard: async () => ({ rows }), activity: async () => 1 },
      25
    );
    expect(rail.standing).toMatchObject({ position: 3, fervor: 25 });
  });

  it('keeps the rest when the board is down', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rail = await getRail(7, new Date(), {
      getBoard: async () => {
        throw new Error('down');
      },
      activity: async () => 5,
    });
    expect(rail).toEqual({ standing: null, activity: 5 });
    expect(log).toHaveBeenCalled();
  });

  it('survives a getBoard that throws synchronously', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rail = await getRail(7, new Date(), {
      getBoard: () => {
        throw new Error('sync');
      },
      activity: async () => 5,
    });
    expect(rail).toEqual({ standing: null, activity: 5 });
  });

  it('survives an activity that rejects or throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = { getBoard: async () => ({ rows }) };
    const rejected = await getRail(7, new Date(), {
      ...base,
      activity: () => Promise.reject(new Error('down')),
    });
    expect(rejected).toMatchObject({ standing: { position: 2 }, activity: null });
    const thrown = await getRail(7, new Date(), {
      ...base,
      activity: () => {
        throw new Error('sync');
      },
    });
    expect(thrown).toMatchObject({ standing: { position: 2 }, activity: null });
  });
});
