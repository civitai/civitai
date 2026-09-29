import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as ResourceData from '~/server/redis/resource-data.redis';

const { mockGetLoadedResourceAirs, mockQueueUpdate, mockIsFlipt, mockBust } = vi.hoisted(() => ({
  mockGetLoadedResourceAirs: vi.fn(),
  mockQueueUpdate: vi.fn(),
  mockIsFlipt: vi.fn(),
  mockBust: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));

vi.mock('~/server/http/orchestrator/loaded-resources', () => ({
  getLoadedResourceAirs: mockGetLoadedResourceAirs,
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: mockQueueUpdate } }));
vi.mock('~/server/redis/resource-data.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceData>()),
  resourceDataCache: { bust: mockBust },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
}));

import { syncGeneratorLoadedResources } from '~/server/jobs/sync-generator-loaded-resources';
import { dbMock } from '~/__tests__/mocks/db.mock';

type RawCall = [TemplateStringsArray, ...unknown[]];
type Version = { id: number; modelId: number };

const sqlOf = ([strings]: RawCall) => strings.join('?');
const isLookup = (call: RawCall) => sqlOf(call).includes('= ANY');
const queries = () => dbMock.dbWrite.$queryRaw.mock.calls as RawCall[];
const writes = () => dbMock.dbWrite.$executeRaw.mock.calls as RawCall[];
const civitai = (version: number) => `urn:air:sdxl:checkpoint:civitai:1@${version}`;

/**
 * `loaded` is what the flag currently says; `modelOf` is the ModelVersion table. A lookup returns only
 * ids the table has, as the real one does.
 */
function database(loaded: Version[], modelOf: (id: number) => number | undefined = () => 1) {
  dbMock.dbWrite.$queryRaw.mockImplementation(((...call: RawCall) => {
    if (!isLookup(call)) return Promise.resolve(loaded);
    const ids = call[1] as number[];
    return Promise.resolve(
      ids.flatMap((id) => {
        const modelId = modelOf(id);
        return modelId == null ? [] : [{ id, modelId }];
      })
    );
  }) as never);
}

describe('syncGeneratorLoadedResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so a routing set by one test would leak into the next.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0 as never);
    mockQueueUpdate.mockResolvedValue(undefined);
    mockIsFlipt.mockResolvedValue(true);
    mockBust.mockResolvedValue(undefined);
  });

  it('busts the cached resource rows for both directions, and only for what flipped', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(10), civitai(11)]);
    database(
      [
        { id: 10, modelId: 1 },
        { id: 99, modelId: 2 },
      ],
      (id) => ({ 11: 1 }[id])
    );

    await syncGeneratorLoadedResources.run();

    // 10 is in both sets and did not flip; 11 loaded, 99 unloaded.
    expect(mockBust).toHaveBeenCalledWith([11, 99]);
  });

  it('busts nothing on a cycle where the list is unchanged', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(10)]);
    database([{ id: 10, modelId: 1 }]);

    await syncGeneratorLoadedResources.run();

    expect(mockBust).not.toHaveBeenCalled();
  });

  it('does nothing, not even the orchestrator call, while the flag is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await expect(syncGeneratorLoadedResources.run()).resolves.toEqual({ skipped: 'flag off' });
    expect(mockIsFlipt).toHaveBeenCalledWith('sync-generator-loaded-resources');
    expect(mockGetLoadedResourceAirs).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('reads the loaded set without sending the list to the database', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(10)]);
    database([{ id: 10, modelId: 1 }]);

    await syncGeneratorLoadedResources.run();

    expect(mockGetLoadedResourceAirs).toHaveBeenCalledWith({ source: 'civitai' });
    const [read] = queries();
    expect(sqlOf(read)).toMatch(/WHERE\s+"generatorLoaded"/);
    expect(read).toHaveLength(1); // no bound values: the list is not in this query
  });

  it('looks up only the versions that are newly loaded', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(10), civitai(11), civitai(12)]);
    database([{ id: 10, modelId: 1 }]);

    await syncGeneratorLoadedResources.run();

    const lookups = queries().filter(isLookup);
    expect(lookups.map(([, ids]) => ids)).toEqual([[11, 12]]);
  });

  it('unloads what has left the list and loads what has joined, queueing each model once', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(10), civitai(11)]);
    database(
      [
        { id: 10, modelId: 1 },
        { id: 99, modelId: 2 },
      ],
      (id) => ({ 11: 1 }[id])
    );

    await expect(syncGeneratorLoadedResources.run()).resolves.toMatchObject({
      flippedIn: 1,
      flippedOut: 1,
      queued: 2,
    });

    expect(mockQueueUpdate.mock.calls[0][0].map((x: { id: number }) => x.id).sort()).toEqual([
      1, 2,
    ]);
    // The direction is a bound value, not SQL text.
    expect(writes().map(([, loaded, ids]) => [loaded, ids])).toEqual([
      [true, [11]],
      [false, [99]],
    ]);
  });

  it('drops listed ids that name no version', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(10), civitai(404)]);
    database([], (id) => (id === 10 ? 1 : undefined));

    await expect(syncGeneratorLoadedResources.run()).resolves.toMatchObject({ flippedIn: 1 });
    expect(writes().map(([, , ids]) => ids)).toEqual([[10]]);
  });

  it('queues the search index only after every write has landed', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(11)]);
    database([{ id: 99, modelId: 2 }]);

    await syncGeneratorLoadedResources.run();

    const lastWrite = Math.max(...dbMock.dbWrite.$executeRaw.mock.invocationCallOrder);
    expect(mockQueueUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(lastWrite);
  });

  it('skips without reading or writing while the orchestrator is restarting', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue(null);

    await expect(syncGeneratorLoadedResources.run()).resolves.toEqual({
      skipped: 'orchestrator restarting',
    });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });

  it('refuses to clear when the list resolves to no model versions', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([
      'urn:air:flux1:clip:huggingface:comfyanonymous/flux_text_encoders@main/t5xxl_fp16.safetensors',
      'urn:air:sdxl:lora:orchestrator:blob@12345',
    ]);

    await expect(syncGeneratorLoadedResources.run()).rejects.toThrow('refusing to clear');
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('costs one read and nothing else when the resident set has not changed', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue([civitai(10)]);
    database([{ id: 10, modelId: 1 }]);

    await expect(syncGeneratorLoadedResources.run()).resolves.toMatchObject({ queued: 0 });
    expect(queries()).toHaveLength(1);
    expect(mockQueueUpdate).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('looks up and writes in batches on the first run, when every listed version is new', async () => {
    mockGetLoadedResourceAirs.mockResolvedValue(
      Array.from({ length: 12_000 }, (_, i) => civitai(i + 1))
    );
    database([]);

    await syncGeneratorLoadedResources.run();

    const sizes = (calls: RawCall[]) => calls.map((call) => (call.at(-1) as number[]).length);
    expect(sizes(queries().filter(isLookup))).toEqual([5000, 5000, 2000]);
    expect(sizes(writes())).toEqual([5000, 5000, 2000]);
  });

  // Read as text: importing the route loads every job in the app.
  it('is scheduled', () => {
    const route = readFileSync(
      join(process.cwd(), 'src/pages/api/webhooks/run-jobs/[[...run]].ts'),
      'utf8'
    );
    const jobsArray = route.slice(route.indexOf('export const jobs'));
    expect(jobsArray).toMatch(/\bsyncGeneratorLoadedResources,/);
  });
});
