import { describe, expect, it, vi } from 'vitest';
import { VOTE_LIMITS } from '../queue/vote-rate';
import { createLimitsSource, limitsFromConfig } from './config';

describe('limitsFromConfig', () => {
  it('reads the per-minute, per-hour and per-day values the moderators tune', () => {
    expect(limitsFromConfig({ perMinute: 10, perHour: 100, perDay: 1000 })).toEqual([
      { windowSeconds: 60, max: 10 },
      { windowSeconds: 3600, max: 100 },
      { windowSeconds: 86400, max: 1000 },
    ]);
  });

  it('falls back to the built-in limits when the config is absent or not usable', () => {
    expect(limitsFromConfig(null)).toEqual(VOTE_LIMITS);
    expect(limitsFromConfig('nope')).toEqual(VOTE_LIMITS);
    expect(limitsFromConfig({ perMinute: -1, perHour: 'x', perDay: 0 })).toEqual(VOTE_LIMITS);
  });

  it('keeps the built-in value for any field that is missing', () => {
    expect(limitsFromConfig({ perMinute: 5 })).toEqual([
      { windowSeconds: 60, max: 5 },
      VOTE_LIMITS[1],
      VOTE_LIMITS[2],
    ]);
  });
});

describe('createLimitsSource', () => {
  const config = { perMinute: 7, perHour: 70, perDay: 700 };

  it('serves the live config and reads it once a minute at most', async () => {
    let clock = 0;
    const read = vi.fn(async () => config);
    const source = createLimitsSource({ read, ttlMs: 60_000, now: () => clock, timeoutMs: 50 });

    expect((await source.load())[0].max).toBe(7);
    expect(source.current()[0].max).toBe(7);
    clock = 59_000;
    await source.load();
    expect(read).toHaveBeenCalledTimes(1);
    clock = 61_000;
    await source.load();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serves the built-in limits before the first read and when the key is absent', async () => {
    const source = createLimitsSource({
      read: async () => null,
      ttlMs: 60_000,
      now: () => 0,
      timeoutMs: 50,
    });
    expect(source.current()).toEqual(VOTE_LIMITS);
    expect(await source.load()).toEqual(VOTE_LIMITS);
  });

  it('keeps the last known limits when a read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let clock = 0;
    let fail = false;
    const source = createLimitsSource({
      read: async () => {
        if (fail) throw new Error('down');
        return config;
      },
      ttlMs: 60_000,
      now: () => clock,
      timeoutMs: 50,
    });
    await source.load();
    fail = true;
    clock = 61_000;
    expect((await source.load())[0].max).toBe(7);
  });
});
