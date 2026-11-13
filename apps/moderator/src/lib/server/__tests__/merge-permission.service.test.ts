import { describe, expect, it, vi } from 'vitest';
import { MERGE_PERMISSION_REPORT_REASON } from '@civitai/shared/merge-permission';

vi.mock('../db', () => ({ dbRead: {} }));

const { buildMergePermissionChecks, mergeReportSource } = await import(
  '../merge-permission.service'
);

// Distinct so a value reaching the wrong place cannot pass by colliding with the right one.
const REPORT = 1001;
const MERGE = 71;
const OTHER_MERGE = 72;
const SOURCE = 115;
const d = (iso: string) => new Date(iso);

const mergeReport = {
  id: REPORT,
  entityId: MERGE,
  details: { reason: MERGE_PERMISSION_REPORT_REASON, sourceModelId: SOURCE },
};
// The reporter's complaint: merges were allowed, then switched off on 1 Sep.
const source = {
  id: SOURCE,
  name: 'Source LoRA',
  createdAt: d('2025-01-01T00:00:00Z'),
  allowDerivatives: false,
};
const snapshots = [
  { modelId: SOURCE, effectiveAt: d('2026-07-30T00:00:00Z'), allowDerivatives: true },
  { modelId: SOURCE, effectiveAt: d('2026-09-01T00:00:00Z'), allowDerivatives: false },
];
const version = (
  id: number,
  modelId: number,
  publishedAt: string | null,
  createdAt = '2026-06-01T00:00:00Z'
) => ({
  id,
  modelId,
  name: `v${id}`,
  createdAt: d(createdAt),
  publishedAt: publishedAt ? d(publishedAt) : null,
});

describe('buildMergePermissionChecks', () => {
  const check = (versions: ReturnType<typeof version>[]) =>
    buildMergePermissionChecks({ reports: [mergeReport], sources: [source], snapshots, versions })[
      REPORT
    ];

  it('judges each merge version by the permission when it was published, not today', () => {
    const result = check([
      version(1, MERGE, '2026-08-15T00:00:00Z'),
      version(2, MERGE, '2026-09-10T00:00:00Z'),
      version(3, MERGE, '2026-07-01T00:00:00Z'),
    ]);
    expect(result.versions.map((v) => [v.id, v.verdict.status])).toEqual([
      [3, 'unknown'],
      [1, 'allowed'],
      [2, 'not-allowed'],
    ]);
  });

  it('falls back to creation for a version never published', () => {
    const result = check([version(4, MERGE, null, '2026-08-20T00:00:00Z')]);
    expect(result.versions[0]).toMatchObject({
      madeAt: d('2026-08-20T00:00:00Z'),
      verdict: { status: 'allowed' },
    });
  });

  it("only the reported merge's versions, and the source's own history", () => {
    const result = check([
      version(1, MERGE, '2026-08-15T00:00:00Z'),
      version(9, OTHER_MERGE, '2026-08-15T00:00:00Z'),
    ]);
    expect(result.versions.map((v) => v.id)).toEqual([1]);
    expect(result.timeline.map((t) => t.allowDerivatives)).toEqual([true, false]);
  });

  it('says so when the source model is gone', () => {
    const result = buildMergePermissionChecks({
      reports: [mergeReport],
      sources: [],
      snapshots,
      versions: [version(1, MERGE, '2026-08-15T00:00:00Z')],
    })[REPORT];
    expect(result).toMatchObject({ sourceModelId: SOURCE, source: null, versions: [] });
  });

  it('control: an ordinary AdminAttention report gets no check', () => {
    expect(
      buildMergePermissionChecks({
        reports: [{ ...mergeReport, details: { reason: 'Other concern', sourceModelId: SOURCE } }],
        sources: [source],
        snapshots,
        versions: [version(1, MERGE, '2026-08-15T00:00:00Z')],
      })
    ).toEqual({});
  });
});

describe('mergeReportSource', () => {
  it('reads the source of a merge-permission report only', () => {
    expect(
      mergeReportSource({ reason: MERGE_PERMISSION_REPORT_REASON, sourceModelId: SOURCE })
    ).toBe(SOURCE);
    expect(
      mergeReportSource({ reason: MERGE_PERMISSION_REPORT_REASON, sourceModelId: '115' })
    ).toBeUndefined();
    expect(mergeReportSource(null)).toBeUndefined();
  });
});
