import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDbWrite,
  mockIsFlipt,
  mockCounters,
  mockHistogram,
  mockGetJobDate,
  mockSetLastRun,
  mockSetSweepLastRun,
} =
  vi.hoisted(() => ({
    mockDbWrite: { $queryRaw: vi.fn() },
    mockIsFlipt: vi.fn(),
    mockCounters: {
      attempts: { inc: vi.fn() },
      runs: { inc: vi.fn() },
      errors: { inc: vi.fn() },
      posts: { inc: vi.fn() },
      images: { inc: vi.fn() },
      scheduledPosts: { inc: vi.fn() },
      scheduledImages: { inc: vi.fn() },
      skipped: { inc: vi.fn() },
    },
    mockHistogram: { observe: vi.fn() },
    mockSetLastRun: vi.fn(() => Promise.resolve()),
    mockSetSweepLastRun: vi.fn(() => Promise.resolve()),
    mockGetJobDate: vi.fn(),
  }));

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: { BITDEX_PUBLISH_REEMITTER: 'bitdex-publish-reemitter' },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(() => Promise.resolve()) }));
vi.mock('~/server/prom/client', () => ({
  reemitAttemptsCounter: mockCounters.attempts,
  reemitRunsCounter: mockCounters.runs,
  reemitErrorsCounter: mockCounters.errors,
  reemitPostsScannedCounter: mockCounters.posts,
  reemitImagesEmittedCounter: mockCounters.images,
  reemitScheduledPostsScannedCounter: mockCounters.scheduledPosts,
  reemitScheduledImagesEmittedCounter: mockCounters.scheduledImages,
  reemitRunDurationHistogram: mockHistogram,
  reemitSkippedRateLimitCounter: mockCounters.skipped,
}));
// createJob just returns the body fn so the test can invoke it directly; getJobDate
// is mocked so each test can pin the stored last-run time and observe the writer.
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: mockGetJobDate,
}));

import {
  buildReemitQuery,
  buildScheduledReemitQuery,
  getReemitConfig,
  getReemitMinIntervalSecs,
  getScheduledSweepEnabled,
  reemitBitdexOps,
} from '~/server/jobs/reemit-bitdex-ops';

const runJob = reemitBitdexOps as unknown as () => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.REEMIT_LOOKBACK_SECS;
  delete process.env.REEMIT_SETTLE_SECS;
  delete process.env.REEMIT_MIN_INTERVAL_SECS;
  delete process.env.REEMIT_SCHEDULED_SWEEP_ENABLED;
  // Default: both clocks read epoch, so the rate-limit never trips and the sweep is
  // due, unless a test pins a specific clock. getJobDate is keyed: the job reads two
  // markers (reemit last-run, scheduled-sweep last-run) with distinct setters.
  mockGetJobDate.mockImplementation((key: string) =>
    Promise.resolve(
      key.includes('scheduled-sweep')
        ? [new Date(0), mockSetSweepLastRun]
        : [new Date(0), mockSetLastRun]
    )
  );
});

afterEach(() => {
  delete process.env.REEMIT_LOOKBACK_SECS;
  delete process.env.REEMIT_SETTLE_SECS;
  delete process.env.REEMIT_MIN_INTERVAL_SECS;
  delete process.env.REEMIT_SCHEDULED_SWEEP_ENABLED;
});

describe('buildReemitQuery', () => {
  const sql = () => buildReemitQuery({ lookbackSecs: 900, settleSecs: 10 }).sql;

  it('calls BOTH shared PG functions and concatenates them (shape parity)', () => {
    // Op shape must come from the shared functions, never be re-spelled here.
    expect(sql()).toContain('bitdex_post_fanout_ops(p)');
    expect(sql()).toContain('bitdex_image_sortat_ops(i)');
    expect(sql()).toMatch(/bitdex_post_fanout_ops\(p\)\s*\|\|\s*bitdex_image_sortat_ops\(i\)/);
  });

  it('is a single INSERT ... SELECT emission', () => {
    const text = sql();
    // Exactly one INSERT — a per-row emit loop would reintroduce the ghost race.
    expect(text.match(/INSERT INTO "BitdexOps"/g)).toHaveLength(1);
    expect(text).toContain('INSERT INTO "BitdexOps" (entity_id, ops)');
  });

  it('excludes still-scheduled (future) posts via publishedAt <= now()', () => {
    expect(sql()).toContain('"publishedAt" <= now()');
    expect(sql()).toContain('"publishedAt" >= now() -');
  });

  it('applies the settle belt on updatedAt', () => {
    expect(sql()).toContain('"updatedAt"  <  now() - make_interval');
  });

  it('parameterizes lookback and settle (no literal injection)', () => {
    const query = buildReemitQuery({ lookbackSecs: 900, settleSecs: 10 });
    expect(query.values).toEqual([900, 10]);
    // The seconds are placeholders, not baked into the text.
    expect(query.sql).not.toContain('900');
  });
});

describe('buildScheduledReemitQuery', () => {
  const sql = () => buildScheduledReemitQuery({ settleSecs: 10 }).sql;

  it('calls BOTH shared PG functions and concatenates them (shape parity)', () => {
    // The scheduled scope must reuse the shared op shape, never re-spell a
    // "remove" op locally — bitdex_post_fanout_ops' own CASE guard is what turns a
    // future publishedAt into remove ops.
    expect(sql()).toContain('bitdex_post_fanout_ops(p)');
    expect(sql()).toContain('bitdex_image_sortat_ops(i)');
    expect(sql()).toMatch(/bitdex_post_fanout_ops\(p\)\s*\|\|\s*bitdex_image_sortat_ops\(i\)/);
  });

  it('is a single INSERT ... SELECT emission', () => {
    const text = sql();
    expect(text.match(/INSERT INTO "BitdexOps"/g)).toHaveLength(1);
    expect(text).toContain('INSERT INTO "BitdexOps" (entity_id, ops)');
  });

  it('scans ONLY future-scheduled posts (publishedAt > now(), no lookback bound)', () => {
    const text = sql();
    expect(text).toContain('"publishedAt" > now()');
    // The published-window bounds must not leak in — they are what made scheduled
    // posts unreachable in the first place.
    expect(text).not.toContain('"publishedAt" <= now()');
    expect(text).not.toContain('"publishedAt" >= now() -');
  });

  it('applies the same settle belt on updatedAt', () => {
    expect(sql()).toContain('"updatedAt"  <  now() - make_interval');
  });

  it('parameterizes settle only (no literal injection, no lookback param)', () => {
    const query = buildScheduledReemitQuery({ settleSecs: 30 });
    expect(query.values).toEqual([30]);
    expect(query.sql).not.toContain('30');
  });
});

describe('getScheduledSweepEnabled', () => {
  it('defaults OFF until the engine reschedule fix ships (bitdex-v2 v1.1.53)', () => {
    // A future-guarded publishedAt REMOVE currently UNSCHEDULES a deferred slot
    // (engine drops it from the deferred map and activates it as a draft), so the
    // sweep must not run against a healthy deferred map. See the source comment.
    expect(getScheduledSweepEnabled()).toBe(false);
  });

  it('honors the on switch in its several spellings', () => {
    for (const raw of ['true', 'TRUE', '1', 'on', 'yes', ' true ']) {
      process.env.REEMIT_SCHEDULED_SWEEP_ENABLED = raw;
      expect(getScheduledSweepEnabled()).toBe(true);
    }
  });

  it('stays OFF for anything that is not an explicit on value', () => {
    process.env.REEMIT_SCHEDULED_SWEEP_ENABLED = 'gibberish';
    expect(getScheduledSweepEnabled()).toBe(false);
    delete process.env.REEMIT_SCHEDULED_SWEEP_ENABLED;
    expect(getScheduledSweepEnabled()).toBe(false);
  });
});

describe('getReemitConfig', () => {
  it('defaults to 15m lookback / 10s settle', () => {
    expect(getReemitConfig()).toEqual({ lookbackSecs: 900, settleSecs: 10 });
  });

  it('honors positive env overrides', () => {
    process.env.REEMIT_LOOKBACK_SECS = '1800';
    process.env.REEMIT_SETTLE_SECS = '30';
    expect(getReemitConfig()).toEqual({ lookbackSecs: 1800, settleSecs: 30 });
  });

  it('falls back to defaults on invalid / non-positive values', () => {
    process.env.REEMIT_LOOKBACK_SECS = 'nope';
    process.env.REEMIT_SETTLE_SECS = '0';
    expect(getReemitConfig()).toEqual({ lookbackSecs: 900, settleSecs: 10 });
  });
});

describe('getReemitMinIntervalSecs', () => {
  it('defaults to 270s (just under the */5 cadence)', () => {
    expect(getReemitMinIntervalSecs()).toBe(270);
  });

  it('honors a positive env override', () => {
    process.env.REEMIT_MIN_INTERVAL_SECS = '120';
    expect(getReemitMinIntervalSecs()).toBe(120);
  });

  it('falls back to the default on invalid / non-positive values', () => {
    process.env.REEMIT_MIN_INTERVAL_SECS = '0';
    expect(getReemitMinIntervalSecs()).toBe(270);
  });
});

describe('reemitBitdexOps job body', () => {
  it('no-ops when the Flipt flag is OFF (default-off gate)', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await runJob();

    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    // No attempt is counted when the gate is off — attempts_total stays flat.
    expect(mockCounters.attempts.inc).not.toHaveBeenCalled();
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
    expect(mockCounters.errors.inc).not.toHaveBeenCalled();
    // The rate-limit did not trip (last run was long ago) and, since nothing was
    // emitted, the last-run marker is left untouched.
    expect(mockCounters.skipped.inc).not.toHaveBeenCalled();
    expect(mockSetLastRun).not.toHaveBeenCalled();
  });

  it('skips (rate-limited) when the last emit is inside the min interval', async () => {
    // Last successful emit was 60s ago — well inside the 270s default interval.
    mockGetJobDate.mockImplementation((key: string) =>
      Promise.resolve(
        key.includes('scheduled-sweep')
          ? [new Date(0), mockSetSweepLastRun]
          : [new Date(Date.now() - 60_000), mockSetLastRun]
      )
    );
    mockIsFlipt.mockResolvedValue(true);

    await runJob();

    // Skipped before the flag was even read; nothing emitted, marker untouched.
    expect(mockCounters.skipped.inc).toHaveBeenCalledTimes(1);
    expect(mockIsFlipt).not.toHaveBeenCalled();
    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockCounters.attempts.inc).not.toHaveBeenCalled();
    expect(mockSetLastRun).not.toHaveBeenCalled();
  });

  it('runs once the min interval has elapsed and advances the last-run marker', async () => {
    process.env.REEMIT_SCHEDULED_SWEEP_ENABLED = 'true';
    // Last emit was 5 minutes ago — past the 270s interval. Sweep clock at epoch = due.
    mockGetJobDate.mockImplementation((key: string) =>
      Promise.resolve(
        key.includes('scheduled-sweep')
          ? [new Date(0), mockSetSweepLastRun]
          : [new Date(Date.now() - 300_000), mockSetLastRun]
      )
    );
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValue([{ postsScanned: 3, imagesEmitted: 12 }]);

    await runJob();

    expect(mockCounters.skipped.inc).not.toHaveBeenCalled();
    // Both scans ran (the scheduled sweep is on by default).
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(2);
    // Each window advances only after a successful emit — one call per clock.
    expect(mockSetLastRun).toHaveBeenCalledTimes(1);
    expect(mockSetSweepLastRun).toHaveBeenCalledTimes(1);
  });

  it('runs BOTH scans and records per-scope metrics when ON', async () => {
    process.env.REEMIT_SCHEDULED_SWEEP_ENABLED = 'true';
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([{ postsScanned: 3, imagesEmitted: 12 }])
      .mockResolvedValueOnce([{ postsScanned: 700, imagesEmitted: 5600 }]);

    const result = await runJob();

    // One statement per scope — the published window first, then the sweep.
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mockDbWrite.$queryRaw.mock.calls[0][0].sql).toContain('"publishedAt" <= now()');
    expect(mockDbWrite.$queryRaw.mock.calls[1][0].sql).toContain('"publishedAt" > now()');

    expect(mockCounters.attempts.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.runs.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.errors.inc).not.toHaveBeenCalled();
    // The scheduled volume must NOT be folded into the published-window counters —
    // it is ~100x larger and would swamp the signal the existing alerts read.
    expect(mockCounters.posts.inc).toHaveBeenCalledWith(3);
    expect(mockCounters.images.inc).toHaveBeenCalledWith(12);
    expect(mockCounters.scheduledPosts.inc).toHaveBeenCalledWith(700);
    expect(mockCounters.scheduledImages.inc).toHaveBeenCalledWith(5600);
    expect(mockHistogram.observe).toHaveBeenCalledTimes(1);
    expect(mockSetLastRun).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      postsScanned: 3,
      imagesEmitted: 12,
      scheduledPostsScanned: 700,
      scheduledImagesEmitted: 5600,
    });
  });

  it('skips the second scan (and reports zeroes) when the sweep is switched off', async () => {
    process.env.REEMIT_SCHEDULED_SWEEP_ENABLED = 'false';
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValue([{ postsScanned: 3, imagesEmitted: 12 }]);

    const result = await runJob();

    // The published-window scan is unaffected by the sweep knob.
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.$queryRaw.mock.calls[0][0].sql).toContain('"publishedAt" <= now()');
    expect(mockCounters.scheduledPosts.inc).toHaveBeenCalledWith(0);
    expect(mockCounters.scheduledImages.inc).toHaveBeenCalledWith(0);
    expect(result).toMatchObject({ scheduledPostsScanned: 0, scheduledImagesEmitted: 0 });
  });

  it('skips the sweep (published scan only) when the sweep interval has not elapsed', async () => {
    process.env.REEMIT_SCHEDULED_SWEEP_ENABLED = 'true';
    // Sweep ran 5 minutes ago — inside the 1h default sweep interval. Reemit clock
    // stays at epoch so the published-window scan is not rate-limited.
    mockGetJobDate.mockImplementation((key: string) =>
      Promise.resolve(
        key.includes('scheduled-sweep')
          ? [new Date(Date.now() - 300_000), mockSetSweepLastRun]
          : [new Date(0), mockSetLastRun]
      )
    );
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValue([{ postsScanned: 3, imagesEmitted: 12 }]);

    const result = await runJob();

    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.$queryRaw.mock.calls[0][0].sql).toContain('"publishedAt" <= now()');
    // The sweep clock must NOT advance on a skipped sweep — otherwise a sweep that
    // never runs keeps pushing its own next run into the future.
    expect(mockSetSweepLastRun).not.toHaveBeenCalled();
    expect(mockSetLastRun).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scheduledPostsScanned: 0, scheduledImagesEmitted: 0 });
  });

  it('counts the error and rethrows when the SCHEDULED scan fails', async () => {
    process.env.REEMIT_SCHEDULED_SWEEP_ENABLED = 'true';
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([{ postsScanned: 3, imagesEmitted: 12 }])
      .mockRejectedValueOnce(new Error('scheduled scan blew up'));

    await expect(runJob()).rejects.toThrow(/scheduled scan blew up/);
    expect(mockCounters.errors.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
    // A partial run must not advance the rate-limit window.
    expect(mockSetLastRun).not.toHaveBeenCalled();
  });

  it('counts the attempt + error but NOT a run, and rethrows, on a PG error', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockRejectedValue(
      new Error('function bitdex_post_fanout_ops(post) does not exist')
    );

    await expect(runJob()).rejects.toThrow(/does not exist/);
    // The attempt is counted (before the emit) so a failing run still moves a
    // counter; the error counter fires; runs_total stays flat (success-only).
    expect(mockCounters.attempts.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.errors.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
    expect(mockHistogram.observe).not.toHaveBeenCalled();
    // A failed emit must NOT advance the rate-limit window — the next fire retries.
    expect(mockSetLastRun).not.toHaveBeenCalled();
  });
});
