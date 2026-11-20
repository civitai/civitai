import { describe, expect, it, vi } from 'vitest';
import {
  parseStickerAutoTrack,
  readStickerAutoTrackWorkflow,
  stickerAutoTrackWindow,
  stickerAutoTrackDailyLimit,
  takeStickerAutoTrackRun,
  autoTrackReadIsMissing,
  autoTrackSubmitGivesBack,
  pollAutoTrack,
  stickerAutoTrackRunsKey,
  submitCountedAutoTrack,
  startAutoTrack,
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

type RunCounter = Parameters<typeof takeStickerAutoTrackRun>[0];

function memoryCounter() {
  const counts = new Map<string, number>();
  const bump = async (key: string, by: number) => {
    const next = (counts.get(key) ?? 0) + by;
    counts.set(key, next);
    return next;
  };
  const store = {
    incrBy: bump,
    decrBy: (key: string, by: number) => bump(key, -by),
    expire: async () => true,
  };
  return store as unknown as RunCounter;
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

  it('writes the key the Limits page reads for that UTC day', async () => {
    const keys: string[] = [];
    const store = {
      incrBy: async (key: string) => (keys.push(key), 1),
      decrBy: async () => 0,
      expire: async () => true,
    } as unknown as RunCounter;
    await takeStickerAutoTrackRun(store, { userId: PLACER, limit: LIMIT, now: LATE });
    expect(keys).toEqual([stickerAutoTrackRunsKey(PLACER, new Date('2026-11-20T00:00:00Z'))]);
    expect(keys[0]).toMatch(/:52:2026-11-20$/);
  });

  it('refuses everything when the counter is down', async () => {
    const down = new Error('redis down');
    const store = { ...memoryCounter(), incrBy: async () => Promise.reject(down) } as RunCounter;
    await expect(
      takeStickerAutoTrackRun(store, { userId: PLACER, limit: LIMIT, now: LATE })
    ).rejects.toBe(down);
  });
});

describe('autoTrackSubmitGivesBack', () => {
  it('hands the run back only when the orchestrator answered with a refusal', () => {
    expect([400, 402, 499].map(autoTrackSubmitGivesBack)).toEqual([true, true, true]);
    // A 5xx or a thrown submit (no response) may still have made a job, so the run stays spent.
    expect([undefined, 200, 399, 500, 503].map(autoTrackSubmitGivesBack)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('autoTrackReadIsMissing', () => {
  it('treats only a 404 as no such run, so other read errors keep polling', () => {
    expect(autoTrackReadIsMissing(404)).toBe(true);
    expect([undefined, 401, 500, 502].map(autoTrackReadIsMissing)).toEqual([
      false,
      false,
      false,
      false,
    ]);
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

  it('caps a moderator at their own number and everyone else at the entry', () => {
    expect(stickerAutoTrackDailyLimit({ limit: 3, applies: true }, true)).toBe(25);
    expect(stickerAutoTrackDailyLimit({ limit: 3, applies: true }, false)).toBe(3);
  });
});

describe('submitCountedAutoTrack', () => {
  const run = (submit: () => Promise<{ id?: string; status?: number }>) => {
    const giveBack = vi.fn(async () => undefined);
    const takeRun = vi.fn(async () => giveBack);
    return { giveBack, takeRun, result: submitCountedAutoTrack({ takeRun, submit }) };
  };

  it('keeps the run when the job is created', async () => {
    const { giveBack, result } = run(async () => ({ id: 'wf-1', status: 200 }));
    await expect(result).resolves.toBe('wf-1');
    expect(giveBack).not.toHaveBeenCalled();
  });

  it('hands the run back when the orchestrator refuses the job', async () => {
    const { giveBack, result } = run(async () => ({ status: 400 }));
    await expect(result).rejects.toThrow(/400/);
    expect(giveBack).toHaveBeenCalledTimes(1);
  });

  // A 5xx or a thrown submit may still have made a job, so a give-back here would let a user
  // run past the daily cap on the system account.
  it('keeps the run when the submit errors or throws', async () => {
    const failed = run(async () => ({ status: 503 }));
    await expect(failed.result).rejects.toThrow(/503/);
    const thrown = run(async () => Promise.reject(new Error('timeout')));
    await expect(thrown.result).rejects.toThrow('timeout');
    expect(failed.giveBack).not.toHaveBeenCalled();
    expect(thrown.giveBack).not.toHaveBeenCalled();
  });

  it('submits nothing when no run can be taken', async () => {
    const submit = vi.fn(async () => ({ id: 'wf-1' }));
    const takeRun = vi.fn(async () => Promise.reject(new Error('limit reached')));
    await expect(submitCountedAutoTrack({ takeRun, submit })).rejects.toThrow('limit reached');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('startAutoTrack', () => {
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  const input = (isModerator = false) => ({
    user: { id: PLACER, isModerator },
    imageId: IMAGE,
    pose: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
    startMs: START,
  });
  const deps = (over: Partial<Parameters<typeof startAutoTrack>[0]> = {}) => {
    const store = memoryCounter();
    const incr = vi.spyOn(store, 'incrBy');
    const submit = vi.fn(async () => ({ id: 'wf-1', status: 200 }));
    return {
      incr,
      submit,
      deps: {
        checkSpace: async () => undefined,
        loadVideo: async () => ({ url: 'https://image.example/v.mp4', durationSeconds: 30 }),
        resolveLimit: async () => ({ limit: 3, applies: true }),
        limitMessage: (limit: number) => `used ${limit}`,
        store,
        submit,
        now: () => NOW,
        ...over,
      },
    };
  };

  it('counts no run and submits nothing when the sticker cannot be placed here', async () => {
    const refused = new Error('placement: you cannot place a sticker on your own content');
    const { incr, submit, deps: d } = deps({ checkSpace: async () => Promise.reject(refused) });
    await expect(startAutoTrack(d, input())).rejects.toBe(refused);
    expect(incr).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('counts no run for a start past the end of the video', async () => {
    const {
      incr,
      submit,
      deps: d,
    } = deps({
      loadVideo: async () => ({ url: 'v', durationSeconds: 5 }),
    });
    await expect(startAutoTrack(d, input())).rejects.toThrow(/before the video ends/);
    expect(incr).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits the caller's run under the caller's id", async () => {
    const { submit, deps: d } = deps();
    await expect(startAutoTrack(d, input())).resolves.toMatchObject({ workflowId: 'wf-1' });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { stickerAutoTrack: { userId: PLACER, imageId: IMAGE, startMs: START } },
      })
    );
  });

  it('refuses the 4th run of the day as rate limited, with the cap in the message', async () => {
    const { submit, deps: d } = deps();
    for (let i = 0; i < 3; i++) await startAutoTrack(d, input());
    await expect(startAutoTrack(d, input())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'used 3',
    });
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it('gives a moderator 25 runs whatever the entry says', async () => {
    const { submit, deps: d } = deps();
    for (let i = 0; i < 25; i++) await startAutoTrack(d, input(true));
    await expect(startAutoTrack(d, input(true))).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'used 25',
    });
    expect(submit).toHaveBeenCalledTimes(25);
  });
});

describe('pollAutoTrack', () => {
  const track = { ok: true, json: async () => TRACK };
  const poll = (read: Parameters<typeof pollAutoTrack>[0]['read']) =>
    pollAutoTrack({ read, download: async () => track, maxScale: async () => 1 }, PLACER);

  it('keeps polling through a failed read that is not a 404', async () => {
    for (const status of [500, 502, undefined])
      expect(await poll(async () => ({ error: new Error('read'), status }))).toEqual({
        status: 'running',
      });
  });

  it('fails a finished run whose file cannot be fetched or read', async () => {
    const done = async () => ({
      data: finished([{ id: 'customcomfy-x-sticker_track_00002.json', url: BLOB_URL }]),
      status: 200,
    });
    const withFile = (file: { ok: boolean; json: () => Promise<unknown> }) =>
      pollAutoTrack({ read: done, download: async () => file, maxScale: async () => 1 }, PLACER);
    expect(await withFile({ ok: false, json: async () => TRACK })).toEqual({ status: 'failed' });
    expect(await withFile({ ok: true, json: async () => ({ v: 2 }) })).toEqual({
      status: 'failed',
    });
  });

  it('reports a 404 as no such run', async () => {
    expect(await poll(async () => ({ error: new Error('gone'), status: 404 }))).toEqual({
      status: 'missing',
    });
  });

  it('hands back the track of a finished run', async () => {
    const result = await poll(async () => ({
      data: finished([{ id: 'customcomfy-x-sticker_track_00002.json', url: BLOB_URL }]),
      status: 200,
    }));
    expect(result).toMatchObject({ status: 'succeeded', startMs: START });
  });
});
