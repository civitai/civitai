import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDbWrite, mockIsFlipt, mockCounters, mockHistogram } = vi.hoisted(() => ({
  mockDbWrite: { $queryRaw: vi.fn() },
  mockIsFlipt: vi.fn(),
  mockCounters: {
    attempts: { inc: vi.fn() },
    runs: { inc: vi.fn() },
    errors: { inc: vi.fn() },
    posts: { inc: vi.fn() },
    images: { inc: vi.fn() },
  },
  mockHistogram: { observe: vi.fn() },
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
}));
// createJob just returns the body fn so the test can invoke it directly.
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import {
  buildReemitQuery,
  getReemitConfig,
  reemitBitdexOps,
} from '~/server/jobs/reemit-bitdex-ops';

const runJob = reemitBitdexOps as unknown as () => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.REEMIT_LOOKBACK_SECS;
  delete process.env.REEMIT_SETTLE_SECS;
});

afterEach(() => {
  delete process.env.REEMIT_LOOKBACK_SECS;
  delete process.env.REEMIT_SETTLE_SECS;
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

describe('reemitBitdexOps job body', () => {
  it('no-ops when the Flipt flag is OFF (default-off gate)', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await runJob();

    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    // No attempt is counted when the gate is off — attempts_total stays flat.
    expect(mockCounters.attempts.inc).not.toHaveBeenCalled();
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
    expect(mockCounters.errors.inc).not.toHaveBeenCalled();
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
  });
});
