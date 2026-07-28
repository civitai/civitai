import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDbWrite, mockIsFlipt, mockCounters, mockHistogram, mockGetJobDate, mockSetLastRun } =
  vi.hoisted(() => ({
    mockDbWrite: { $queryRaw: vi.fn() },
    mockIsFlipt: vi.fn(),
    mockCounters: {
      attempts: { inc: vi.fn() },
      runs: { inc: vi.fn() },
      errors: { inc: vi.fn() },
      posts: { inc: vi.fn() },
      images: { inc: vi.fn() },
      skipped: { inc: vi.fn() },
    },
    mockHistogram: { observe: vi.fn() },
    mockSetLastRun: vi.fn(() => Promise.resolve()),
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
  getReemitConfig,
  getReemitMinIntervalSecs,
  reemitBitdexOps,
} from '~/server/jobs/reemit-bitdex-ops';

const runJob = reemitBitdexOps as unknown as () => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.REEMIT_LOOKBACK_SECS;
  delete process.env.REEMIT_SETTLE_SECS;
  delete process.env.REEMIT_MIN_INTERVAL_SECS;
  // Default: last emit was long ago (epoch) so the rate-limit never trips unless a
  // test explicitly pins a recent last-run time.
  mockGetJobDate.mockResolvedValue([new Date(0), mockSetLastRun]);
});

afterEach(() => {
  delete process.env.REEMIT_LOOKBACK_SECS;
  delete process.env.REEMIT_SETTLE_SECS;
  delete process.env.REEMIT_MIN_INTERVAL_SECS;
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
    mockGetJobDate.mockResolvedValue([new Date(Date.now() - 60_000), mockSetLastRun]);
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
    // Last emit was 5 minutes ago — past the 270s interval.
    mockGetJobDate.mockResolvedValue([new Date(Date.now() - 300_000), mockSetLastRun]);
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValue([{ postsScanned: 3, imagesEmitted: 12 }]);

    await runJob();

    expect(mockCounters.skipped.inc).not.toHaveBeenCalled();
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    // The window advances only after a successful emit.
    expect(mockSetLastRun).toHaveBeenCalledTimes(1);
  });

  it('emits once and records metrics from the returned counts when ON', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValue([{ postsScanned: 3, imagesEmitted: 12 }]);

    const result = await runJob();

    // Single statement — exactly one query executed.
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockCounters.attempts.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.runs.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.errors.inc).not.toHaveBeenCalled();
    expect(mockCounters.posts.inc).toHaveBeenCalledWith(3);
    expect(mockCounters.images.inc).toHaveBeenCalledWith(12);
    expect(mockHistogram.observe).toHaveBeenCalledTimes(1);
    expect(mockSetLastRun).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ postsScanned: 3, imagesEmitted: 12 });
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
