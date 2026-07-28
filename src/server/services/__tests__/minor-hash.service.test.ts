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
vi.mock('~/server/services/model.service', () => ({ setModelMinor: mockSetModelMinor }));
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
  captureMinorHashAutoFlagState,
  rollbackMinorHashAutoFlags,
  minorSrcCte,
  minorHashCandidatesCte,
  MINOR_HASH_FILE_TYPE,
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
    expect(text).toContain(`'SHA256'`);
    expect(text).toContain('m.minor');
    expect(text).toContain(`'minor' = ANY(m."lockedProperties")`);
    expect(text).toContain('mf.type =');
    expect(values).toContain(MINOR_HASH_FILE_TYPE);
    expect(values).toContain('ABC123');
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
    const result = await applyMinorHashMatch({ modelId: 100, userId: 5, matches: [] });

    expect(result).toBe('skipped');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it('skips when the candidate is itself in the seed set', async () => {
    const result = await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      matches: [
        { modelId: 100, userId: 5 },
        { modelId: 50, userId: 5 },
      ],
    });

    expect(result).toBe('skipped');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });
});

describe('captureMinorHashAutoFlagState', () => {
  it('guards against overwriting an existing capture', async () => {
    await captureMinorHashAutoFlagState(100);

    const [strings] = mockDbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain(`NOT (COALESCE(m.meta, '{}'::jsonb) ? 'minorHashAutoFlag')`);
  });

  it('merges into meta via || rather than overwriting the column', async () => {
    await captureMinorHashAutoFlagState(100);

    const [strings] = mockDbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('COALESCE(m.meta');
    expect(text).toContain('||');
    expect(text).toContain(`'minorHashAutoFlag'`);
  });

  it('derives prevMinorImageIds via the ModelVersion -> Post -> Image join', async () => {
    await captureMinorHashAutoFlagState(100);

    const [strings] = mockDbWrite.$executeRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('"ModelVersion" mv');
    expect(text).toContain('"Post" p');
    expect(text).toContain('"Image" i');
    expect(text).toContain('i.minor');
  });

  it('swallows a write failure and logs instead of throwing', async () => {
    mockDbWrite.$executeRaw.mockRejectedValueOnce(new Error('db exploded'));

    await expect(captureMinorHashAutoFlagState(100)).resolves.toBeUndefined();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'minor-hash-capture', modelId: 100 }),
      'webhooks'
    );
  });
});

describe('applyMinorHashMatch — pre-state capture', () => {
  it('captures pre-state before flagging', async () => {
    await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      matches: [{ modelId: 50, userId: 5 }],
    });

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    const captureOrder = mockDbWrite.$executeRaw.mock.invocationCallOrder[0];
    const flagOrder = mockSetModelMinor.mock.invocationCallOrder[0];
    expect(captureOrder).toBeLessThan(flagOrder);
  });

  it('does not capture when the outcome is only queued', async () => {
    await applyMinorHashMatch({
      modelId: 100,
      userId: 5,
      matches: [{ modelId: 50, userId: 9 }],
    });

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });
});

describe('checkMinorHashOnScan', () => {
  it('flags a same-uploader match end to end', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 5 }]);

    const result = await checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' });

    expect(result).toBe('flagged');
    expect(mockSetModelMinor).toHaveBeenCalledTimes(1);
  });

  it('logs auto-flags so they are countable without querying ModActivity', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 5 }]);

    await checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'minor-hash-scan-check', message: 'flagged', modelId: 100 }),
      'webhooks'
    );
  });

  it('does not log when the outcome is only queued', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 9 }]);

    const result = await checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' });

    expect(result).toBe('queued');
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('swallows and logs a lookup failure instead of throwing', async () => {
    mockDbRead.$queryRaw.mockRejectedValue(new Error('db exploded'));

    const result = await checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' });

    expect(result).toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalled();
  });

  it('swallows a setModelMinor failure instead of throwing', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 5 }]);
    mockSetModelMinor.mockRejectedValue(new Error('update failed'));

    const result = await checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' });

    expect(result).toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalled();
  });

  it('swallows a non-Error throw (a rejected string) and logs a readable message', async () => {
    mockDbRead.$queryRaw.mockRejectedValue('db exploded');

    const result = await checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' });

    expect(result).toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'db exploded', modelId: 100, userId: 5, sha256: 'ABC' }),
      'webhooks'
    );
  });

  it('does not throw when the rejection value is null (property access on a non-Error cast)', async () => {
    mockDbRead.$queryRaw.mockRejectedValue(null);

    await expect(checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' })).resolves.toBe(
      'skipped'
    );
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

  it('captures pre-state for every flagged row before setModelMinor', async () => {
    mockSweepQueries();

    await sweepMinorHashMatches({ dryRun: false, limit: 100 });

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(sweepRows.length);
  });

  it('does not capture pre-state on a dry run', async () => {
    mockSweepQueries();

    await sweepMinorHashMatches({ dryRun: true, limit: 100 });

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('getMinorHashMatchesForReview', () => {
  it('excludes dismissed models and paginates', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await getMinorHashMatchesForReview({ page: 3, limit: 25 });

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain(`NOT (m.meta ? 'minorHashDismissed')`);
    expect(text).toContain('WHERE NOT c."sameUploader"');
    expect(text).toContain('bool_or(EXISTS (');
    expect(text).toContain(`s2."userId" <> c."userId"`);
    expect(values).toContain(25); // limit
    expect(values).toContain(50); // offset = (page - 1) * limit
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
    humanConfirmed: boolean;
  }> = {}
) {
  return {
    modelId: 200,
    prevNsfw: false,
    prevSfwOnly: false,
    prevGalleryLevel: 31,
    prevLockedProperties: ['poi'],
    prevMinorImageIds: [123, 456],
    humanConfirmed: false,
    ...overrides,
  };
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
    expect(text).toContain(`meta = COALESCE(meta, '{}'::jsonb) - 'minorHashAutoFlag'`);
    expect(values).toContain(31); // prevGalleryLevel
    expect(values).toContainEqual(['poi']); // prevLockedProperties

    expect(report).toMatchObject({ candidates: 1, rolledBack: 1, skipped: 0, failed: 0 });
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

  it('skips a model with a later human setMinor confirmation', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([rollbackRow({ humanConfirmed: true })]);

    const report = await rollbackMinorHashAutoFlags({ dryRun: false, limit: 100 });

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(report).toMatchObject({ candidates: 1, rolledBack: 0, skipped: 1, failed: 0 });
  });

  it('queries the human-confirmation gate against a later ModActivity setMinor row', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await rollbackMinorHashAutoFlags({ dryRun: true, limit: 100 });

    const [strings] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain('"ModActivity" ma');
    expect(text).toContain(`ma.activity = 'setMinor'`);
    expect(text).toContain('"createdAt" >');
    expect(text).toContain(`m.meta ? 'minorHashAutoFlag'`);
  });

  it('writes nothing on a dry run but reports the anticipated split', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      rollbackRow({ modelId: 200, humanConfirmed: false }),
      rollbackRow({ modelId: 201, humanConfirmed: true }),
    ]);

    const report = await rollbackMinorHashAutoFlags({ dryRun: true, limit: 100 });

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockQueueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(report).toMatchObject({ candidates: 2, rolledBack: 1, skipped: 1, failed: 0 });
    expect(report.sample).toHaveLength(2);
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
