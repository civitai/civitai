import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Constants from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';

const executeRaw = dbMock.dbWrite.$executeRaw;
const queryRaw = dbMock.dbWrite.$queryRaw;

import { reconcileRestrictedImages } from '~/server/jobs/reconcile-restricted-images';
import {
  restrictedBaseModelDivergenceGauge,
  restrictedImageDriftGauge,
  restrictedImageOverhiddenGauge,
  restrictedImageReconcileLastSuccessGauge,
} from '~/server/prom/client';

// Synthetic, deliberately NOT the real prod rows and NOT the real code list. The
// divergence is a set difference, and a fixture snapshotting production would go red
// the moment a licence is added in code — greenable only by a production DB write,
// which is the wrong-direction guard this job's gauge exists to avoid.
const { CODE_LIST } = vi.hoisted(() => ({ CODE_LIST: ['Alpha', 'Beta', 'Gamma'] }));
const TABLE_ROWS = ['Alpha', 'Beta'].map((baseModel) => ({ baseModel }));

vi.mock('~/server/common/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof Constants>()),
  nsfwRestrictedBaseModels: CODE_LIST,
}));

const sqlOf = (call: unknown[]) => (call[0] as string[]).join('');
const valuesOf = (call: unknown[]) =>
  call.slice(1).flatMap((v) => ((v as Prisma.Sql)?.values ?? [v]) as unknown[]);
// Both the version query and the over-hidden count name `ModelVersion`, so the
// narrower test has to be asked first.
const isOverhiddenQuery = (call: unknown[]) => sqlOf(call).includes('NOT EXISTS');
const isVersionQuery = (call: unknown[]) =>
  !isOverhiddenQuery(call) && sqlOf(call).includes('"ModelVersion"');

let versionIds: number[] = [1, 2, 3];
let tableRows = TABLE_ROWS;
let overhidden = 0;

const run = () =>
  reconcileRestrictedImages.run({}).result as Promise<{
    flagged: number;
    overhidden: number;
    missingInDb: string[];
    missingInCode: string[];
    versions: number;
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  versionIds = [1, 2, 3];
  tableRows = TABLE_ROWS;
  overhidden = 0;
  executeRaw.mockResolvedValue(0);
  queryRaw.mockImplementation((...call: unknown[]) => {
    if (isOverhiddenQuery(call)) return Promise.resolve([{ count: BigInt(overhidden) }]);
    if (isVersionQuery(call)) return Promise.resolve(versionIds.map((id) => ({ id })));
    return Promise.resolve(tableRows);
  });
});

describe('reconcile-restricted-images', () => {
  it('runs hourly', () => {
    expect(reconcileRestrictedImages.cron).toBe('0 * * * *');
  });

  it('names the base models the code list has and the table does not', async () => {
    const result = await run();

    expect(result.missingInDb).toEqual(['Gamma']);
    expect(result.missingInCode).toEqual([]);
    expect(restrictedBaseModelDivergenceGauge.set).toHaveBeenCalledWith(
      { direction: 'missing_in_db' },
      1
    );
  });

  it('names the base models the table has and the code list does not', async () => {
    tableRows = [...TABLE_ROWS, { baseModel: 'Retired' }];

    const result = await run();

    expect(result.missingInCode).toEqual(['Retired']);
    expect(restrictedBaseModelDivergenceGauge.set).toHaveBeenCalledWith(
      { direction: 'missing_in_code' },
      1
    );
  });

  it('publishes zero divergence when the lists agree, so a fixed divergence clears', async () => {
    tableRows = CODE_LIST.map((baseModel) => ({ baseModel }));

    const result = await run();

    expect(result.missingInDb).toEqual([]);
    expect(restrictedBaseModelDivergenceGauge.set).toHaveBeenCalledWith(
      { direction: 'missing_in_db' },
      0
    );
    expect(restrictedBaseModelDivergenceGauge.set).toHaveBeenCalledWith(
      { direction: 'missing_in_code' },
      0
    );
  });

  // DELIBERATE: the divergence read is sequenced BEFORE the chunk loop. A labelled
  // gauge that is never set does not scrape at all, so a chunk hitting
  // statement_timeout would otherwise take the divergence signal down with it — going
  // silent in exactly the state the alert exists to report.
  it('publishes divergence even when the chunk loop fails', async () => {
    executeRaw.mockRejectedValue(new Error('statement timeout'));

    await expect(run()).rejects.toThrow('statement timeout');

    expect(restrictedBaseModelDivergenceGauge.set).toHaveBeenCalledWith(
      { direction: 'missing_in_db' },
      1
    );
    expect(restrictedImageDriftGauge.set).not.toHaveBeenCalled();
    expect(restrictedImageReconcileLastSuccessGauge.set).not.toHaveBeenCalled();
  });

  it('publishes the flagged count and a heartbeat, so a zero from a job that never ran is distinguishable', async () => {
    executeRaw.mockResolvedValue(6326);
    const before = Math.floor(Date.now() / 1000);

    const result = await run();

    expect(result.flagged).toBe(6326);
    expect(restrictedImageDriftGauge.set).toHaveBeenCalledWith(6326);

    // Once, and in seconds. Milliseconds would put the heartbeat ~52,000 years ahead
    // and no staleness alert could ever fire; a heartbeat set on entry rather than on
    // completion would report a failing job as live.
    expect(restrictedImageReconcileLastSuccessGauge.set).toHaveBeenCalledTimes(1);
    const heartbeat = vi.mocked(restrictedImageReconcileLastSuccessGauge.set).mock.calls[0][0];
    expect(heartbeat).toBeGreaterThanOrEqual(before);
    expect(heartbeat).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  it('sums the flagged count across every chunk', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    executeRaw.mockResolvedValue(1);

    const result = await run();

    expect(result.flagged).toBe(3);
  });

  it('reports the over-hidden count without acting on it', async () => {
    overhidden = 563;

    const result = await run();

    expect(result.overhidden).toBe(563);
    expect(restrictedImageOverhiddenGauge.set).toHaveBeenCalledWith(563);
    for (const call of executeRaw.mock.calls) expect(sqlOf(call)).not.toMatch(/NOT EXISTS/i);
  });

  // DELIBERATE, DO NOT RELAX: this job may set `modelRestricted` and must never
  // clear it. Un-hiding restores content to public feeds, which is a moderation
  // decision rather than a reconciliation, and the reverse direction was explicitly
  // left un-automated (Justin, 2026-08-22). If you are here because you want the job
  // to un-hide, that is a product decision to raise, not an assertion to delete.
  it('hide-only: every statement sets the flag true, none writes false', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);

    await run();

    expect(executeRaw.mock.calls.length).toBeGreaterThan(0);
    for (const call of executeRaw.mock.calls) {
      expect(sqlOf(call)).toMatch(/SET\s+"modelRestricted"\s*=\s*true/i);
      expect(sqlOf(call)).not.toMatch(/=\s*false/i);
      // The values half too: `SET "modelRestricted" = ${x}` would pass a text-only
      // assertion, because joining a tagged template's static strings drops every
      // interpolated value.
      expect(valuesOf(call)).not.toContain(false);
    }
    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('reconciles against the table, not the code list', async () => {
    await run();

    const versionQuery = queryRaw.mock.calls.find(isVersionQuery);
    expect(versionQuery && sqlOf(versionQuery)).toContain('"RestrictedBaseModels"');
    for (const call of executeRaw.mock.calls) {
      expect(sqlOf(call)).not.toContain('RestrictedBaseModels');
      for (const baseModel of CODE_LIST) {
        expect(sqlOf(call)).not.toContain(baseModel);
        expect(valuesOf(call)).not.toContain(baseModel);
      }
    }
  });

  // DELIBERATE, DO NOT UNCHUNK: the whole-table anti-join measured 22.4 s, then
  // 57.3 s, then twice past the measuring path's own ~60 s ceiling, on the same
  // replica inside one hour (2026-08-24) — against a 2 min statement_timeout.
  // Unchunked, the planner switches to a parallel seq scan of ImageResourceNew:
  // 440M rows, ~19 GB, 23.8 s. Widening the chunk trades both back.
  it('chunks the update by model version, covering every version exactly once', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);

    await run();

    expect(executeRaw).toHaveBeenCalledTimes(3);

    // The parameters, not the statement text. Every assertion in an earlier draft read
    // only the static strings, so slicing the id list down to one version per chunk
    // passed the whole file while flagging a fraction of what it should.
    const sent = executeRaw.mock.calls.map(valuesOf);
    expect(sent.flat()).toEqual(versionIds);
    expect(sent.map((ids) => ids.length)).toEqual([100, 100, 50]);
  });

  it('stops between chunks when the job is canceled, and publishes no success', async () => {
    versionIds = Array.from({ length: 250 }, (_, i) => i + 1);
    const job = reconcileRestrictedImages.run({});
    executeRaw.mockImplementation(async () => {
      await job.cancel();
      return 1;
    });

    await expect(job.result).rejects.toThrow('Job has ended');
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(restrictedImageReconcileLastSuccessGauge.set).not.toHaveBeenCalled();
    expect(restrictedImageDriftGauge.set).not.toHaveBeenCalled();
  });

  // `Prisma.join([])` throws, so a chunking rewrite that yields a trailing empty chunk
  // would turn an empty restricted list into a job that fails every hour.
  it('issues no statement when nothing is restricted', async () => {
    versionIds = [];
    tableRows = [];

    const result = await run();

    expect(executeRaw).not.toHaveBeenCalled();
    expect(result.flagged).toBe(0);
    expect(restrictedImageReconcileLastSuccessGauge.set).toHaveBeenCalledTimes(1);
  });

  it('logs drift for an operator, and stays quiet when there is none', async () => {
    executeRaw.mockResolvedValue(4);

    await run();

    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'reconcile-restricted-images', flagged: 4 }),
      'webhooks'
    );

    vi.clearAllMocks();
    executeRaw.mockResolvedValue(0);
    tableRows = CODE_LIST.map((baseModel) => ({ baseModel }));

    await run();

    expect(logToAxiom).not.toHaveBeenCalled();
  });
});
