import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

// The registry's one entry, as Redis holds it.
const cache = vi.hoisted(() => ({
  entry: undefined as { data: unknown; stale: boolean } | undefined,
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetch: () => Promise<unknown>) => {
    if (!cache.entry || cache.entry.stale) cache.entry = { data: await fetch(), stale: false };
    return cache.entry.data;
  },
  setFetchThroughCache: vi.fn(async (_key: string, data: unknown) => {
    cache.entry = { data, stale: false };
  }),
  // A bust only marks the entry stale, so the next read refetches.
  bustFetchThroughCache: vi.fn(async () => {
    if (cache.entry) cache.entry.stale = true;
  }),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getRegisteredRemixApp,
  getRemixAppRegistry,
  listRemixAppsForAdmin,
  manifestOf,
  saveRemixApp,
  setRemixAppEnabled,
  type RemixAppRow,
} from '~/server/services/remix-app-registry.service';
import type { RemixAppInput } from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';

const pixelArt = SEED_REMIX_APPS.find((app) => app.slug === 'pixel-art')!;
const stored = (input: RemixAppInput, runVersion: number, status = 'remix'): RemixAppRow => ({
  id: 'apb_remix_pixel_art',
  blockId: 'remix-pixel-art',
  version: `${runVersion}.0.0`,
  manifest: manifestOf(input, runVersion),
  status,
  featuredOrder: 5,
});
const written = () =>
  dbMock.dbWrite.appBlock.update.mock.calls.at(-1)![0] as { data: { version: string } };

beforeEach(() => {
  vi.clearAllMocks();
  cache.entry = undefined;
  dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ id: 'civitai-remix-apps' } as never);
});

describe('saveRemixApp', () => {
  it('keeps the run version for a listing edit, and bumps it when what runs changes', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored(pixelArt, 3) as never);
    await saveRemixApp({ ...pixelArt, name: 'Pixels', description: 'Retro' });
    expect(written().data.version).toBe('3.0.0');

    const spec = pixelArt.spec as Extract<RemixAppInput['spec'], { steps: unknown }>;
    await saveRemixApp({
      ...pixelArt,
      spec: { ...spec, steps: [{ ...spec.steps[0], quantity: 2 } as (typeof spec.steps)[0]] },
    });
    expect(written().data.version).toBe('4.0.0');
  });

  it('adds a new app disabled and last', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.appBlock.aggregate.mockResolvedValue({ _max: { featuredOrder: 7 } } as never);
    await saveRemixApp({ ...pixelArt, slug: 'comic-it' });
    expect(dbMock.dbWrite.appBlock.create.mock.calls[0][0].data).toMatchObject({
      blockId: 'remix-comic-it',
      appId: 'civitai-remix-apps',
      status: 'remix_disabled',
      featuredOrder: 8,
      version: '1.0.0',
    });
  });

  it('will not take over a block id another app holds', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored(pixelArt, 1, 'approved') as never);
    await expect(saveRemixApp(pixelArt)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('refuses to write before the seed migration has made its client', async () => {
    dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue(null);
    await expect(saveRemixApp(pixelArt)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(dbMock.dbWrite.appBlock.create).not.toHaveBeenCalled();
  });
});

describe('the registry after a mod write', () => {
  it('serves a disabled app as disabled at once, though the replica still has it enabled', async () => {
    dbMock.dbRead.appBlock.findMany.mockResolvedValue([stored(pixelArt, 1, 'remix')] as never);
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([stored(pixelArt, 1, 'remix')] as never);
    expect((await getRegisteredRemixApp('pixel-art', { allowDisabled: false })).enabled).toBe(true);

    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
      stored(pixelArt, 1, 'remix_disabled'),
    ] as never);
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: false });

    await expect(
      getRegisteredRemixApp('pixel-art', { allowDisabled: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listRemixAppsForAdmin())[0]).toMatchObject({ slug: 'pixel-art', enabled: false });
  });
});

describe('a stored row whose engine has left the allowlist', () => {
  it('still serves, so an engine version bump does not empty the menu', async () => {
    const spec = pixelArt.spec as Extract<RemixAppInput['spec'], { steps: unknown }>;
    // The version the row was saved on, before the constant moved on.
    const saved = {
      ...pixelArt,
      spec: { ...spec, engine: { safe: { ...spec.engine.safe, versionId: 1 } } },
    };
    dbMock.dbRead.appBlock.findMany.mockResolvedValue([stored(saved, 1)] as never);
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([stored(saved, 1)] as never);

    const registry = await getRemixAppRegistry();
    expect(registry.map((app) => app.slug)).toEqual(['pixel-art']);
    expect(registry[0].spec).toMatchObject({ engine: { safe: { versionId: 1 } } });
  });
});
