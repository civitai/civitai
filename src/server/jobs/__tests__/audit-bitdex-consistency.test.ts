import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsFlipt, mockFetchDocs, mockCounters, mockHistogram } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockFetchDocs: vi.fn(),
  mockCounters: {
    checked: { inc: vi.fn() },
    compared: { inc: vi.fn() },
    opportunity: { inc: vi.fn() },
    stratumFailed: { inc: vi.fn() },
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
  bitdexAuditComparedCounter: mockCounters.compared,
  bitdexAuditOpportunityCounter: mockCounters.opportunity,
  bitdexAuditStratumFailedCounter: mockCounters.stratumFailed,
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
  baseModelDenominators,
  baseModelIsExplained,
  buildBaseModelSampleQuery,
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
  'BITDEX_AUDIT_BASEMODEL_SETTLE_SECS',
];

const clearEnv = () => AUDIT_ENV.forEach((k) => delete process.env[k]);

beforeEach(() => {
  vi.clearAllMocks();
  clearEnv();
});
afterEach(clearEnv);

// PG truth for one sampled image. NOW is arbitrary but fixed so drift math is exact.
const NOW = 1_754_400_000;
const row = (over: Partial<Record<string, number | string[]>> = {}) => ({
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
  it('defaults to 50 samples / 24h window / 5m tolerance / 2m settle / 15m baseModel settle', () => {
    expect(getAuditConfig()).toEqual({
      sampleSize: 50,
      publishedWindowSecs: 86400,
      sortAtToleranceSecs: 300,
      settleSecs: 120,
      // Wider than the others on purpose: this stratum compares a value derived from
      // ImageResourceNew, which a resource edit changes without moving Post."updatedAt".
      baseModelSettleSecs: 900,
    });
  });

  it('honors the baseModel settle override independently of the shared one', () => {
    process.env.BITDEX_AUDIT_SETTLE_SECS = '60';
    process.env.BITDEX_AUDIT_BASEMODEL_SETTLE_SECS = '1800';
    expect(getAuditConfig()).toMatchObject({ settleSecs: 60, baseModelSettleSecs: 1800 });
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
    expect(readDocState(undefined)).toEqual({
      present: false,
      published: false,
      sortAtSecs: null,
      baseModel: null,
    });
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

describe('buildBaseModelSampleQuery', () => {
  // ⚠️ `baseModelSettleSecs`, NOT `settleSecs`. `tsconfig.json` excludes `__tests__`, so
  // tsc never sees this call: passing the wrong key left the settle bound `undefined` and
  // every substring assertion below still green — a helper that cannot fail.
  const sql = () =>
    buildBaseModelSampleQuery({
      sampleSize: 50,
      publishedWindowSecs: 86400,
      baseModelSettleSecs: 900,
    }).sql;

  // Truth for this stratum is the CHECKPOINT-only value, because that is the whole
  // defect: 868ktxe1r was the filter matching an attached LoRA's base model. A query
  // that dropped the type predicate would call the reported bug correct.
  it('derives the expected value from Checkpoint resources only', () => {
    expect(sql()).toContain(`m.type = 'Checkpoint'`);
    expect(sql()).toContain('"ImageResourceNew"');
    expect(sql()).toContain('"expectedBaseModels"');
  });

  it('samples published posts inside the window, past the settle belt', () => {
    expect(sql()).toContain('"publishedAt" <= now()');
    expect(sql()).toContain('make_interval');
    expect(sql()).toContain('"updatedAt" <');
  });

  it('samples randomly, so repeated runs cover the population', () => {
    expect(sql()).toContain('ORDER BY random()');
  });

  it('reads only', () => {
    expect(sql()).not.toMatch(/(INSERT|UPDATE|DELETE)/);
  });

  // Substring assertions alone stay green when the window and the settle belt are
  // SWAPPED — both are `make_interval(secs => $n)` and both appear either way. Pinning
  // the parameter order is what tells a 24h window from a 24h settle belt.
  it('binds window, settle and limit in that order', () => {
    const q = buildBaseModelSampleQuery({
      sampleSize: 50,
      publishedWindowSecs: 86400,
      baseModelSettleSecs: 900,
    });
    // Two settle bindings, not one: the belt bounds `Post."updatedAt"` AND
    // `Image."updatedAt"`, because a resource edit moves the second and not the first.
    expect(q.values).toEqual([86400, 900, 900, 50]);
  });
});

/**
 * The rule the whole stratum rests on. It replaced a membership test that produced a
 * measured 0.23% false-mismatch rate on correct data, because the index it treats as
 * truth glues several checkpoints into one string with no delimiter.
 */
describe('baseModelIsExplained', () => {
  it('accepts the single-checkpoint case', () => {
    expect(baseModelIsExplained('Pony', ['Pony'])).toBe(true);
  });

  it('accepts a concatenation of the image checkpoints, in either order', () => {
    expect(baseModelIsExplained('AnimaMiniMax H3', ['Anima', 'MiniMax H3'])).toBe(true);
    expect(baseModelIsExplained('MiniMax H3Anima', ['Anima', 'MiniMax H3'])).toBe(true);
  });

  // Real values from the prod replica, the ones that made the membership rule fire on
  // correct data: image 141436030 and 141433747.
  it('accepts the two production values that broke the membership rule', () => {
    expect(baseModelIsExplained('AnimaMiniMax H3', ['Anima', 'MiniMax H3'])).toBe(true);
    expect(baseModelIsExplained('LTXV 2.3Krea 2', ['Krea 2', 'LTXV 2.3'])).toBe(true);
  });

  // The property that has to survive the fix: a base model from an attached LoRA rather
  // than a checkpoint is still not explainable. Without this the rule accepts everything.
  it('rejects a value belonging to no checkpoint on the image', () => {
    expect(baseModelIsExplained('Pony', ['Illustrious'])).toBe(false);
    expect(baseModelIsExplained('IllustriousPony', ['Illustrious'])).toBe(false);
  });

  it('rejects any value when the image has no checkpoint at all', () => {
    expect(baseModelIsExplained('Illustrious', [])).toBe(false);
  });

  // A checkpoint name that is a PREFIX of the value must not be consumed greedily into a
  // false accept, and one that is a prefix of another candidate must still backtrack.
  it('does not accept a value that merely starts with a checkpoint name', () => {
    expect(baseModelIsExplained('SD 1.5 Hyper', ['SD 1.5'])).toBe(false);
  });

  it('backtracks when one candidate is a prefix of another', () => {
    expect(baseModelIsExplained('PonyPony XL', ['Pony', 'Pony XL'])).toBe(true);
  });
});

describe('compareStratum — basemodel (868ktxe1r / 868ku8x8k)', () => {
  const compare = (docs: Record<string, unknown>[], rows: unknown[]) =>
    compareStratum('basemodel', rows as never, docs as never, { sortAtToleranceSecs: 300 });

  it('accepts a document whose baseModel is one of the image checkpoints', () => {
    expect(
      compare(
        [{ id: 1, isPublished: true, baseModel: 'Pony' }],
        [row({ expectedBaseModels: ['Pony'] })]
      )
    ).toEqual([]);
  });

  // 868ktxe1r exactly: an Illustrious checkpoint carrying a Pony LoRA, served under a
  // Pony filter. Both sides go in the row so an alert can be opened from the log alone.
  it('flags a baseModel that belongs to no checkpoint on the image', () => {
    const found = compare(
      [{ id: 1, isPublished: true, baseModel: 'Pony' }],
      [row({ expectedBaseModels: ['Illustrious'] })]
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'basemodel_not_checkpoint', imageId: 1, postId: 10 });
    expect(found[0].expected).toContain('Illustrious');
    expect(found[0].actual).toContain('Pony');
  });

  it('flags a baseModel on an image that has no checkpoint at all', () => {
    const found = compare(
      [{ id: 1, isPublished: true, baseModel: 'Illustrious' }],
      [row({ expectedBaseModels: [] })]
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('basemodel_not_checkpoint');
    expect(found[0].expected).toContain('no checkpoint resource');
  });

  // 868ku8x8k: the value arriving late, so a recent image matches no filter at all.
  it('flags a missing baseModel when PG has a checkpoint for the image', () => {
    const found = compare([{ id: 1, isPublished: true }], [row({ expectedBaseModels: ['Anima'] })]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'basemodel_missing' });
    expect(found[0].expected).toContain('Anima');
  });

  // The negative control for the arm above: absent is the CORRECT answer here, so a
  // guard that flagged every empty value would fire on every tool-generated image.
  it('accepts a missing baseModel when the image has no checkpoint', () => {
    expect(compare([{ id: 1, isPublished: true }], [row({ expectedBaseModels: [] })])).toEqual([]);
  });

  it('treats the empty-string encoding as no value, not as a wrong one', () => {
    expect(
      compare([{ id: 1, isPublished: true, baseModel: '' }], [row({ expectedBaseModels: [] })])
    ).toEqual([]);
    const found = compare(
      [{ id: 1, isPublished: true, baseModel: '' }],
      [row({ expectedBaseModels: ['Pony'] })]
    );
    expect(found.map((f) => f.kind)).toEqual(['basemodel_missing']);
  });

  it('leaves an absent or unpublished document to the published_recent stratum', () => {
    expect(compare([], [row({ expectedBaseModels: ['Pony'] })])).toEqual([]);
    expect(
      compare([{ id: 1, isPublished: false }], [row({ expectedBaseModels: ['Pony'] })])
    ).toEqual([]);
  });

  // The fixture is the CONCATENATION, because that is what the index emits for a
  // multi-checkpoint image — `string_agg(..., '')`, no delimiter. A fixture holding one
  // of the two would certify a document shape production never produces, and that is the
  // test that blessed the membership bug rather than catching it.
  it('does not call a glued value a leak', () => {
    const found = compare(
      [{ id: 1, isPublished: true, baseModel: 'PonySDXL 1.0' }],
      [row({ expectedBaseModels: ['Pony', 'SDXL 1.0'] })]
    );
    expect(found.map((f) => f.kind)).not.toContain('basemodel_not_checkpoint');
  });

  // 🔴 But it is not "correct" either: the base-model filter is exact string equality, so
  // a glued value matches NO filter — 868ku8x8k's symptom by another route. The previous
  // rule removed a false positive; accepting this silently would have removed a real
  // defect with it. Its own kind, so the leak series keeps meaning what it says.
  it('reports a glued value as unfilterable rather than as agreement', () => {
    const found = compare(
      [{ id: 1, isPublished: true, baseModel: 'PonySDXL 1.0' }],
      [row({ expectedBaseModels: ['Pony', 'SDXL 1.0'] })]
    );
    expect(found.map((f) => f.kind)).toEqual(['basemodel_unfilterable']);
    expect(found[0].actual).toContain('matches no base-model filter');
  });

  // The negative control for the arm above: one exact checkpoint is the clean case and
  // must stay silent, or the new kind fires on every image on the site.
  it('stays silent when the value is exactly one of the checkpoints', () => {
    expect(
      compare(
        [{ id: 1, isPublished: true, baseModel: 'Pony' }],
        [row({ expectedBaseModels: ['Pony', 'SDXL 1.0'] })]
      )
    ).toEqual([]);
  });

  it('still flags a glued value carrying a base model from no checkpoint', () => {
    const found = compare(
      [{ id: 1, isPublished: true, baseModel: 'PonyIllustrious' }],
      [row({ expectedBaseModels: ['Pony'] })]
    );
    expect(found.map((f) => f.kind)).toEqual(['basemodel_not_checkpoint']);
  });

  // The sample query is the only thing that supplies this column. Defaulting a missing
  // one to `[]` would read as "no checkpoint anywhere" and silence both arms while the
  // denominators stayed healthy — so it throws instead, and the run fails loudly.
  it('throws rather than treating a missing expectedBaseModels as no checkpoint', () => {
    expect(() => compare([{ id: 1, isPublished: true, baseModel: 'Pony' }], [row()])).toThrow(
      /expectedBaseModels/
    );
  });
});

describe('baseModelDenominators', () => {
  // What makes the mismatch count readable. A run that compared nothing produces the
  // same zero as a run that agreed on everything.
  it('counts only documents that were actually comparable', () => {
    const rows = [
      row({ imageId: 1, expectedBaseModels: ['Pony'] }),
      row({ imageId: 2, expectedBaseModels: [] }),
      row({ imageId: 3, expectedBaseModels: ['Anima'] }),
      row({ imageId: 4, expectedBaseModels: ['Anima'] }),
    ];
    const docs = [
      { id: 1, isPublished: true, baseModel: 'Pony' },
      { id: 2, isPublished: true },
      { id: 3, isPublished: false },
      { id: 4 },
    ];
    expect(baseModelDenominators(rows as never, docs as never)).toEqual({
      comparedDocs: 2,
      withCheckpoint: 1,
      withDocValue: 1,
    });
  });

  it('is zero on every count when BitDex holds none of the sample', () => {
    expect(
      baseModelDenominators([row({ expectedBaseModels: ['Pony'] })] as never, [] as never)
    ).toEqual({
      comparedDocs: 0,
      withCheckpoint: 0,
      withDocValue: 0,
    });
  });

  // The `not_checkpoint` arm's zero needs its own denominator: a sample where every
  // compared document carried NO value can only produce `basemodel_missing`, so a zero
  // on the other arm says nothing. One number covering both arms would hide that.
  // 🔴 The marginals are IDENTICAL to the case above — same comparedDocs, withCheckpoint
  // and withDocValue — while the comparison work is completely different: there, one
  // image with both and one with neither, so only the leak arm could fire; here, one
  // image with a checkpoint and no value and one with a value and no checkpoint, so BOTH
  // arms could. Marginals cannot tell those apart, which is why the per-arm opportunity
  // counts exist. If you are tempted to merge these two tests, that is the reason not to.
  it('counts the two arms with separate opportunity denominators', () => {
    const rows = [
      row({ imageId: 1, expectedBaseModels: ['Pony'] }),
      row({ imageId: 2, expectedBaseModels: [] }),
    ];
    const docs = [
      { id: 1, isPublished: true },
      { id: 2, isPublished: true, baseModel: 'Pony' },
    ];
    expect(baseModelDenominators(rows as never, docs as never)).toEqual({
      comparedDocs: 2,
      withCheckpoint: 1,
      withDocValue: 1,
    });
  });
});

describe('auditBitdexConsistency job body', () => {
  const scheduledRows = [row()];
  const publishedRows = [row({ imageId: 2, postId: 20 })];
  const baseModelRows = [row({ imageId: 3, postId: 30, expectedBaseModels: ['Pony'] })];
  const baseModelDocs = [{ id: 3, isPublished: true, baseModel: 'Pony' }];

  it('no-ops when the Flipt flag is OFF (default-off gate)', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await runJob();

    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockFetchDocs).not.toHaveBeenCalled();
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
  });

  it('samples both strata, counts checks, and records a clean run', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce(scheduledRows)
      .mockResolvedValueOnce(publishedRows)
      .mockResolvedValueOnce(baseModelRows);
    mockFetchDocs
      .mockResolvedValueOnce([{ id: 1, isPublished: false }])
      .mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }])
      .mockResolvedValueOnce(baseModelDocs);

    const result = await runJob();

    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(3);
    expect(mockFetchDocs).toHaveBeenCalledTimes(3);
    // The baseModel stratum asks for a different field set; requesting the default one
    // would return documents with no baseModel key and read as a clean audit forever.
    expect(mockFetchDocs.mock.calls[2][2]).toContain('baseModel');
    // `sortAt` is not decoration here. `publishedAt` is never a document field — the
    // indexer destructures it out and emits `publishedAtUnix` — so without `sortAt`,
    // document presence rests on `isPublished` alone, and a projection missing that one
    // key would skip every row and report the stratum clean.
    expect(mockFetchDocs.mock.calls[2][2]).toContain('sortAt');
    // Docs are requested by the sampled image ids, from the civitai index.
    expect(mockFetchDocs.mock.calls[0][0]).toBe('civitai');
    expect(mockFetchDocs.mock.calls[0][1]).toEqual([1]);
    expect(mockCounters.checked.inc).toHaveBeenCalledWith({ stratum: 'scheduled' }, 1);
    expect(mockCounters.checked.inc).toHaveBeenCalledWith({ stratum: 'published_recent' }, 1);
    expect(mockCounters.checked.inc).toHaveBeenCalledWith({ stratum: 'basemodel' }, 1);
    expect(mockCounters.mismatch.inc).not.toHaveBeenCalled();
    expect(mockCounters.runs.inc).toHaveBeenCalledTimes(1);
    expect(mockHistogram.observe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scheduledChecked: 1,
      scheduledMismatches: 0,
      publishedChecked: 1,
      publishedMismatches: 0,
      baseModelChecked: 1,
      // The zero below means agreement only because these two are nonzero.
      baseModelComparedDocs: 1,
      baseModelWithCheckpoint: 1,
      baseModelWithDocValue: 1,
      baseModelMismatches: 0,
    });
  });

  it('counts a mismatch under its stratum and kind', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce(scheduledRows)
      .mockResolvedValueOnce(publishedRows)
      .mockResolvedValueOnce(baseModelRows);
    mockFetchDocs
      .mockResolvedValueOnce([{ id: 1, isPublished: true }])
      .mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }])
      .mockResolvedValueOnce(baseModelDocs);

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
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(publishedRows)
      .mockResolvedValueOnce(baseModelRows);
    mockFetchDocs
      .mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }])
      .mockResolvedValueOnce(baseModelDocs);

    const result = await runJob();

    expect(mockFetchDocs).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scheduledChecked: 0, publishedChecked: 1, baseModelChecked: 1 });
  });

  // The denominators have to reach the surface an ALERT reads, not only the Axiom line.
  // `checked_total` counts rows SAMPLED; a row whose document is absent is skipped before
  // any comparison, so without these a stratum that compared nothing emits the same
  // mismatch zero as perfect agreement.
  it('emits the compared and per-arm opportunity counts to prometheus', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(baseModelRows);
    mockFetchDocs.mockResolvedValueOnce(baseModelDocs);

    await runJob();

    expect(mockCounters.compared.inc).toHaveBeenCalledWith({ stratum: 'basemodel' }, 1);
    expect(mockCounters.opportunity.inc).toHaveBeenCalledWith(
      { stratum: 'basemodel', kind: 'basemodel_not_checkpoint' },
      1
    );
    expect(mockCounters.opportunity.inc).toHaveBeenCalledWith(
      { stratum: 'basemodel', kind: 'basemodel_unfilterable' },
      1
    );
    // 🔴 The missing arm's denominator is compared-docs-WITH-a-checkpoint, not the count
    // of documents missing a value — that second thing is the arm's own NUMERATOR, and a
    // previous round shipped it as the denominator, giving a ratio of permanently 1 or
    // 0/0. This fixture has one compared document that has both a checkpoint and a value,
    // so the denominator is 1 while the arm cannot fire.
    expect(mockCounters.opportunity.inc).toHaveBeenCalledWith(
      { stratum: 'basemodel', kind: 'basemodel_missing' },
      1
    );
  });

  // The catch is for ONE failure, not for any failure. `fetchBitdexDocuments` throws on
  // every error precisely so an unreachable index cannot be mistaken for a clean audit;
  // swallowing that here would report a BitDex outage as a caught stratum failure on a
  // run recorded as successful — the silent pass its contract forbids.
  it('does not swallow a BitDex fetch failure in the baseModel stratum', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce(scheduledRows)
      .mockResolvedValueOnce(publishedRows)
      .mockResolvedValueOnce(baseModelRows);
    mockFetchDocs
      .mockResolvedValueOnce([{ id: 1, isPublished: false }])
      .mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }])
      .mockRejectedValueOnce(new Error('BitDex documents fetch failed 503'));

    await expect(runJob()).rejects.toThrow(/503/);
    expect(mockCounters.runs.inc).not.toHaveBeenCalled();
  });

  // Split because `basemodel_unfilterable` is expected to be nonzero on a healthy system:
  // folding it into the summary count puts the same permanent floor under the number a
  // human reads that keeping it out of the alerting series was meant to avoid.
  it('keeps unfilterable out of the mismatch summary and reports it separately', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        row({ imageId: 3, postId: 30, expectedBaseModels: ['Pony', 'SDXL 1.0'] }),
      ]);
    mockFetchDocs.mockResolvedValueOnce([{ id: 3, isPublished: true, baseModel: 'PonySDXL 1.0' }]);

    const result = (await runJob()) as Record<string, unknown>;

    expect(result.baseModelUnfilterable).toBe(1);
    expect(result.baseModelMismatches).toBe(0);

    // The Axiom line too, not only the return value: they are separate call sites and a
    // mutation of the log alone left this test green until this assertion existed. The
    // log is what a human actually reads when they go looking.
    const payload = loggingMock.logToAxiom.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload.baseModelUnfilterable).toBe(1);
    expect(payload.baseModelMismatches).toBe(0);
  });

  // 🔴 A column-shape problem in the NEWEST stratum must not silence the detector for the
  // 2026-08-06 incident class. Before this, the throw propagated out of runAudit and the
  // already-computed scheduled/published results were discarded — no checked, no
  // mismatch, no runs increment, on every run until someone noticed.
  it('keeps the other two strata reporting when the baseModel stratum throws', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce(scheduledRows)
      .mockResolvedValueOnce(publishedRows)
      // No expectedBaseModels — the shape `expectedBaseModelsOf` refuses.
      .mockResolvedValueOnce([row({ imageId: 3, postId: 30 })]);
    mockFetchDocs
      .mockResolvedValueOnce([{ id: 1, isPublished: false }])
      .mockResolvedValueOnce([{ id: 2, isPublished: true, sortAt: NOW }])
      .mockResolvedValueOnce([{ id: 3, isPublished: true, baseModel: 'Pony' }]);

    const result = (await runJob()) as Record<string, unknown>;

    expect(mockCounters.checked.inc).toHaveBeenCalledWith({ stratum: 'scheduled' }, 1);
    expect(mockCounters.checked.inc).toHaveBeenCalledWith({ stratum: 'published_recent' }, 1);
    expect(mockCounters.runs.inc).toHaveBeenCalledTimes(1);
    // Loud, not swallowed — and the failed stratum contributes no zero that reads as
    // agreement: checked stays 0 and the error is on the record.
    expect(mockCounters.errors.inc).toHaveBeenCalledTimes(1);
    expect(result.baseModelChecked).toBe(0);
    expect(result.baseModelError).toMatch(/expectedBaseModels/);
    // 🔴 The denominator series must still be CREATED, with zero. prom-client makes a
    // labelled child on first `inc`, so skipping the call leaves the series absent, and
    // `increase(...) == 0` over an absent series returns an empty vector — the alert
    // silently never fires. An earlier round asserted the opposite and pinned that gap
    // in place. Absence is worse than a flat line, not safer than one.
    expect(mockCounters.compared.inc).toHaveBeenCalledWith({ stratum: 'basemodel' }, 0);
    // And the failure is attributable: errors_total is unlabelled and shared with
    // whole-run throws, so this is the only series that says WHICH stratum died.
    expect(mockCounters.stratumFailed.inc).toHaveBeenCalledWith({ stratum: 'basemodel' }, 1);
  });

  // 🔴 The one that pins the machinery. The two zero-denominator tests around it assert
  // values IDENTICAL to the `?? 0` fallback the job reads them through, so deleting the
  // whole `baseModelDenominators` spread from `auditStratum` leaves them green — measured.
  // This one asserts a nonzero comparedDocs beside a zero withCheckpoint, which only the
  // real computation produces. Do not "simplify" it back into the zero case.
  it('reports denominators that a missing computation could not produce', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ imageId: 3, postId: 30, expectedBaseModels: [] })]);
    mockFetchDocs.mockResolvedValueOnce([{ id: 3, isPublished: true }]);

    const result = await runJob();

    expect(result).toMatchObject({
      baseModelChecked: 1,
      baseModelComparedDocs: 1,
      baseModelWithCheckpoint: 0,
      baseModelWithDocValue: 0,
      baseModelMismatches: 0,
    });
  });

  // The failure this guard exists to not have: it must be impossible to read a clean
  // baseModel audit off a run that compared nothing. Same mismatch count as the clean
  // run above, and the denominators are what separate them.
  it('reports zero denominators when BitDex holds none of the sampled images', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(baseModelRows);
    mockFetchDocs.mockResolvedValueOnce([{ id: 3 }]);

    const result = await runJob();

    expect(result).toMatchObject({
      baseModelChecked: 1,
      baseModelComparedDocs: 0,
      baseModelWithCheckpoint: 0,
      baseModelMismatches: 0,
    });
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
