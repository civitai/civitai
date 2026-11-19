import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { badgeKeysFrom, RANK_BADGE_COSMETICS } from './rank-badges';

describe('badgeKeysFrom', () => {
  it('maps each rank to the image key of its cosmetic, Acolyte included', () => {
    const keys = badgeKeysFrom([
      { id: RANK_BADGE_COSMETICS.Acolyte, data: { url: 'acolyte-key' } },
      { id: RANK_BADGE_COSMETICS.Knight, data: { url: 'knight-key' } },
      { id: RANK_BADGE_COSMETICS.Templar, data: { url: 'templar-key' } },
      { id: 4208, data: { url: 'paladin-key' } },
    ]);
    expect(keys).toEqual({
      Acolyte: 'acolyte-key',
      Knight: 'knight-key',
      Templar: 'templar-key',
      Paladin: 'paladin-key',
    });
  });

  it('leaves out a rank whose cosmetic is missing or has no url', () => {
    const keys = badgeKeysFrom([
      { id: RANK_BADGE_COSMETICS.Knight, data: { url: '' } },
      { id: RANK_BADGE_COSMETICS.Templar, data: null },
    ]);
    expect(keys).toEqual({});
  });
});

describe('rankBadgeUrls', () => {
  const rows = [{ id: RANK_BADGE_COSMETICS.Knight, data: { url: 'knight-key' } }];
  const stubDb = (execute: () => Promise<unknown>) =>
    ({
      selectFrom: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.where = () => q;
        q.execute = execute;
        return q;
      },
    } as never);

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('holds the urls for ten minutes, then reads again', async () => {
    const { rankBadgeUrls } = await import('./rank-badges');
    const execute = vi.fn().mockResolvedValue(rows);
    const db = stubDb(execute);
    const first = await rankBadgeUrls(db, 0);
    expect(first.small.Knight).toBeTruthy();
    expect(await rankBadgeUrls(db, 9 * 60_000)).toBe(first);
    expect(execute).toHaveBeenCalledTimes(1);
    await rankBadgeUrls(db, 10 * 60_000 + 1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('serves the crest fallback on a failed first read and does not re-run the query during the backoff', async () => {
    const { rankBadgeUrls } = await import('./rank-badges');
    const execute = vi.fn().mockRejectedValue(new Error('down'));
    const db = stubDb(execute);
    expect(await rankBadgeUrls(db, 0)).toEqual({ small: {}, large: {} });
    expect(await rankBadgeUrls(db, 30_000)).toEqual({ small: {}, large: {} });
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockResolvedValue(rows);
    expect((await rankBadgeUrls(db, 61_000)).small.Knight).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the held urls when a refresh fails, and retries after the backoff', async () => {
    const { rankBadgeUrls } = await import('./rank-badges');
    const execute = vi.fn().mockResolvedValueOnce(rows).mockRejectedValue(new Error('down'));
    const db = stubDb(execute);
    const good = await rankBadgeUrls(db, 0);
    expect(await rankBadgeUrls(db, 11 * 60_000)).toBe(good);
    expect(await rankBadgeUrls(db, 11 * 60_000 + 30_000)).toBe(good);
    expect(execute).toHaveBeenCalledTimes(2);
    await rankBadgeUrls(db, 11 * 60_000 + 61_000);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
