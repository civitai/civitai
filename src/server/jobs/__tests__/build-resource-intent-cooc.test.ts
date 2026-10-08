import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as Job from '~/server/jobs/job';
import type * as Heartbeat from '~/server/services/resource-intent-cooc/heartbeat';
import type * as Pipeline from '~/server/services/resource-intent-cooc/pipeline';

const { mockIsFlipt, mockBuild, mockSweep } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockBuild: vi.fn(),
  mockSweep: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/resource-intent-cooc/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof Pipeline>()),
  buildCoocSnapshot: mockBuild,
}));
vi.mock('~/server/services/resource-intent-cooc/heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof Heartbeat>()),
  runCoocRetentionSweep: mockSweep,
}));
vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof Job>()),
  createJob: (
    name: string,
    cron: string,
    fn: (e: unknown) => Promise<unknown>,
    options: unknown
  ) => ({
    name,
    cron,
    options,
    run: () => fn(undefined),
  }),
}));

import {
  buildResourceIntentCoocJob,
  resourceIntentCoocRetentionJob,
} from '~/server/jobs/build-resource-intent-cooc';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';

const run = (job: unknown) => (job as { run: () => Promise<unknown> }).run();

describe('build-resource-intent-cooc job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuild.mockResolvedValue({ contentHash: 'h' });
    mockSweep.mockResolvedValue({ deleted: 0, tableMissing: false });
  });

  it('is skipped while its flag is off, and builds nothing', async () => {
    mockIsFlipt.mockResolvedValue(false);
    expect(await run(buildResourceIntentCoocJob)).toEqual({ skipped: 'flag off' });
    expect(mockIsFlipt).toHaveBeenCalledWith(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_COOC_BUILD);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('with the flag on, always writes production, unpinned, not backdated, not a dry run', async () => {
    mockIsFlipt.mockResolvedValue(true);
    await run(buildResourceIntentCoocJob);
    expect(mockBuild).toHaveBeenCalledTimes(1);
    const opts = mockBuild.mock.calls[0][0];
    expect(opts).toEqual({ kind: 'production', seed: 20261008, pinnedUntil: null, dryRun: false });
  });

  it('runs weekly with a 90-minute lock held across a scheduler disconnect', () => {
    const job = buildResourceIntentCoocJob as unknown as {
      cron: string;
      options: Record<string, unknown>;
    };
    expect(job.cron).toBe('0 5 * * 2');
    expect(job.options).toEqual({ lockExpiration: 90 * 60, keepLockOnDisconnect: true });
  });

  it('the build flag defaults to off: it is a Flipt flag, so an unknown key evaluates false', () => {
    expect(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_COOC_BUILD).toBe('resource-intent-cooc-build');
  });
});

describe('resource-intent-cooc-retention job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSweep.mockResolvedValue({ deleted: 2, tableMissing: false });
  });

  it('sweeps daily with the build flag OFF (it never reads the flag)', async () => {
    mockIsFlipt.mockResolvedValue(false);
    expect(await run(resourceIntentCoocRetentionJob)).toEqual({ deleted: 2, tableMissing: false });
    expect(mockSweep).toHaveBeenCalledTimes(1);
    const [sql, kv, now] = mockSweep.mock.calls[0];
    expect(kv).toBe(dbMock.dbWrite);
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([] as never);
    await sql.query(Prisma.sql`SELECT 1`);
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(Math.abs(Date.now() - (now as Date).getTime())).toBeLessThan(10_000);
    expect(mockIsFlipt).not.toHaveBeenCalled();
    expect((resourceIntentCoocRetentionJob as unknown as { cron: string }).cron).toBe('30 4 * * *');
  });

  it('both jobs are registered with the scheduler', () => {
    const route = readFileSync(
      join(process.cwd(), 'src/pages/api/webhooks/run-jobs/[[...run]].ts'),
      'utf8'
    );
    const list = route.slice(route.indexOf('export const jobs: Job[] = ['));
    expect(list).toMatch(/\n\s+buildResourceIntentCoocJob,\n/);
    expect(list).toMatch(/\n\s+resourceIntentCoocRetentionJob,\n/);
  });
});
