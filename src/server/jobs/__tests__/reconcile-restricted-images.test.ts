import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';

const executeRaw = dbMock.dbWrite.$executeRaw;
const queryRaw = dbMock.dbWrite.$queryRaw;

import { reconcileRestrictedImages } from '~/server/jobs/reconcile-restricted-images';
import {
  restrictedBaseModelDivergenceGauge,
  restrictedImageDriftGauge,
  restrictedImageReconcileLastSuccessGauge,
} from '~/server/prom/client';

// The eight rows on prod as of 2026-08-24. `SVD XT` and `Ideogram 4.0` are in
// `nsfwRestrictedBaseModels` and absent here, which is the divergence that left
// 1,821 images unflagged (ClickUp 868kv4yn2).
const PROD_TABLE_ROWS = [
  'SD 3',
  'SD 3.5',
  'SD 3.5 Large',
  'SD 3.5 Large Turbo',
  'SD 3.5 Medium',
  'SDXL Turbo',
  'SVD',
  'Stable Cascade',
].map((baseModel) => ({ baseModel }));

const sqlOf = (call: unknown[]) => (call[0] as string[]).join('');
const isVersionQuery = (call: unknown[]) => sqlOf(call).includes('"ModelVersion"');

let versionIds: number[] = [1, 2, 3];
let tableRows = PROD_TABLE_ROWS;

const run = () =>
  reconcileRestrictedImages.run({}).result as Promise<{
    flagged: number;
    missingInDb: string[];
    missingInCode: string[];
    versions: number;
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  versionIds = [1, 2, 3];
  tableRows = PROD_TABLE_ROWS;
  executeRaw.mockResolvedValue(0);
  queryRaw.mockImplementation((...call: unknown[]) =>
    Promise.resolve(isVersionQuery(call) ? versionIds.map((id) => ({ id })) : tableRows)
  );
});

describe('reconcile-restricted-images', () => {
  it('runs hourly', () => {
    expect(reconcileRestrictedImages.cron).toBe('0 * * * *');
  });

  it('names the base models the code list has and the table does not', async () => {
    const result = await run();

    expect(result.missingInDb).toEqual(['SVD XT', 'Ideogram 4.0']);
    expect(result.missingInCode).toEqual([]);
    expect(restrictedBaseModelDivergenceGauge.set).toHaveBeenCalledWith(
      { direction: 'missing_in_db' },
      2
    );
  });

  it('names the base models the table has and the code list does not', async () => {
    tableRows = [...PROD_TABLE_ROWS, { baseModel: 'Retired Model' }];

    const result = await run();

    expect(result.missingInCode).toEqual(['Retired Model']);
    expect(restrictedBaseModelDivergenceGauge.set).toHaveBeenCalledWith(
      { direction: 'missing_in_code' },
      1
    );
  });

  it('reports zero divergence when the two lists agree', async () => {
    tableRows = nsfwRestrictedBaseModels.map((baseModel) => ({ baseModel }));

    const result = await run();

    expect(result.missingInDb).toEqual([]);
    expect(result.missingInCode).toEqual([]);
  });

  it('publishes the flagged count and a heartbeat, so a zero from a job that never ran is distinguishable', async () => {
    executeRaw.mockResolvedValue(6326);
    const before = Math.floor(Date.now() / 1000);

    const result = await run();

    expect(result.flagged).toBe(6326);
    expect(restrictedImageDriftGauge.set).toHaveBeenCalledWith(6326);

    const heartbeat = vi.mocked(restrictedImageReconcileLastSuccessGauge.set).mock.calls[0][0];
    expect(heartbeat).toBeGreaterThanOrEqual(before);
  });

  // DELIBERATE, DO NOT RELAX: this job may set `modelRestricted` and must never
  // clear it. Un-hiding restores content to public feeds, which is a moderation
  // decision rather than a reconciliation, and the reverse direction was
  // explicitly left un-automated (Justin, 2026-08-22). If you are here because
  // you want the job to un-hide, that is a product decision to raise, not an
  // assertion to delete.
  it('hide-only: it sets the flag true and never writes false', async () => {
    await run();

    const sql = sqlOf(executeRaw.mock.calls[0]);

    expect(sql).toMatch(/SET\s+"modelRestricted"\s*=\s*true/i);
    expect(sql).not.toMatch(/=\s*false/i);
    expect(sql).toMatch(/"modelRestricted"\s+IS DISTINCT FROM true/i);
  });

  it('reconciles against the table, not the code list', async () => {
    await run();

    expect(sqlOf(executeRaw.mock.calls[0])).not.toContain('RestrictedBaseModels');
    const versionQuery = queryRaw.mock.calls.find(isVersionQuery);
    expect(versionQuery && sqlOf(versionQuery)).toContain('"RestrictedBaseModels"');
    for (const baseModel of nsfwRestrictedBaseModels) {
      expect(sqlOf(executeRaw.mock.calls[0])).not.toContain(baseModel);
    }
  });

  // DELIBERATE, DO NOT UNCHUNK: the whole-table anti-join measured 22.4 s, then
  // 57.3 s, then twice past the measuring path's own ~60 s ceiling, on the same
  // replica inside one hour (2026-08-24) — against a 2 min statement_timeout. One
  // statement per 100 versions is what keeps this job from silently failing on a
  // busy day. Widening the chunk trades that back.
  it('chunks the update by model version rather than issuing one whole-table statement', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);

    await run();

    expect(executeRaw).toHaveBeenCalledTimes(3);
  });

  it('stops between chunks when the job is canceled', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    const job = reconcileRestrictedImages.run({});
    executeRaw.mockImplementation(async () => {
      await job.cancel();
      return 1;
    });

    await expect(job.result).rejects.toThrow('Job has ended');
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
