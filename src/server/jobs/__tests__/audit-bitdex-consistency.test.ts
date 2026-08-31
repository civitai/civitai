import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsFlipt, mockFetchDocs, mockCounters, mockHistogram } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockFetchDocs: vi.fn(),
  mockCounters: {
    checked: { inc: vi.fn() },
    mismatch: { inc: vi.fn() },
    runs: { inc: vi.fn() },
    errors: { inc: vi.fn() },
  },
  mockHistogram: { observe: vi.fn() },
}));

vi.mock('~/server/bitdex/client', () => ({ fetchBitdexDocuments: mockFetchDocs }));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: { BITDEX_CONSISTENCY_AUDIT: 'bitdex-consistency-audit' },
}));
vi.mock('~/server/prom/client', () => ({
  bitdexAuditCheckedCounter: mockCounters.checked,
  bitdexAuditMismatchCounter: mockCounters.mismatch,
  bitdexAuditRunsCounter: mockCounters.runs,
  bitdexAuditErrorsCounter: mockCounters.errors,
  bitdexAuditRunDurationHistogram: mockHistogram,
}));
// createJob just returns the body fn so the test can invoke it directly.
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
}));

import {
  auditBitdexConsistency,
  buildPublishedSampleQuery,
  buildScheduledSampleQuery,
  compareStratum,
  getAuditConfig,
  readDocState,
} from '~/server/jobs/audit-bitdex-consistency';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbWrite = dbMock.dbWrite;

const runJob = auditBitdexConsistency as unknown as () => Promise<unknown>;

const AUDIT_ENV = [
  'BITDEX_AUDIT_SAMPLE_SIZE',
  'BITDEX_AUDIT_PUBLISHED_WINDOW_SECS',
  'BITDEX_AUDIT_SORTAT_TOLERANCE_SECS',
  'BITDEX_AUDIT_SETTLE_SECS',
];

const clearEnv = () => AUDIT_ENV.forEach((k) => delete process.env[k]);

beforeEach(() => {
  vi.clearAllMocks();
  clearEnv();
});
afterEach(clearEnv);

// PG truth for one sampled image. NOW is arbitrary but fixed so drift math is exact.
const NOW = 1_754_400_000;
const row = (over: Partial<Record<string, number>> = {}) => ({
  imageId: 1,
  postId: 10,
  publishedAtSecs: NOW,
  expectedSortAtSecs: NOW,
  ...over,
});

describe('buildScheduledSampleQuery', () => {
  const sql = () => buildScheduledSampleQuery({ sampleSize: 50, settleSecs: 120 }).sql;

  it('samples ONLY future-scheduled posts (the incident class)', () => {
    expect(sql()).toContain('"publishedAt" > now()');
    expect(sql()).not.toContain('"publishedAt" <= now()');
  });

  it('randomizes so repeated runs cover the population, not the same head', () => {
    expect(sql()).toContain('ORDER BY random()');
    expect(sql()).toContain('LIMIT');
  });

  it('skips posts still settling, so lag is not read as a mismatch', () => {
    expect(sql()).toContain('"updatedAt" < now() - make_interval');
  });

  it('asks PG for the GREATEST(publishedAt, scannedAt, createdAt) sortAt expectation', () => {
    // The expectation must be computed with the same semantics the index config
    // uses, not reimplemented in JS from a partial set of columns.
    expect(sql()).toMatch(/GREATEST\(p\."publishedAt", i\."scannedAt", i\."createdAt"\)/);
  });

  it('parameterizes settle and sample size (no literal injection)', () => {
    const query = buildScheduledSampleQuery({ sampleSize: 50, settleSecs: 120 });
    expect(query.values).toEqual([120, 50]);
    expect(query.sql).not.toContain('50');
  });

  it('is read-only — an audit that writes cannot report an honest rate', () => {
    // Case-sensitive on purpose: the builders spell keywords in caps, and a
    // case-insensitive match would hit the `"updatedAt"` column name.
    expect(sql()).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe('buildPublishedSampleQuery', () => {
  const args = { sampleSize: 50, publishedWindowSecs: 86400, settleSecs: 120 };
  const sql = () => buildPublishedSampleQuery(args).sql;

  it('bounds the sample to the recent published window on both sides', () => {
    expect(sql()).toContain('"publishedAt" > now() - make_interval');
    expect(sql()).toContain('"publishedAt" <= now()');
  });

  it('parameterizes window, settle and sample size', () => {
    expect(buildPublishedSampleQuery(args).values).toEqual([86400, 120, 50]);
  });

  it('is read-only', () => {
    expect(sql()).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe('getAuditConfig', () => {
  it('defaults to 50 samples / 24h window / 5m tolerance / 2m settle', () => {
    expect(getAuditConfig()).toEqual({
      sampleSize: 50,
      publishedWindowSecs: 86400,
      sortAtToleranceSecs: 300,
      settleSecs: 120,
    });
  });

  it('honors positive env overrides', () => {
    process.env.BITDEX_AUDIT_SAMPLE_SIZE = '200';
    process.env.BITDEX_AUDIT_SORTAT_TOLERANCE_SECS = '60';
    expect(getAuditConfig()).toMatchObject({ sampleSize: 200, sortAtToleranceSecs: 60 });
  });

  it('falls back to defaults on invalid / non-positive values', () => {
    process.env.BITDEX_AUDIT_SAMPLE_SIZE = '0';
    process.env.BITDEX_AUDIT_SETTLE_SECS = 'nope';
    expect(getAuditConfig()).toMatchObject({ sampleSize: 50, settleSecs: 120 });
  });
});

describe('readDocState', () => {
  it('reports a missing doc as absent, not as unpublished-with-data', () => {
    expect(readDocState(undefined)).toEqual({ present: false, published: false, sortAtSecs: null });
  });

  it('treats a bare { id } (no doc on disk) as absent', () => {
    // The batch endpoint returns just the id for a slot with no stored document.
    expect(readDocState({ id: 7 })).toMatchObject({ present: false, published: false });
  });

  it('takes isPublished as the authority when present', () => {
    expect(readDocState({ id: 7, isPublished: false, publishedAt: NOW })).toMatchObject({
      present: true,
      published: false,
    });
  });

  it('falls back to publishedAt when isPublished is absent from the payload', () => {
    // isPublished is an exists_boolean derived FROM publishedAt, so the two carry
    // the same fact and either one is sufficient to answer "is it published".
    expect(readDocState({ id: 7, publishedAt: NOW })).toMatchObject({
      present: true,
      published: true,
    });
    expect(readDocState({ id: 7, publishedAt: null })).toMatchObject({
      present: true,
      published: false,
    });
  });
});

describe('compareStratum — scheduled (the incident class)', () => {
  const compare = (docs: Record<string, unknown>[], rows = [row()]) =>
    compareStratum('scheduled', rows as never, docs as never, { sortAtToleranceSecs: 300 });

  it('flags a scheduled image BitDex holds as published', () => {
    const found = compare([{ id: 1, isPublished: true, sortAt: NOW }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'scheduled_visible',
      stratum: 'scheduled',
      imageId: 1,
      postId: 10,
    });
    // The trail an alert needs: both sides of the disagreement, not just a count.
    expect(found[0].expected).toContain('unpublished');
    expect(found[0].actual).toContain('isPublished=true');
  });

  it('accepts a scheduled image held as unpublished', () => {
    expect(compare([{ id: 1, isPublished: false, publishedAt: null }])).toEqual([]);
  });

  it('accepts a scheduled image with no doc at all (not yet indexed is legal)', () => {
    expect(compare([])).toEqual([]);
  });

  it('does not flag sortAt drift in this stratum — only visibility matters', () => {
    // A scheduled doc may legitimately carry any sortAt; only "published" is wrong.
    expect(compare([{ id: 1, isPublished: false, sortAt: NOW + 999_999 }])).toEqual([]);
  });

  it('flags each offending image independently', () => {
    const found = compare(
      [
        { id: 1, isPublished: true },
        { id: 2, isPublished: false },
        { id: 3, isPublished: true },
      ],
      [row(), row({ imageId: 2 }), row({ imageId: 3 })]
    );
    expect(found.map((m) => m.imageId)).toEqual([1, 3]);
  });
});

describe('compareStratum — published_recent', () => {
  const compare = (docs: Record<string, unknown>[], rows = [row()]) =>
    compareStratum('published_recent', rows as never, docs as never, { sortAtToleranceSecs: 300 });

  it('flags a published image whose doc is absent from BitDex', () => {
    const found = compare([]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'published_missing', imageId: 1 });
    expect(found[0].actual).toContain('absent');
  });

  it('flags a published image BitDex holds as unpublished', () => {
    const found = compare([{ id: 1, isPublished: false, sortAt: NOW }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'published_missing' });
    expect(found[0].actual).toContain('isPublished=false');
  });

  it('accepts a sortAt inside the tolerance (propagation lag is not a mismatch)', () => {
    expect(compare([{ id: 1, isPublished: true, sortAt: NOW - 299 }])).toEqual([]);
    expect(compare([{ id: 1, isPublished: true, sortAt: NOW + 300 }])).toEqual([]);
  });

  it('flags a sortAt outside the tolerance, in either direction', () => {
    const late = compare([{ id: 1, isPublished: true, sortAt: NOW + 601 }]);
    expect(late[0]).toMatchObject({ kind: 'sortat_drift' });
    expect(late[0].actual).toContain('drift=601s');

    const early = compare([{ id: 1, isPublished: true, sortAt: NOW - 601 }]);
    expect(early[0]).toMatchObject({ kind: 'sortat_drift' });
  });

  it('flags a published doc carrying no sortAt at all', () => {
    const found = compare([{ id: 1, isPublished: true }]);
    expect(found[0]).toMatchObject({ kind: 'sortat_drift' });
    expect(found[0].actual).toContain('sortAt=null');
  });

  it('reports missing-publish rather than drift when both are wrong', () => {
    // A doc that is not published has no meaningful sortAt to drift; reporting both
    // would double-count one broken image across two alert series.
    const found = compare([{ id: 1, isPublished: false, sortAt: 0 }]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('published_missing');
  });
});

describe('auditBitdexConsistency job body', () => {
  const scheduledRows = [row()];
  const publishedRows = [row({ imageId: 2, postId: 20 })];

  it('no-ops when the Flipt flag is OFF (default-off gate)', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await runJob();

    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockFetchDocs).not.toHaveBeenCalled();
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
  });

  it('samples both strata, counts checks, and records a clean run', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValueOnce(scheduledRows).mockResolvedValueOnce(publishedRows);
    mockFetchDocs
      .mockResolvedValueOnce([{ id: 1, isPublished: false }])
      .mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }]);

    const result = await runJob();

    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mockFetchDocs).toHaveBeenCalledTimes(2);
    // Docs are requested by the sampled image ids, from the civitai index.
    expect(mockFetchDocs.mock.calls[0][0]).toBe('civitai');
    expect(mockFetchDocs.mock.calls[0][1]).toEqual([1]);
    expect(mockCounters.checked.inc).toHaveBeenCalledWith({ stratum: 'scheduled' }, 1);
    expect(mockCounters.checked.inc).toHaveBeenCalledWith({ stratum: 'published_recent' }, 1);
    expect(mockCounters.mismatch.inc).not.toHaveBeenCalled();
    expect(mockCounters.runs.inc).toHaveBeenCalledTimes(1);
    expect(mockHistogram.observe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scheduledChecked: 1,
      scheduledMismatches: 0,
      publishedChecked: 1,
      publishedMismatches: 0,
    });
  });

  it('counts a mismatch under its stratum and kind', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValueOnce(scheduledRows).mockResolvedValueOnce(publishedRows);
    mockFetchDocs
      .mockResolvedValueOnce([{ id: 1, isPublished: true }])
      .mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }]);

    const result = await runJob();

    expect(mockCounters.mismatch.inc).toHaveBeenCalledWith(
      { stratum: 'scheduled', kind: 'scheduled_visible' },
      1
    );
    expect(result).toMatchObject({ scheduledMismatches: 1, publishedMismatches: 0 });
    // A run that finds something is still a successful run — the alert reads the
    // mismatch series, and runs_total has to stay trustworthy as the liveness signal.
    expect(mockCounters.runs.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.errors.inc).not.toHaveBeenCalled();
  });

  it('skips the BitDex fetch when a stratum sampled nothing', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(publishedRows);
    mockFetchDocs.mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }]);

    const result = await runJob();

    expect(mockFetchDocs).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scheduledChecked: 0, publishedChecked: 1 });
  });

  it('errors (does NOT report a clean audit) when the BitDex fetch fails', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockResolvedValue(scheduledRows);
    mockFetchDocs.mockRejectedValue(new Error('BitDex documents fetch failed 503'));

    await expect(runJob()).rejects.toThrow(/503/);
    // The one outcome this job must never produce is a silent pass.
    expect(mockCounters.errors.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
    expect(mockCounters.mismatch.inc).not.toHaveBeenCalled();
    expect(mockHistogram.observe).not.toHaveBeenCalled();
  });

  it('errors when the PG sample fails', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw.mockRejectedValue(new Error('relation "Post" does not exist'));

    await expect(runJob()).rejects.toThrow(/does not exist/);
    expect(mockCounters.errors.inc).toHaveBeenCalledTimes(1);
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
  });
});
