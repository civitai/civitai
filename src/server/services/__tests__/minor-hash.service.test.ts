import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
}));

const { mockSetModelMinor, mockTrackModActivity, mockLogToAxiom } = vi.hoisted(() => ({
  mockSetModelMinor: vi.fn(),
  mockTrackModActivity: vi.fn(),
  mockLogToAxiom: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/model.service', () => ({ setModelMinor: mockSetModelMinor }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: mockTrackModActivity }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

import {
  findMinorHashMatches,
  applyMinorHashMatch,
  checkMinorHashOnScan,
  sweepMinorHashMatches,
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

  it('queries with the SHA256 + lockedProperties gate', async () => {
    await findMinorHashMatches('ABC123');

    // $queryRaw is called as a tagged template, so the mock receives
    // (TemplateStringsArray, ...substitutions) — not a single Sql object.
    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain(`'SHA256'`);
    expect(text).toContain(`'minor' = ANY(m."lockedProperties")`);
    expect(text).toContain(`mf.type = 'Model'`);
    expect(values).toContain('ABC123');
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

describe('checkMinorHashOnScan', () => {
  it('flags a same-uploader match end to end', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 50, userId: 5 }]);

    const result = await checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' });

    expect(result).toBe('flagged');
    expect(mockSetModelMinor).toHaveBeenCalledTimes(1);
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

    await expect(
      checkMinorHashOnScan({ modelId: 100, userId: 5, sha256: 'ABC' })
    ).resolves.toBe('skipped');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'null', modelId: 100, userId: 5, sha256: 'ABC' }),
      'webhooks'
    );
  });
});

const sweepRows = [
  { modelId: 101, userId: 5, sameUploader: true },
  { modelId: 102, userId: 6, sameUploader: true },
  { modelId: 103, userId: 7, sameUploader: false },
];

describe('sweepMinorHashMatches', () => {
  it('writes nothing on a dry run but reports the split', async () => {
    mockDbRead.$queryRaw.mockResolvedValue(sweepRows);

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

  it('flags only the same-uploader candidates when applying', async () => {
    mockDbRead.$queryRaw.mockResolvedValue(sweepRows);

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
    mockDbRead.$queryRaw.mockResolvedValue(sweepRows);
    mockSetModelMinor.mockRejectedValueOnce(new Error('boom'));

    const report = await sweepMinorHashMatches({ dryRun: false, limit: 100 });

    expect(report).toMatchObject({ flagged: 1, failed: 1 });
    expect(mockLogToAxiom).toHaveBeenCalled();
  });
});
