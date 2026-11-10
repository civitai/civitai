import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

// Redis as the registry sees it: cache entries by key (a bust only marks one stale, so the next
// read refetches), and the sys keys.
const redis = vi.hoisted(() => ({
  cache: new Map<string, { data: unknown; stale: boolean }>(),
  sys: new Map<string, number>(),
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (key: string, fetch: () => Promise<unknown>) => {
    const entry = redis.cache.get(key);
    if (entry && !entry.stale) return entry.data;
    const data = await fetch();
    redis.cache.set(key, { data, stale: false });
    return data;
  },
  setFetchThroughCache: async (key: string, data: unknown) => {
    redis.cache.set(key, { data, stale: false });
  },
  bustFetchThroughCache: async (key: string) => {
    const entry = redis.cache.get(key);
    if (entry) entry.stale = true;
  },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { Prisma } from '@prisma/client';
import {
  deleteRemixApp,
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
  redis.cache.clear();
  redis.sys.clear();
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    redis.sys.has(key) ? String(redis.sys.get(key)) : null) as never);
  redisMock.sysRedis.incr.mockImplementation((async (key: string) => {
    redis.sys.set(key, (redis.sys.get(key) ?? 0) + 1);
    return redis.sys.get(key);
  }) as never);
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

  it('refuses a new app on video.remix, which no surface shows', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      saveRemixApp({ ...pixelArt, slug: 'comic-it', target: 'video.remix' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.appBlock.create).not.toHaveBeenCalled();
  });

  it('saves a stored video.remix row on its own slot, so a mod can still edit it', async () => {
    const video = { ...pixelArt, target: 'video.remix' as const };
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored(video, 2) as never);
    await saveRemixApp({ ...video, name: 'Pixels' });
    expect(dbMock.dbWrite.appBlock.update).toHaveBeenCalledTimes(1);
    expect(written().data).toMatchObject({
      manifest: { targets: [{ slotId: 'video.remix' }] },
    });
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

describe('overlapping mod writes', () => {
  it('serve the later write, though the earlier one reads the rows last', async () => {
    // The primary, as each write leaves it.
    let status = 'remix_disabled';
    dbMock.dbWrite.appBlock.updateMany.mockImplementation((async (args: {
      data: { status: string };
    }) => {
      status = args.data.status;
      return { count: 1 };
    }) as never);
    // The first read of the rows is slow: it holds what it read until released.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    dbMock.dbWrite.appBlock.findMany.mockImplementation((async () => {
      const seen = status;
      if (reads++ === 0) await released;
      return [stored(pixelArt, 1, seen)];
    }) as never);

    const enable = setRemixAppEnabled({ slug: 'pixel-art', enabled: true });
    await vi.waitFor(() => expect(status).toBe('remix'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: false });
    release();
    await enable;

    await expect(
      getRegisteredRemixApp('pixel-art', { allowDisabled: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a refill in flight across a mod write', () => {
  it('does not bring back the rows it read before the write', async () => {
    let status = 'remix';
    dbMock.dbWrite.appBlock.updateMany.mockImplementation((async (args: {
      data: { status: string };
    }) => {
      status = args.data.status;
      return { count: 1 };
    }) as never);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    dbMock.dbWrite.appBlock.findMany.mockImplementation((async () => {
      const seen = status;
      if (reads++ === 0) await released;
      return [stored(pixelArt, 1, seen)];
    }) as never);

    // A menu read starts a refill, which reads the app enabled and is slow to cache it.
    const menu = getRemixAppRegistry();
    await vi.waitFor(() => expect(reads).toBe(1));
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: false });
    release();
    await menu;

    await expect(
      getRegisteredRemixApp('pixel-art', { allowDisabled: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('deleteRemixApp', () => {
  const charcoal = { ...pixelArt, slug: 'test-charcoal' };
  const row = (status: string, input = charcoal) => ({
    ...stored(input, 1, status),
    id: 'ab_rx_test_charcoal_________',
    blockId: `remix-${input.slug}`,
  });

  it('deletes a disabled app that is not a built-in default', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row('remix_disabled') as never);
    dbMock.dbWrite.appBlock.deleteMany.mockResolvedValue({ count: 1 });
    await deleteRemixApp({ slug: 'test-charcoal' });
    expect(dbMock.dbWrite.appBlock.deleteMany).toHaveBeenCalledWith({
      where: { id: 'ab_rx_test_charcoal_________', status: 'remix_disabled' },
    });
  });

  it('refuses when the app was enabled between the read and the delete', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row('remix_disabled') as never);
    dbMock.dbWrite.appBlock.deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteRemixApp({ slug: 'test-charcoal' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('refuses an enabled app', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row('remix') as never);
    await expect(deleteRemixApp({ slug: 'test-charcoal' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(dbMock.dbWrite.appBlock.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a built-in default, even disabled', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row('remix_disabled', pixelArt) as never);
    await expect(deleteRemixApp({ slug: 'pixel-art' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(dbMock.dbWrite.appBlock.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a block that is not a remix row', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row('approved') as never);
    await expect(deleteRemixApp({ slug: 'test-charcoal' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbWrite.appBlock.deleteMany).not.toHaveBeenCalled();
  });

  it('says so when other records still point at the app', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row('remix_disabled') as never);
    dbMock.dbWrite.appBlock.deleteMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' })
    );
    await expect(deleteRemixApp({ slug: 'test-charcoal' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('lists only disabled non-default rows as deletable', async () => {
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
      row('remix_disabled'),
      { ...row('remix'), blockId: 'remix-enabled-one' },
      row('remix_disabled', pixelArt),
    ] as never);
    const listed = await listRemixAppsForAdmin();
    expect(Object.fromEntries(listed.map((r) => [r.slug, r.deletable]))).toEqual({
      'test-charcoal': true,
      'enabled-one': false,
      'pixel-art': false,
    });
  });
});
