import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
}));

const { mockSetModelMinor, mockTrackModActivity, mockLogToAxiom, mockQueueImageSearchIndexUpdate } =
  vi.hoisted(() => ({
    mockSetModelMinor: vi.fn(),
    mockTrackModActivity: vi.fn(),
    mockLogToAxiom: vi.fn(),
    mockQueueImageSearchIndexUpdate: vi.fn(),
  }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
// MINOR_FLAG_SNAPSHOT_KEY is read at module scope by the service's Prisma.sql
// fragments — omitting it from the mock makes the whole file fail to import
// (which vitest reports as a passing run with zero tests collected).
vi.mock('~/server/services/model.service', () => ({
  setModelMinor: mockSetModelMinor,
  MINOR_FLAG_SNAPSHOT_KEY: 'minorFlagSnapshot',
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: mockTrackModActivity }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: mockQueueImageSearchIndexUpdate,
}));

import {
  findMinorHashMatches,
  applyMinorHashMatch,
  checkMinorHashOnScan,
  sweepMinorHashMatches,
  getMinorHashMatchesForReview,
  dismissMinorHashMatch,
  rollbackMinorHashAutoFlags,
  getAutoFlaggedMinorModels,
  getAutoFlaggedMinorMatch,
  getAutoFlaggedMinorDetail,
  getMinorHashMatchDetail,
  confirmMinorHashAutoFlag,
  revertMinorHashAutoFlag,
  minorSrcCte,
  minorHashCandidatesCte,
  MINOR_HASH_FILE_TYPE,
  MINOR_HASH_CLEARED_KEY,
  MINOR_HASH_ACCEPTED_KEY,
  AUTO_FLAG_REVIEW_WINDOW_DAYS,
} from '~/server/services/minor-hash.service';

beforeEach(() => {
  vi.clearAllMocks();
  // mockRejectedValue in later checkMinorHashOnScan tests otherwise persists past clearAllMocks
  // (which only clears call history, not implementations) and leaks into sweepMinorHashMatches.
  mockSetModelMinor.mockReset();
  mockDbRead.$queryRaw.mockResolvedValue([]);
  mockLogToAxiom.mockResolvedValue(undefined);
});

describe('findMinorHashMatches', () => {
  it('maps rows to { modelId, userId }', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: 10, userId: 1 },
      { id: 11, userId: 2 },
    ]);

    const result = await findMinorHashMatches('ABC123');

    expect(result).toEqual([
      { modelId: 10, userId: 1 },
      { modelId: 11, userId: 2 },
    ]);
  });

  it('returns [] without querying when the hash is empty', async () => {
    const result = await findMinorHashMatches('');

    expect(result).toEqual([]);
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('queries with the SHA256 + minor + lockedProperties gate', async () => {
    await findMinorHashMatches('ABC123');

    // $queryRaw is called as a tagged template, so the mock receives
    // (TemplateStringsArray, ...substitutions) — not a single Sql object.
    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    // The minor/lockedProperties gate is interpolated as a shared Prisma.Sql
    // fragment now, so it lands in values rather than the template strings.
    const rendered = [
      text,
      ...values.map((v) => (v as { strings?: readonly string[] })?.strings?.join('?') ?? ''),
    ].join('\n');
    expect(text).toContain(`'SHA256'`);
    expect(rendered).toContain('m.minor');
    expect(rendered).toContain(`'minor' = ANY(m."lockedProperties")`);
    expect(text).toContain('mf.type =');
    expect(values).toContain(MINOR_HASH_FILE_TYPE);
    expect(values).toContain('ABC123');
  });

  // The scan hook had its own copy of the seed predicate; if the two disagree,
  // a hash the sweep refuses to seed from could still auto-flag at upload time.
  it('gates on the same seed definition the sweep CTE uses', async () => {
    await findMinorHashMatches('ABC123');

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const fragments = values.filter((v) => (v as { strings?: readonly string[] })?.strings) as {
      strings: readonly string[];
      values: unknown[];
    }[];
    const rendered = [
      Array.from(strings as TemplateStringsArray).join('?'),
      ...fragments.map((f) => f.strings.join('?')),
    ].join('\n');

    expect(rendered).toContain(`->>'source' IS DISTINCT FROM 'auto'`);
    expect(rendered).toContain(`'minor' = ANY(m."lockedProperties")`);
    // same fragment the CTE embeds, not a hand-rolled copy
    expect(fragments.some((f) => f.strings.join('?').includes('IS DISTINCT FROM'))).toBe(true);
  });

  it('uppercases the hash — stored hashes are uppercase hex', async () => {
    await findMinorHashMatches('abc123');

    const [, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    expect(values).toContain('ABC123');
    expect(values).not.toContain('abc123');
  });
});

// The CTEs are interpolated into $queryRaw as Prisma.Sql VALUES, so their bodies
// land in `values` and never appear in the `strings` the query-text tests above
// inspect. Deleting a predicate here would widen the seed set with every other
// test still green, so assert on the CTE text directly.
describe('minor-hash CTE predicates', () => {
  it('restricts the seed set to moderator-locked minor models', () => {
    expect(minorSrcCte.sql).toContain('m.minor');
    expect(minorSrcCte.sql).toContain(`'minor' = ANY(m."lockedProperties")`);
    expect(minorSrcCte.sql).toContain(`mfh.type = 'SHA256'`);
    expect(minorSrcCte.sql).toContain('mf.type =');
    expect(minorSrcCte.values).toContain(MINOR_HASH_FILE_TYPE);
  });

  // Without this the sweep seeds itself: an auto-flagged model contributes every
  // hash on it, so the seed set grows from machine decisions and the dry run
  // under-reports what a live run will write (observed 300 predicted / 302
  // written on a prod-scale clone).
  it('excludes auto-flagged models from the seed set so it cannot self-amplify', () => {
    expect(minorSrcCte.sql).toContain(`->>'source' IS DISTINCT FROM 'auto'`);
    expect(minorSrcCte.values).toContain('minorFlagSnapshot');
  });

  // A moderator's own "Set as Minor" writes source='manual', so it must still
  // seed — only the machine's own output is excluded.
  it('keeps manual moderator flags eligible as seeds', () => {
    expect(minorSrcCte.sql).not.toContain(`IS DISTINCT FROM 'manual'`);
    expect(minorSrcCte.sql).not.toContain(`? 'minorFlagSnapshot'`);
  });

  // Rollback deletes the snapshot, so without the clear stamp the model is an
  // ordinary candidate again and the next sweep re-flags what a human just undid.
  it('excludes models a rollback cleared, scoped to files that predate the clear', () => {
    expect(minorHashCandidatesCte.values).toContain(MINOR_HASH_CLEARED_KEY);
    // time-scoped, not a blanket exclusion: a file uploaded after the clear is a
    // fresh act by the uploader and must still be catchable
    expect(minorHashCandidatesCte.sql).toContain(`mf."createdAt" >`);
  });

  it('restricts candidates to non-minor, non-deleted models of the gated file type', () => {
    expect(minorHashCandidatesCte.sql).toContain('NOT m.minor');
    expect(minorHashCandidatesCte.sql).toContain(`m.status <> 'Deleted'`);
    expect(minorHashCandidatesCte.sql).toContain(`mfh.type = 'SHA256'`);
    expect(minorHashCandidatesCte.sql).toContain('bool_or(EXISTS (');
    expect(minorHashCandidatesCte.sql).toContain('mf.type =');
    expect(minorHashCandidatesCte.values).toContain(MINOR_HASH_FILE_TYPE);
  });
});

describe('applyMinorHashMatch', () => {
  it('flags when a match shares the uploader', async () => {
    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [{ modelId: 50, userId: 5 }],
    });

    expect(result).toBe('flagged');
    expect(mockSetModelMinor).toHaveBeenCalledWith({
      id: 100,
      minor: true,
      userId: -1,
      activity: 'setMinorAutoHash',
    });
  });

  it('queues without writing when every match is a different uploader', async () => {
    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [{ modelId: 50, userId: 9 }],
    });

    expect(result).toBe('queued');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it('flags when only one of several matches shares the uploader', async () => {
    // Guards the `.some` in applyMinorHashMatch: `.every` would silently turn a
    // real same-uploader hit into an un-actioned queue entry.
    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [
        { modelId: 50, userId: 9 },
        { modelId: 51, userId: 5 },
      ],
    });

    expect(result).toBe('flagged');
    expect(mockSetModelMinor).toHaveBeenCalledWith({
      id: 100,
      minor: true,
      userId: -1,
      activity: 'setMinorAutoHash',
    });
  });

  it('skips when there are no matches', async () => {
    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [],
    });

    expect(result).toBe('skipped');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  // The scan path can't get this from the candidate CTE — the match query's `m` is
  // the seed side — so the check lives here, and without it a moderator's revert
  // survives only until the next scan of the same file.
  it('skips a same-uploader match on a file a rollback already cleared', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ cleared: true }]);

    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [{ modelId: 50, userId: 5 }],
    });

    expect(result).toBe('skipped');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it('still flags when the clear predates the file being scanned', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ cleared: false }]);

    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [{ modelId: 50, userId: 5 }],
    });

    expect(result).toBe('flagged');
  });

  // One extra round trip per flag is fine; one per scan is not.
  it('does not look up the clear stamp on a path that will not write', async () => {
    await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [{ modelId: 50, userId: 9 }],
    });

    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('skips when the candidate is itself in the seed set', async () => {
    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [
        { modelId: 100, userId: 5 },
        { modelId: 50, userId: 5 },
      ],
    });

    expect(result).toBe('skipped');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });
});

// Pre-state capture now lives inside setModelMinor so manual moderator flags are
// snapshotted too — covered in set-model-minor.service.test.ts.
describe('applyMinorHashMatch — flag delegation', () => {
  it('delegates to setModelMinor with the auto-hash activity', async () => {
    await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [{ modelId: 50, userId: 5 }],
    });

    expect(mockSetModelMinor).toHaveBeenCalledWith({
      id: 100,
      minor: true,
      userId: -1,
      activity: 'setMinorAutoHash',
    });
  });

  it('does not flag when the outcome is only queued', async () => {
    await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      fileId: 900,
      matches: [{ modelId: 50, userId: 9 }],
    });

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });
});

describe('checkMinorHashOnScan', () => {
  it('flags a same-uploader match end to end', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 5 }]);

    const result = await checkMinorHashOnScan({
      modelId: 100,
      userId: 5,
      fileId: 900,
      sha256: 'ABC',
    });

    expect(result).toBe('flagged');
    expect(mockSetModelMinor).toHaveBeenCalledTimes(1);
  });

  it('logs auto-flags so they are countable without querying ModActivity', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 5 }]);

    await checkMinorHashOnScan({ modelId: 100, userId: 5, fileId: 900, sha256: 'ABC' });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'minor-hash-scan-check', message: 'flagged', modelId: 100 }),
      'webhooks'
    );
  });

  it('does not log when the outcome is only queued', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 9 }]);

    const result = await checkMinorHashOnScan({
      modelId: 100,
      userId: 5,
      fileId: 900,
      sha256: 'ABC',
    });

    expect(result).toBe('queued');
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('swallows and logs a lookup failure instead of throwing', async () => {
    mockDbRead.$queryRaw.mockRejectedValue(new Error('db exploded'));

    const result = await checkMinorHashOnScan({
      modelId: 100,
      userId: 5,
      fileId: 900,
      sha256: 'ABC',
    });

    expect(result).toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalled();
  });

  it('swallows a setModelMinor failure instead of throwing', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 5 }]);
    mockSetModelMinor.mockRejectedValue(new Error('update failed'));

    const result = await checkMinorHashOnScan({
      modelId: 100,
      userId: 5,
      fileId: 900,
      sha256: 'ABC',
    });

    expect(result).toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalled();
  });

  it('swallows a non-Error throw (a rejected string) and logs a readable message', async () => {
    mockDbRead.$queryRaw.mockRejectedValue('db exploded');

    const result = await checkMinorHashOnScan({
      modelId: 100,
      userId: 5,
      fileId: 900,
      sha256: 'ABC',
    });

    expect(result).toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'db exploded', modelId: 100, userId: 5, sha256: 'ABC' }),
      'webhooks'
    );
  });

  it('does not throw when the rejection value is null (property access on a non-Error cast)', async () => {
    mockDbRead.$queryRaw.mockRejectedValue(null);

    await expect(
      checkMinorHashOnScan({ modelId: 100, userId: 5, fileId: 900, sha256: 'ABC' })
    ).resolves.toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'null', modelId: 100, userId: 5, sha256: 'ABC' }),
      'webhooks'
    );
  });
});

// The SQL now filters to same-uploader rows, so the limited select only ever
// returns actionable candidates; the totals come from the separate count query.
const sweepTotals = [{ candidates: 3, sameUploader: 2 }];
const sweepRows = [
  { modelId: 101, userId: 5, sameUploader: true },
  { modelId: 102, userId: 6, sameUploader: true },
];

// call 0 = uncapped totals, call 1 = the limited actionable rows
function mockSweepQueries(totals = sweepTotals, rows = sweepRows) {
  mockDbRead.$queryRaw.mockResolvedValueOnce(totals).mockResolvedValueOnce(rows);
}

describe('sweepMinorHashMatches', () => {
  it('writes nothing on a dry run but reports the split', async () => {
    mockSweepQueries();

    const report = await sweepMinorHashMatches({ dryRun: true, limit: 100 });

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      candidates: 3,
      sameUploader: 2,
      differentUploader: 1,
      flagged: 0,
      failed: 0,
    });
    expect(report.sample.length).toBeGreaterThan(0);
  });

  it('reports the full population, not the limited window', async () => {
    // A dry run at limit 1 must still describe all 714/301/413-style totals —
    // the operator sizes the backfill from these numbers.
    mockSweepQueries([{ candidates: 714, sameUploader: 301 }], [sweepRows[0]]);

    const report = await sweepMinorHashMatches({ dryRun: true, limit: 1 });

    expect(report).toMatchObject({
      candidates: 714,
      sameUploader: 301,
      differentUploader: 413,
    });
    expect(report.sample).toHaveLength(1);
  });

  it('still reports the different-uploader backlog when nothing is actionable', async () => {
    // Steady state after the backfill: 0 same-uploader rows returned, but the
    // queue awaiting human review must not read as empty.
    mockSweepQueries([{ candidates: 413, sameUploader: 0 }], []);

    const report = await sweepMinorHashMatches({ dryRun: true, limit: 500 });

    expect(report).toMatchObject({ candidates: 413, sameUploader: 0, differentUploader: 413 });
  });

  it('caps the sample at 20 rows', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      modelId: i,
      userId: 1,
      sameUploader: true,
    }));
    mockSweepQueries([{ candidates: 50, sameUploader: 50 }], many);

    const report = await sweepMinorHashMatches({ dryRun: true, limit: 500 });

    expect(report.sample).toHaveLength(20);
  });

  it('flags every returned candidate when applying', async () => {
    mockSweepQueries();

    const report = await sweepMinorHashMatches({ dryRun: false, limit: 100 });

    expect(mockSetModelMinor).toHaveBeenCalledTimes(2);
    expect(mockSetModelMinor).toHaveBeenCalledWith({
      id: 101,
      minor: true,
      userId: -1,
      activity: 'setMinorAutoHash',
    });
    expect(report).toMatchObject({ flagged: 2, failed: 0 });
  });

  it('reports a per-model failure without aborting the batch', async () => {
    mockSweepQueries();
    mockSetModelMinor.mockRejectedValueOnce(new Error('boom'));

    const report = await sweepMinorHashMatches({ dryRun: false, limit: 100 });

    expect(report).toMatchObject({ flagged: 1, failed: 1 });
    expect(mockLogToAxiom).toHaveBeenCalled();
  });

  it('does not abort the batch when setModelMinor rejects with a non-Error value', async () => {
    mockSweepQueries();
    mockSetModelMinor.mockRejectedValueOnce(null);

    const report = await sweepMinorHashMatches({ dryRun: false, limit: 100 });

    expect(report).toMatchObject({ flagged: 1, failed: 1 });
    expect(mockLogToAxiom).toHaveBeenCalled();
  });

  it('logs the report on a real run so a timeout cannot lose it', async () => {
    mockSweepQueries();

    await sweepMinorHashMatches({ dryRun: false, limit: 100 });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'minor-hash-sweep',
        candidates: 3,
        sameUploader: 2,
        differentUploader: 1,
        flagged: 2,
        failed: 0,
      }),
      'webhooks'
    );
  });

  it('does not log a dry run', async () => {
    mockSweepQueries();

    await sweepMinorHashMatches({ dryRun: true, limit: 100 });

    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('pushes the same-uploader filter into SQL so limit caps writes', async () => {
    mockSweepQueries([{ candidates: 0, sameUploader: 0 }], []);

    await sweepMinorHashMatches({ dryRun: true, limit: 250 });

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[1];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('WHERE c."sameUploader"');
    expect(text).toContain('LIMIT');
    expect(values).toContain(250);
  });

  it('counts the population without a LIMIT', async () => {
    mockSweepQueries([{ candidates: 0, sameUploader: 0 }], []);

    await sweepMinorHashMatches({ dryRun: true, limit: 250 });

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('count(*)');
    expect(text).not.toContain('LIMIT');
    expect(values).not.toContain(250);
  });

  // Pre-state capture moved into setModelMinor so manual flags get it too; the
  // sweep no longer snapshots directly.
  it('flags every candidate row via setModelMinor', async () => {
    mockSweepQueries();

    await sweepMinorHashMatches({ dryRun: false, limit: 100 });

    expect(mockSetModelMinor).toHaveBeenCalledTimes(sweepRows.length);
    expect(mockSetModelMinor).toHaveBeenCalledWith(
      expect.objectContaining({ minor: true, userId: -1, activity: 'setMinorAutoHash' })
    );
  });

  it('does not capture pre-state on a dry run', async () => {
    mockSweepQueries();

    await sweepMinorHashMatches({ dryRun: true, limit: 100 });

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('getMinorHashMatchesForReview', () => {
  it('excludes dismissed models and different-uploader-only, without OFFSET', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getMinorHashMatchesForReview({ limit: 1000 });

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain(`NOT (m.meta ? 'minorHashDismissed')`);
    expect(text).toContain('WHERE NOT c."sameUploader"');
    // A targeted rollback of a flag applied from this queue must not put the model
    // straight back on it. The gate is a nested Prisma.Sql fragment, so its own
    // values sit one level down from the template's.
    const nested = values.flatMap((v) => (v as { values?: unknown[] })?.values ?? []);
    expect(nested).toContain(MINOR_HASH_CLEARED_KEY);
    expect(text).toContain('bool_or(EXISTS (');
    expect(text).toContain(`s2."userId" <> c."userId"`);
    // No server-side window at all: an OFFSET page skips rows as the queue is
    // actioned, and any window would confine client sorting to a partial set.
    expect(text).not.toContain('OFFSET');
    expect(values).toContain(1001); // limit + 1 truncation probe
  });

  // A model's matched version is often not its default (51 of 411 on prod-scale
  // data), so the hash and the version must come from the same aggregated row —
  // otherwise the link points at a version that never carried the hash.
  it('pairs the reported hash and modelVersionId via a matching ORDER BY', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getMinorHashMatchesForReview({ limit: 25 });

    const [strings] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('(array_agg(mfh.hash ORDER BY mfh.hash, mv.id))[1]');
    expect(text).toContain('(array_agg(mv.id ORDER BY mfh.hash, mv.id))[1]');
    // min(hash) would not identify which version carried it
    expect(text).not.toContain('min(mfh.hash)');
  });

  it('resolves the flagged model version from the shared hash', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getMinorHashMatchesForReview({ limit: 25 });

    const [strings] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('"minorModelVersionId"');
    expect(text).toContain('h2.hash = c.hash');
    expect(text).toContain('mv2."modelId" = s."minorModelId"');
  });

  it('flags truncation only when the cap is exceeded', async () => {
    const row = (modelId: number) => ({ modelId, modelName: `m${modelId}` });

    mockDbRead.$queryRaw.mockResolvedValueOnce([row(1), row(2), row(3)]);
    const over = await getMinorHashMatchesForReview({ limit: 2 });
    expect(over.items).toHaveLength(2);
    expect(over.truncated).toBe(true);

    mockDbRead.$queryRaw.mockResolvedValueOnce([row(1)]);
    const under = await getMinorHashMatchesForReview({ limit: 2 });
    expect(under.items).toHaveLength(1);
    expect(under.truncated).toBe(false);
  });
});

describe('getAutoFlaggedMinorModels', () => {
  it('lists only auto-sourced flags a moderator has not signed off yet', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getAutoFlaggedMinorModels({ limit: 1000 });

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain(`->>'source' = 'auto'`);
    expect(text).toContain('AND NOT ');
    // the human-confirmation gate is interpolated as a Prisma.Sql fragment
    const rendered = values
      .map((v) => (v as { strings?: readonly string[] })?.strings?.join('?') ?? '')
      .join('\n');
    expect(rendered).toContain('"ModActivity" ma');
    expect(rendered).toContain(`ma.activity = 'setMinor'`);
    expect(values).toContain(1001); // limit + 1 truncation probe
  });

  it('flags truncation when the cap is exceeded', async () => {
    const row = (modelId: number) => ({ modelId });
    mockDbRead.$queryRaw.mockResolvedValueOnce([row(1), row(2), row(3)]);

    const result = await getAutoFlaggedMinorModels({ limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  // The queue is unbounded otherwise — one dev-clone sweep produced 290 rows.
  it('limits the queue to the 30-day review window and skips accepted flags', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getAutoFlaggedMinorModels({ limit: 1000 });

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain(`now() - make_interval(days =>`);
    expect(text).toContain(`->>'at')::timestamptz >`);
    expect(text).toContain('AND NOT (m.meta ? ');
    expect(values).toContain(MINOR_HASH_ACCEPTED_KEY);
    expect(values).toContain(AUTO_FLAG_REVIEW_WINDOW_DAYS);
  });
});

// The auto-flag path records no pointer to what it matched — captureMinorFlagSnapshot
// stores pre-state only — so the seed has to be re-derived from the hash to show a
// moderator the evidence behind a flag that is already in force.
describe('getAutoFlaggedMinorMatch', () => {
  it('re-derives the seed from the shared hash rather than a stored pointer', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getAutoFlaggedMinorMatch({ modelId: 2186217 });

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('smfh.hash = mfh.hash');
    expect(values).toContain(2186217);
    // The whole seed set is ~17k models; a per-row panel must not build that CTE.
    expect(text).not.toContain('minor_src');
  });

  it('never reports the flagged model as its own match', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getAutoFlaggedMinorMatch({ modelId: 2186217 });

    const [strings] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('m.id <> ');
  });

  // Same gate as minor_src: without it a model auto-flagged off this one would come
  // back as its own justification once a second copy landed.
  it('only accepts human-decided flags as the seed', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getAutoFlaggedMinorMatch({ modelId: 2186217 });

    const [, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const rendered = values
      .map((v) => (v as { strings?: readonly string[] })?.strings?.join('?') ?? '')
      .join('\n');
    expect(rendered).toContain(`->>'source' IS DISTINCT FROM 'auto'`);
    expect(rendered).toContain(`'minor' = ANY(m."lockedProperties")`);
  });

  it('returns null when no seed still carries the hash', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await expect(getAutoFlaggedMinorMatch({ modelId: 2186217 })).resolves.toBeNull();
  });

  it('returns the matched seed when one exists', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        minorModelId: 2176413,
        minorModelName: 'FIRE EMBLEM series3',
        minorModelVersionId: 2451000,
        minorModelDeletedAt: new Date('2025-12-02'),
        hash: 'B62D6EFF',
        modelVersionId: 2461616,
      },
    ]);

    await expect(getAutoFlaggedMinorMatch({ modelId: 2186217 })).resolves.toMatchObject({
      minorModelId: 2176413,
      hash: 'B62D6EFF',
    });
  });
});

describe('getAutoFlaggedMinorDetail', () => {
  it('resolves the seed before loading the shared detail for it', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { minorModelId: 2176413, hash: 'B62D6EFF', modelVersionId: 2461616 },
    ]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ minorModelStatus: 'Deleted' }]);

    const result = await getAutoFlaggedMinorDetail({ modelId: 2186217 });

    const [, ...detailValues] = mockDbRead.$queryRaw.mock.calls[1];
    expect(detailValues).toContain(2176413);
    expect(result.match?.minorModelId).toBe(2176413);
    expect(result.detail?.minorModelStatus).toBe('Deleted');
  });

  // Nothing to describe and no minorModelId to query with — issuing the detail
  // query anyway would join against model 0.
  it('skips the detail query when no seed resolves', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    const result = await getAutoFlaggedMinorDetail({ modelId: 2186217 });

    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ match: null, detail: null });
  });
});

// Same-uploader re-uploads usually follow a delete of the flagged original, so the
// deletion date is what makes the sequence legible; a bare status badge doesn't
// show that the copy went up the same day.
describe('getMinorHashMatchDetail', () => {
  it('reports when the matched model was deleted', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getMinorHashMatchDetail({ modelId: 2186217, minorModelId: 2176413 });

    const [strings] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('"minorModelDeletedAt"');
    expect(text).toContain('mm."deletedAt"');
  });
});

describe('confirmMinorHashAutoFlag', () => {
  it("records the moderator's own setMinor so a bulk rollback can no longer revert it", async () => {
    await confirmMinorHashAutoFlag({ modelId: 100, userId: 4 });

    expect(mockTrackModActivity).toHaveBeenCalledWith(4, {
      entityType: 'model',
      entityId: 100,
      activity: 'setMinor',
    });
    // sign-off must not re-run the flag itself
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  // The ModActivity row alone took the model out of the queue but left the
  // snapshot source='auto', which the seed predicate excludes — so an affirmed
  // minor model's hashes never matched anything afterwards.
  it("promotes the snapshot to source='manual' so the affirmed model seeds", async () => {
    await confirmMinorHashAutoFlag({ modelId: 100, userId: 4 });

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mockDbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('jsonb_set');
    expect(text).toContain(`'source', 'manual'`);
    // provenance survives the promotion
    expect(text).toContain(`'confirmedFrom'`);
    expect(values).toContain(100);
    expect(values).toContain(4);
  });

  // Without the COALESCE the second confirm reads the source it just promoted to
  // 'manual', so an automated flag stops looking automated to the owner alert.
  it('keeps the original confirmedFrom so a repeat confirm cannot erase the auto origin', async () => {
    await confirmMinorHashAutoFlag({ modelId: 100, userId: 4 });

    const [strings] = mockDbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toMatch(
      /'confirmedFrom',\s*COALESCE\(\s*m\.meta->\?->'confirmedFrom',\s*m\.meta->\?->'source'\s*\)/
    );
  });

  // Snapshot capture is best-effort, so a model can be flagged without one. The
  // promotion has to no-op there rather than write a snapshot with no pre-state.
  it('only promotes a model that actually has a snapshot', async () => {
    await confirmMinorHashAutoFlag({ modelId: 100, userId: 4 });

    const [strings] = mockDbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('WHERE m.id =');
    expect(text).toContain('AND m.meta ?');
  });
});

describe('revertMinorHashAutoFlag', () => {
  it('rolls back exactly that model and audits the revert', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow({ modelId: 77 })]);

    await revertMinorHashAutoFlag({ modelId: 77, userId: 4 });

    expect(mockSetModelMinor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 77, minor: false, activity: 'rollbackMinorAutoHash' })
    );
    expect(mockTrackModActivity).toHaveBeenCalledWith(4, {
      entityType: 'model',
      entityId: 77,
      activity: 'rollbackMinorAutoHash',
    });
  });
});

describe('dismissMinorHashMatch', () => {
  it('merges the dismissal into Model.meta and records the activity', async () => {
    await dismissMinorHashMatch({ modelId: 100, userId: 7 });

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings] = mockDbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('COALESCE(meta');
    expect(text).toContain('|| jsonb_build_object');
    expect(mockTrackModActivity).toHaveBeenCalledWith(7, {
      entityType: 'model',
      entityId: 100,
      activity: 'dismissMinorHashMatch',
    });
  });
});

function rollbackRow(
  overrides: Partial<{
    modelId: number;
    prevNsfw: boolean;
    prevSfwOnly: boolean;
    prevGalleryLevel: number | null;
    prevLockedProperties: string[];
    prevMinorImageIds: number[];
  }> = {}
) {
  return {
    modelId: 200,
    prevNsfw: false,
    prevSfwOnly: false,
    prevGalleryLevel: 31,
    prevLockedProperties: ['poi'],
    prevMinorImageIds: [123, 456],
    ...overrides,
  };
}

// rollbackMinorHashAutoFlags issues the confirmed-count query first, then the
// candidate window.
function mockRollbackQueries({
  rows,
  confirmedTotal = 0,
  confirmedIds = [],
}: {
  rows: ReturnType<typeof rollbackRow>[];
  confirmedTotal?: number;
  confirmedIds?: number[];
}) {
  mockDbRead.$queryRaw
    .mockResolvedValueOnce([{ total: confirmedTotal, ids: confirmedIds }])
    .mockResolvedValueOnce(rows);
}

describe('rollbackMinorHashAutoFlags', () => {
  it('unsets minor and restores nsfw, sfwOnly, gallery level, and lockedProperties', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow()]);

    const report = await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    expect(mockSetModelMinor).toHaveBeenCalledWith({
      id: 200,
      minor: false,
      userId: -1,
      activity: 'rollbackMinorAutoHash',
    });

    const restoreCall = mockDbWrite.$executeRaw.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('SET nsfw')
    );
    expect(restoreCall).toBeDefined();
    const [strings, ...values] = restoreCall!;
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('"sfwOnly"');
    expect(text).toContain('"gallerySettings"');
    expect(text).toContain('"lockedProperties"');
    expect(text).toContain(`meta = (COALESCE(meta, '{}'::jsonb) - `);
    expect(values).toContain(31); // prevGalleryLevel
    expect(values).toContainEqual(['poi']); // prevLockedProperties

    expect(report).toMatchObject({ candidates: 1, rolledBack: 1, skipped: 0, failed: 0 });
  });

  // Deleting the snapshot is what made a rollback forgettable: the model became an
  // ordinary candidate again and the next unattended run re-flagged it.
  it('stamps the model as cleared in the same write that drops the snapshot', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow({ modelId: 200 })]);

    await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    const restoreCall = mockDbWrite.$executeRaw.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('SET nsfw')
    );
    const [strings, ...values] = restoreCall!;
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('|| jsonb_build_object');
    expect(text).toContain(`jsonb_build_object('at', now())`);
    expect(values).toContain(MINOR_HASH_CLEARED_KEY);
  });

  it('re-marks prevMinorImageIds back to minor and queues them for search-index update', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow({ prevMinorImageIds: [123, 456] })]);

    await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    const imageCall = mockDbWrite.$executeRaw.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('UPDATE "Image"')
    );
    expect(imageCall).toBeDefined();
    const text = Array.from(imageCall![0] as TemplateStringsArray).join('?');
    expect(text).toContain('SET minor = true');

    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [123, 456],
      action: SearchIndexUpdateQueueAction.Update,
    });
  });

  it('does not touch images when prevMinorImageIds is empty', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow({ prevMinorImageIds: [] })]);

    await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    const imageCall = mockDbWrite.$executeRaw.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('UPDATE "Image"')
    );
    expect(imageCall).toBeUndefined();
    expect(mockQueueImageSearchIndexUpdate).not.toHaveBeenCalled();
  });

  it('reports human-confirmed flags as skipped without processing them', async () => {
    mockRollbackQueries({ rows: [], confirmedTotal: 3, confirmedIds: [201, 202, 203] });

    const report = await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(report).toMatchObject({ candidates: 0, rolledBack: 0, skipped: 3, failed: 0 });
    expect(report.sample).toEqual([
      { modelId: 201, outcome: 'skipped' },
      { modelId: 202, outcome: 'skipped' },
      { modelId: 203, outcome: 'skipped' },
    ]);
  });

  // Regression: confirmed rows keep their meta key forever, so leaving them in the
  // `ORDER BY id LIMIT n` window let them occupy slots on every call and stall the
  // drain once as many accumulated as the limit.
  it('excludes human-confirmed flags from the candidate window so the drain can progress', async () => {
    mockRollbackQueries({ rows: [], confirmedTotal: 1, confirmedIds: [201] });

    await rollbackMinorHashAutoFlags({ dryRun: true, limit: 100 });

    const [confirmedStrings] = mockDbRead.$queryRaw.mock.calls[0];
    const confirmedText = Array.from(confirmedStrings as TemplateStringsArray).join('?');
    expect(confirmedText).toContain('m.meta ? ');

    const [candidateStrings, ...candidateValues] = mockDbRead.$queryRaw.mock.calls[1];
    const candidateText = Array.from(candidateStrings as TemplateStringsArray).join('?');
    expect(candidateText).toContain('m.meta ? ');
    expect(candidateText).toContain('LIMIT ');
    // The scope is interpolated as a Prisma.Sql fragment, so it lands in values.
    const scopeText = candidateValues
      .map((v) => (v as { strings?: readonly string[] })?.strings?.join('?') ?? '')
      .join('\n');
    expect(scopeText).toContain('NOT ');
    expect(scopeText).toContain('"ModActivity" ma');
  });

  // A blanket rollback must never revert a moderator's deliberate "Set as Minor".
  it('scopes a bulk rollback to auto flags, excluding manual ones', async () => {
    mockRollbackQueries({ rows: [] });

    await rollbackMinorHashAutoFlags({ dryRun: true, limit: 100 });

    const rendered = mockDbRead.$queryRaw.mock.calls
      .flatMap((call) => call.slice(1))
      .map((v) => (v as { strings?: readonly string[] })?.strings?.join('?') ?? '')
      .join('\n');
    expect(rendered).toContain(`->>'source' IS DISTINCT FROM 'manual'`);
  });

  it('targets exact modelIds regardless of source, bypassing the human-confirmation skip', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([rollbackRow({ modelId: 77 })]);

    const report = await rollbackMinorHashAutoFlags({
      dryRun: true,
      limit: 100,
      modelIds: [77, 88],
    });

    // targeted mode issues only the candidate query - no confirmed-count query
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
    const [, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const rendered = values
      .map((v) => (v as { strings?: readonly string[] })?.strings?.join('?') ?? '')
      .join('\n');
    expect(rendered).toContain('m.id = ANY(');
    expect(rendered).not.toContain('IS DISTINCT FROM');
    expect(rendered).not.toContain('"ModActivity" ma');
    expect(report).toMatchObject({ candidates: 1, rolledBack: 1, skipped: 0 });
  });

  it('queries the human-confirmation gate against a later ModActivity setMinor row', async () => {
    mockRollbackQueries({ rows: [] });

    await rollbackMinorHashAutoFlags({ dryRun: true, limit: 100 });

    // The gate is interpolated as a Prisma.Sql fragment, so it lands in the call's
    // values rather than its template strings — render both.
    const renderValue = (value: unknown): string => {
      const fragment = value as { strings?: readonly string[] } | null;
      return fragment && Array.isArray(fragment.strings) ? fragment.strings.join('?') : '';
    };
    const gateText = mockDbRead.$queryRaw.mock.calls
      .flatMap((call) => [
        Array.from(call[0] as TemplateStringsArray).join('?'),
        ...call.slice(1).map(renderValue),
      ])
      .join('\n');
    expect(gateText).toContain('"ModActivity" ma');
    expect(gateText).toContain(`ma.activity = 'setMinor'`);
    expect(gateText).toContain('"createdAt" >');
    expect(gateText).toContain('m.meta ? ');
  });

  it('writes nothing on a dry run but reports the anticipated split', async () => {
    mockRollbackQueries({
      rows: [rollbackRow({ modelId: 200 })],
      confirmedTotal: 1,
      confirmedIds: [201],
    });

    const report = await rollbackMinorHashAutoFlags({ dryRun: true, limit: 100 });

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockQueueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(report).toMatchObject({ candidates: 1, rolledBack: 1, skipped: 1, failed: 0 });
    expect(report.sample).toEqual([
      { modelId: 200, outcome: 'rolledBack' },
      { modelId: 201, outcome: 'skipped' },
    ]);
  });

  it('reports a per-model failure without aborting the batch', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      rollbackRow({ modelId: 200 }),
      rollbackRow({ modelId: 201 }),
    ]);
    mockSetModelMinor.mockRejectedValueOnce(new Error('boom'));

    const report = await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    expect(report).toMatchObject({ candidates: 2, rolledBack: 1, skipped: 0, failed: 1 });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'minor-hash-rollback',
        message: 'boom',
        modelId: 200,
      }),
      'webhooks'
    );
  });

  it('does not abort the batch when setModelMinor rejects with a non-Error value', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow({ modelId: 200 })]);
    mockSetModelMinor.mockRejectedValueOnce(null);

    const report = await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    expect(report).toMatchObject({ rolledBack: 0, failed: 1 });
  });

  it('caps the sample at 20 rows', async () => {
    const many = Array.from({ length: 30 }, (_, i) => rollbackRow({ modelId: i }));
    mockDbRead.$queryRaw.mockResolvedValue(many);

    const report = await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    expect(report.sample).toHaveLength(20);
  });

  it('logs the report on a real run so a timeout cannot lose it', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow()]);

    await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'minor-hash-rollback',
        message: 'rollback complete',
        candidates: 1,
        rolledBack: 1,
        skipped: 0,
        failed: 0,
      }),
      'webhooks'
    );
  });

  it('does not log a dry run', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow()]);

    await rollbackMinorHashAutoFlags({ dryRun: true, limit: 100 });

    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });
});
