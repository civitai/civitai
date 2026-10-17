import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as Job from '~/server/jobs/job';
import type * as Pipeline from '~/server/services/resource-intent-tags/pipeline';
import type * as Retention from '~/server/services/resource-intent-tags/retention';

const { mockIsFlipt, mockBuild, mockRetention, mockObjects, kvWrites } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockBuild: vi.fn(),
  mockRetention: vi.fn(),
  mockObjects: vi.fn(() => ({ prefix: 'resource-intent/tag-index' })),
  kvWrites: [] as { key: string; value: unknown }[],
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/resource-intent-tags/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof Pipeline>()),
  runTagIndexBuild: mockBuild,
}));
vi.mock('~/server/services/resource-intent-tags/retention', async (importOriginal) => ({
  ...(await importOriginal<typeof Retention>()),
  applyTagIndexRetention: mockRetention,
}));
vi.mock('~/server/services/resource-intent-tags/objects', () => ({
  s3TagIndexObjects: mockObjects,
}));
vi.mock('~/server/db/client', () => {
  const db = {
    keyValue: {
      upsert: async (a: { where: { key: string }; create: { value: unknown } }) => {
        kvWrites.push({ key: a.where.key, value: a.create.value });
        return {};
      },
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return { dbWrite: db, dbRead: db };
});
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
import { TAG_INDEX_HEARTBEAT_KEYS } from '~/server/services/resource-intent-tags/heartbeat';
import { RESOURCE_INTENT_TAGS_SPEC_HASH } from '~/server/services/resource-intent-tags/spec';
import { jobsArrayEntries } from './run-jobs-array';

const run = () =>
  (buildResourceIntentTagIndexJob as unknown as { run: () => Promise<unknown> }).run();

describe('build-resource-intent-tag-index job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvWrites.length = 0;
    mockRetention.mockResolvedValue({ retired: [] });
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
    expect(mockRetention).not.toHaveBeenCalled();
    expect(kvWrites).toEqual([]);
  });

  it('with the flag on, runs a production (not dry) build on the app env, then retention, returning only the summary and its result', async () => {
    mockIsFlipt.mockResolvedValue(true);
    expect(await run()).toEqual({
      build: { vocabVersion: 'v', created: true },
      retention: { retired: [] },
    });
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockBuild.mock.calls[0]).toEqual([{ dryRun: false }, { env }]);
    expect(mockRetention).toHaveBeenCalledTimes(1);
    const [deps, opts] = mockRetention.mock.calls[0] as [
      { objects: unknown },
      { specHash: string; now: Date }
    ];
    expect(deps.objects).toBe(mockObjects.mock.results[0].value);
    expect(opts.specHash).toBe(RESOURCE_INTENT_TAGS_SPEC_HASH);
    expect(kvWrites.map((w) => w.key)).toEqual([
      TAG_INDEX_HEARTBEAT_KEYS.buildSuccess,
      TAG_INDEX_HEARTBEAT_KEYS.retentionSuccess,
    ]);
  });

  it("a gate's refusal fails the run loudly, after recording the failure and running retention", async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockBuild.mockRejectedValue(new Error('tag index build: no frozen vocabulary; refusing'));
    await expect(run()).rejects.toThrow('no frozen vocabulary');
    expect(mockRetention).toHaveBeenCalledTimes(1);
    expect(kvWrites.map((w) => w.key)).toEqual([
      TAG_INDEX_HEARTBEAT_KEYS.buildFailure,
      TAG_INDEX_HEARTBEAT_KEYS.retentionSuccess,
    ]);
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
