import { describe, expect, it, vi } from 'vitest';
import { createStoredShareSource, DEFAULT_YESNO, withStoredShare, yesNoSettings } from './config';

describe('yesNoSettings', () => {
  it('ages out answered questions after two weeks unless told otherwise', () => {
    expect(DEFAULT_YESNO.maxAgeDays).toBe(14);
    expect(yesNoSettings({ KNIGHTS_YESNO_MAX_AGE_DAYS: '0' }).maxAgeDays).toBe(14);
  });

  it('shows yes/no questions more often than ratings unless told otherwise', () => {
    expect(yesNoSettings({})).toEqual(DEFAULT_YESNO);
    expect(DEFAULT_YESNO.share).toBeGreaterThan(0.5);
  });

  it('takes valid values, including 0 to switch them off, and ignores the rest', () => {
    expect(
      yesNoSettings({
        KNIGHTS_YESNO_SHARE: '0',
        KNIGHTS_YESNO_STRETCH: '4',
        KNIGHTS_YESNO_MAX_AGE_DAYS: '30',
      })
    ).toEqual({
      share: 0,
      stretch: 4,
      maxAgeDays: 30,
    });
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '2', KNIGHTS_YESNO_STRETCH: '1.5' })).toEqual(
      DEFAULT_YESNO
    );
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '', KNIGHTS_YESNO_STRETCH: 'x' })).toEqual(
      DEFAULT_YESNO
    );
  });
});

describe('withStoredShare', () => {
  it('lets the share moderators saved win over the environment, 0 included', () => {
    expect(withStoredShare(DEFAULT_YESNO, 0)).toEqual({ ...DEFAULT_YESNO, share: 0 });
    expect(withStoredShare(DEFAULT_YESNO, 0.25).share).toBe(0.25);
  });

  it('keeps the environment share when none is saved', () => {
    expect(withStoredShare({ ...DEFAULT_YESNO, share: 0.4 }, undefined).share).toBe(0.4);
  });
});

describe('createStoredShareSource', () => {
  it('reads the saved share from the sources key and keeps it for the ttl', async () => {
    let clock = 0;
    const read = vi.fn(async () => JSON.stringify({ enabled: true, yesNoShare: 0 }));
    const source = createStoredShareSource({ read, ttlMs: 30_000, now: () => clock });

    expect(await source.load()).toBe(0);
    clock = 29_000;
    await source.load();
    expect(read).toHaveBeenCalledTimes(1);
    clock = 31_000;
    await source.load();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('is undefined when nothing is saved, and keeps the last value when the store fails', async () => {
    let clock = 0;
    let raw: string | null = null;
    let fail = false;
    const source = createStoredShareSource({
      read: async () => {
        if (fail) throw new Error('down');
        return raw;
      },
      ttlMs: 1,
      now: () => clock,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await source.load()).toBeUndefined();
    raw = JSON.stringify({ enabled: false, yesNoShare: 0.3 });
    clock = 10;
    expect(await source.load()).toBe(0.3);
    fail = true;
    clock = 20;
    expect(await source.load()).toBe(0.3);
  });
});
