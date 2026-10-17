import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as Job from '~/server/jobs/job';
import type * as Pipeline from '~/server/services/resource-intent-tags/pipeline';

const { mockIsFlipt, mockBuild } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockBuild: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/resource-intent-tags/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof Pipeline>()),
  runTagIndexBuild: mockBuild,
}));
vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof Job>()),
  createJob: (
    name: string,
    cron: string,
    fn: (e: unknown) => Promise<unknown>,
    options: unknown
  ) => ({ name, cron, options, run: () => fn(undefined) }),
}));

import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { buildResourceIntentTagIndexJob } from '~/server/jobs/build-resource-intent-tag-index';
import { jobsArrayEntries } from './run-jobs-array';

const run = () =>
  (buildResourceIntentTagIndexJob as unknown as { run: () => Promise<unknown> }).run();

describe('build-resource-intent-tag-index job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuild.mockResolvedValue({
      summary: { vocabVersion: 'v', created: true },
      payload: Buffer.from('x'),
    });
  });

  it('is skipped while its flag is off, and builds nothing', async () => {
    mockIsFlipt.mockResolvedValue(false);
    expect(await run()).toEqual({ skipped: 'flag off' });
    expect(mockIsFlipt).toHaveBeenCalledWith(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_BUILD);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('with the flag on, runs a production (not dry) build on the app env and returns only the summary', async () => {
    mockIsFlipt.mockResolvedValue(true);
    expect(await run()).toEqual({ vocabVersion: 'v', created: true });
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockBuild.mock.calls[0]).toEqual([{ dryRun: false }, { env }]);
  });

  it("a gate's refusal fails the run loudly", async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockBuild.mockRejectedValue(new Error('tag index build: no frozen vocabulary; refusing'));
    await expect(run()).rejects.toThrow('no frozen vocabulary');
  });

  it('runs Tuesdays 06:00 UTC, an hour after the cooc build, with a 90-minute lock', () => {
    const job = buildResourceIntentTagIndexJob as unknown as {
      name: string;
      cron: string;
      options: Record<string, unknown>;
    };
    expect(job.name).toBe('build-resource-intent-tag-index');
    expect(job.cron).toBe('0 6 * * 2');
    expect(job.options).toEqual({ lockExpiration: 90 * 60, keepLockOnDisconnect: true });
  });

  it('its flag is the default-off Flipt key the design names', () => {
    expect(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_BUILD).toBe(
      'resource-intent-tag-index-build'
    );
  });

  it('is registered with the scheduler', () => {
    expect(jobsArrayEntries()).toContain('buildResourceIntentTagIndexJob');
  });
});
