import { describe, expect, it } from 'vitest';
import {
  parseStickerAutoTrack,
  readStickerAutoTrackWorkflow,
  stickerAutoTrackWindow,
  stickerAutoTrackDailyLimit,
  takeStickerAutoTrackRun,
} from '~/server/utils/sticker-auto-track';

const PLACER = 52;
const OTHER = 63;
const IMAGE = 74;
const START = 5250;
const BLOB_URL = 'https://orchestration.example/v2/consumer/blobs/track.json?sig=1';

const finished = (blobs: unknown[], userId = PLACER) => ({
  status: 'succeeded',
  metadata: { stickerAutoTrack: { userId, imageId: IMAGE, startMs: START } },
  steps: [{ output: { blobs } }],
});

/** A real tracker result (the comic clip, character leaves after a cut), trimmed. */
const TRACK = {
  v: 1,
  ms: 250,
  show: [
    [0, 1],
    [7, 0],
  ],
  x: [
    [0, 0.49],
    [6, 0.4941],
  ],
  y: [
    [0, 0.578],
    [6, 0.5705],
  ],
  s: [
    [0, 0.15],
    [3, 0.31],
    [6, 0.1403],
  ],
  r: [
    [0, 0],
    [6, 0.5],
  ],
};

describe('readStickerAutoTrackWorkflow', () => {
  it("hides another placer's run", () => {
    const run = finished([{ id: 'a.json', url: BLOB_URL, available: true }], OTHER);
    expect(readStickerAutoTrackWorkflow(run, PLACER)).toEqual({ status: 'missing' });
  });

  it('keeps waiting until the run ends, and fails a run that did not succeed', () => {
    expect(readStickerAutoTrackWorkflow({ ...finished([]), status: 'processing' }, PLACER)).toEqual(
      { status: 'running' }
    );
    for (const status of ['failed', 'expired', 'canceled'])
      expect(readStickerAutoTrackWorkflow({ ...finished([]), status }, PLACER)).toEqual({
        status: 'failed',
      });
  });

  it('fails a run that reports success without a usable track file', () => {
    const unavailable = finished([{ id: 'a.json', url: BLOB_URL, available: false }]);
    const notJson = finished([{ id: 'a.png', url: BLOB_URL, available: true }]);
    expect(readStickerAutoTrackWorkflow(unavailable, PLACER)).toEqual({ status: 'failed' });
    expect(readStickerAutoTrackWorkflow(notJson, PLACER)).toEqual({ status: 'failed' });
  });

  it('hands back the track file and where the run started', () => {
    const run = finished([{ id: 'customcomfy-x-sticker_track_00002.json', url: BLOB_URL }]);
    expect(readStickerAutoTrackWorkflow(run, PLACER)).toEqual({
      status: 'download',
      url: BLOB_URL,
      imageId: IMAGE,
      startMs: START,
    });
  });
});

describe('parseStickerAutoTrack', () => {
  it("shrinks the sticker to the creator's size limit and keeps the rest", () => {
    const track = parseStickerAutoTrack(TRACK, 0.2);
    expect(track?.s).toEqual([
      [0, 0.15],
      [3, 0.2],
      [6, 0.1403],
    ]);
    expect(track?.x).toEqual(TRACK.x);
    expect(track?.show).toEqual(TRACK.show);
  });

  it('refuses a file the player would not accept', () => {
    expect(parseStickerAutoTrack({ v: 2, keys: [] }, 0.4)).toBeNull();
    expect(parseStickerAutoTrack({ ...TRACK, ms: 0 }, 0.4)).toBeNull();
    expect(parseStickerAutoTrack(null, 0.4)).toBeNull();
  });
});

describe('stickerAutoTrackWindow', () => {
  it('covers the rest of the video, at most 60 s', () => {
    expect(stickerAutoTrackWindow(START, 15.1)).toBe(15100 - START);
    expect(stickerAutoTrackWindow(0, 90)).toBe(60_000);
    expect(stickerAutoTrackWindow(0)).toBe(60_000);
  });

  it('refuses a start at or past the end', () => {
    expect(stickerAutoTrackWindow(15100, 15.1)).toBeNull();
  });
});

function memoryCounter() {
  const counts = new Map<string, number>();
  const bump = async (key: string, by: number) => {
    const next = (counts.get(key) ?? 0) + by;
    counts.set(key, next);
    return next;
  };
  return {
    incrBy: bump,
    decrBy: (key: string, by: number) => bump(key, -by),
    expire: async () => 1,
  };
}

describe('takeStickerAutoTrackRun', () => {
  const LIMIT = 3;
  const LATE = Date.parse('2026-11-20T23:59:30Z');
  const NEXT_DAY = Date.parse('2026-11-21T00:00:10Z');

  it('refuses the run past the limit until the next UTC day', async () => {
    const store = memoryCounter();
    const take = (now: number) =>
      takeStickerAutoTrackRun(store, { userId: PLACER, limit: LIMIT, now });
    for (let i = 0; i < LIMIT; i++) expect((await take(LATE)).ok).toBe(true);

    const refused = await take(LATE);
    expect(refused).toEqual({
      ok: false,
      used: LIMIT,
      resetAt: new Date('2026-11-21T00:00:00Z'),
    });
    expect(await take(LATE)).toMatchObject({ ok: false, used: LIMIT });
    expect((await take(NEXT_DAY)).ok).toBe(true);
  });

  it('counts each placer on their own', async () => {
    const store = memoryCounter();
    for (let i = 0; i < LIMIT; i++)
      await takeStickerAutoTrackRun(store, { userId: PLACER, limit: LIMIT, now: LATE });
    const other = await takeStickerAutoTrackRun(store, { userId: OTHER, limit: LIMIT, now: LATE });
    expect(other.ok).toBe(true);
  });

  it('gives a run back', async () => {
    const store = memoryCounter();
    const runs = [];
    for (let i = 0; i < LIMIT; i++)
      runs.push(await takeStickerAutoTrackRun(store, { userId: PLACER, limit: LIMIT, now: LATE }));
    const last = runs[LIMIT - 1];
    if (last.ok) await last.giveBack();
    expect(
      (await takeStickerAutoTrackRun(store, { userId: PLACER, limit: LIMIT, now: LATE })).ok
    ).toBe(true);
  });

  it('refuses everything when the counter is down', async () => {
    const down = new Error('redis down');
    const store = { ...memoryCounter(), incrBy: async () => Promise.reject(down) };
    await expect(
      takeStickerAutoTrackRun(store, { userId: PLACER, limit: LIMIT, now: LATE })
    ).rejects.toBe(down);
  });
});

describe('stickerAutoTrackDailyLimit', () => {
  it('a disabled usage-limits entry does not lift the auto-track cap: it bounds system-account spend', async () => {
    const limit = stickerAutoTrackDailyLimit({ limit: 3, applies: false });
    const store = memoryCounter();
    const now = Date.parse('2026-11-20T12:00:00Z');
    for (let i = 0; i < 3; i++)
      expect((await takeStickerAutoTrackRun(store, { userId: PLACER, limit, now })).ok).toBe(true);
    expect((await takeStickerAutoTrackRun(store, { userId: PLACER, limit, now })).ok).toBe(false);
  });
});
