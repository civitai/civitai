import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

// Redis as the registry sees it: cache entries by key (a bust only marks one stale, so the next
// read refetches), and the generation key, which is on the cache cluster too.
const redis = vi.hoisted(() => ({
  cache: new Map<string, { data: unknown; stale: boolean }>(),
  generation: new Map<string, { value: string; ex: number | undefined }>(),
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
  REMIX_APP_UNAVAILABLE,
  saveRemixApp,
  setRemixAppEnabled,
  submitUserRemixApp,
  reviewUserRemixApp,
  remixReviewHash,
  visibleRemixApps,
  type RemixAppRow,
} from '~/server/services/remix-app-registry.service';
import type { RemixAppInput } from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import { REDIS_KEYS } from '~/server/redis/client';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';

const pixelArt = SEED_REMIX_APPS.find((app) => app.slug === 'pixel-art')!;
const viewer = { features: { remixAppsUserCode: false } };
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
  redis.generation.clear();
  redisMock.redis.get.mockImplementation(
    (async (key: string) => redis.generation.get(key)?.value ?? null) as never
  );
  redisMock.redis.set.mockImplementation((async (
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean }
  ) => {
    if (opts?.NX && redis.generation.has(key)) return null;
    redis.generation.set(key, { value, ex: opts?.EX });
    return 'OK';
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
    expect(
      (await getRegisteredRemixApp('pixel-art', viewer, { allowDisabled: false })).enabled
    ).toBe(true);

    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
      stored(pixelArt, 1, 'remix_disabled'),
    ] as never);
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: false });

    await expect(
      getRegisteredRemixApp('pixel-art', viewer, { allowDisabled: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listRemixAppsForAdmin())[0]).toMatchObject({ slug: 'pixel-art', enabled: false });
  });
});

describe('the registry generation', () => {
  const GENERATION_KEY = 'remix-app:registry-generation';

  it('is a fresh token on the cache cluster after each mod write, with a day-long TTL', async () => {
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([stored(pixelArt, 1)] as never);

    await setRemixAppEnabled({ slug: 'pixel-art', enabled: false });
    const first = redis.generation.get(GENERATION_KEY);
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: true });
    const second = redis.generation.get(GENERATION_KEY);

    expect(first?.ex).toBe(24 * 60 * 60);
    expect(second?.ex).toBe(24 * 60 * 60);
    expect(first?.value).not.toBe(second?.value);
    expect(redisMock.sysRedis.incr).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });

  // The cache cluster can evict the generation key at any time. A reader that finds it gone must
  // not land on an entry filled before the mod write it lost.
  it('serves a mod write after the generation key it bumped is evicted', async () => {
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([stored(pixelArt, 1, 'remix')] as never);
    expect(
      (await getRegisteredRemixApp('pixel-art', viewer, { allowDisabled: false })).enabled
    ).toBe(true);

    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
      stored(pixelArt, 1, 'remix_disabled'),
    ] as never);
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: false });
    redis.generation.delete(GENERATION_KEY);

    await expect(
      getRegisteredRemixApp('pixel-art', viewer, { allowDisabled: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const minted = redis.generation.get(GENERATION_KEY);
    expect(minted?.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(minted?.ex).toBe(24 * 60 * 60);
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
      getRegisteredRemixApp('pixel-art', viewer, { allowDisabled: false })
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
      getRegisteredRemixApp('pixel-art', viewer, { allowDisabled: false })
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

  it('deletes a disabled app that is not a built-in default, and moves readers off the cached registry', async () => {
    const generation = () => redis.generation.get(REDIS_KEYS.REMIX_APP.REGISTRY_GENERATION)?.value;
    await getRemixAppRegistry();
    const before = generation();
    expect(before).toBeDefined();
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row('remix_disabled') as never);
    dbMock.dbWrite.appBlock.deleteMany.mockResolvedValue({ count: 1 });
    await deleteRemixApp({ slug: 'test-charcoal' });
    expect(dbMock.dbWrite.appBlock.deleteMany).toHaveBeenCalledWith({
      where: { id: 'ab_rx_test_charcoal_________', status: 'remix_disabled' },
    });
    // Without the bump, every server serves the deleted app until the cache expires.
    expect(generation()).not.toBe(before);
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

/** A user app's row: what submit will write (PR 5); nothing in this PR writes one. */
const userRow = (over: { slug?: string; status?: string; authorId?: number } = {}) => {
  const slug = over.slug ?? 'u5-my-app';
  return {
    id: 'ab_rx_u5_my_app_____________',
    blockId: `remix-${slug}`,
    version: '1.0.0',
    status: over.status ?? 'remix',
    featuredOrder: 9,
    manifest: {
      kind: 'remix',
      name: 'My app',
      version: '1.0.0',
      targets: [{ slotId: 'image.remix' }],
      remix: {
        icon: 'sparkles',
        engine: {
          safe: {
            ecosystem: REMIX_ENGINES.edit.safe.ecosystemKey,
            versionId: REMIX_ENGINES.edit.safe.modelVersionId,
          },
        },
        source: 'export default defineRemixApp({ async run(ctx) { return []; } });',
      },
      author: { userId: over.authorId ?? 5 },
      review: 'approved',
    },
  };
};

describe('a user app row', () => {
  const flagOn = { features: { remixAppsUserCode: true } };

  it('is only visible behind its flag', async () => {
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([stored(pixelArt, 1), userRow()] as never);
    await expect(
      getRegisteredRemixApp('u5-my-app', viewer, { allowDisabled: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // POSITIVE CONTROL: the same row with the flag on.
    expect(
      (await getRegisteredRemixApp('u5-my-app', flagOn, { allowDisabled: false })).author
    ).toEqual({ userId: 5 });
    expect(visibleRemixApps(await getRemixAppRegistry(), viewer).map((a) => a.slug)).toEqual([
      'pixel-art',
    ]);
  });

  it('refuses to replay in-process', async () => {
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([userRow()] as never);
    const entry = await getRegisteredRemixApp('u5-my-app', flagOn, { allowDisabled: false });
    await expect(
      entry.replay({ imageId: 7, url: 'u', width: 1, height: 1 }, [])
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNAVAILABLE });
  });

  it.each([
    ['another author', userRow({ authorId: 6 })],
    ['no author, in the user namespace', { ...stored(pixelArt, 1), blockId: 'remix-u5-pixels' }],
  ])('is skipped when its slug belongs to %s', async (_, row) => {
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([row, stored(pixelArt, 1)] as never);
    expect((await getRemixAppRegistry()).map((a) => a.slug)).toEqual(['pixel-art']);
  });

  it('is never saved over by a mod save, nor can a mod save claim a user slug', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({
      ...userRow(),
      status: 'remix',
    } as never);
    await expect(saveRemixApp({ ...pixelArt, slug: 'u5-my-app' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    await expect(saveRemixApp({ ...pixelArt, slug: 'u9-squat' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(dbMock.dbWrite.appBlock.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlock.create).not.toHaveBeenCalled();
    // A user row is read off the stored manifest, whatever its slug looks like.
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({
      ...userRow(),
      blockId: 'remix-comic-it',
    } as never);
    await expect(saveRemixApp({ ...pixelArt, slug: 'comic-it' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    // POSITIVE CONTROL: a system slug saves.
    await saveRemixApp({ ...pixelArt, slug: 'comic-it' });
    expect(dbMock.dbWrite.appBlock.create).toHaveBeenCalledTimes(1);
  });

  it('a mod save never writes an author or review state, whatever the input carries', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    await saveRemixApp({
      ...pixelArt,
      slug: 'comic-it',
      author: { userId: 5 },
      review: 'approved',
    } as never);
    const { manifest } = dbMock.dbWrite.appBlock.create.mock.calls[0][0].data as {
      manifest: Record<string, unknown>;
    };
    expect(manifest).not.toHaveProperty('author');
    expect(manifest).not.toHaveProperty('review');
  });
});

describe('user apps: submit, review and enable', () => {
  const SOURCE = 'export default defineRemixApp({ async run(ctx) { return []; } });';
  const userRow = (review: string, source = SOURCE, status = 'remix_disabled'): RemixAppRow => ({
    id: 'ab_rx_u7_probe_____________',
    blockId: 'remix-u7-probe',
    version: '1.0.0',
    manifest: {
      kind: 'remix',
      name: 'Probe',
      version: '1.0.0',
      targets: [{ slotId: 'image.remix' }],
      remix: { icon: 'sparkles', engine: { safe: DEFAULT_ENGINE.safe }, source },
      author: { userId: 7 },
      review,
    },
    status,
    featuredOrder: 9,
  });
  const submission = { name: 'probe', title: 'Probe', icon: 'sparkles' as const, source: SOURCE };
  const hashOf = (row: RemixAppRow) => remixReviewHash(row.manifest as never);

  it('binds a review to the listing text the mod read, not only the code', async () => {
    const retitled = userRow('submitted');
    (retitled.manifest as { name: string }).name = 'Something else';
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(retitled as never);
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(userRow('submitted')),
        decision: 'approved',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it("creates the author's app disabled, awaiting review, on the safe engine only", async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.appBlock.aggregate.mockResolvedValue({ _max: { featuredOrder: 3 } } as never);

    const result = await submitUserRemixApp({ ...submission, authorId: 7 });

    expect(result).toEqual({ slug: 'u7-probe', version: 1, sha256: hashOf(userRow('submitted')) });
    expect(dbMock.dbWrite.appBlock.create.mock.calls[0][0].data).toMatchObject({
      blockId: 'remix-u7-probe',
      status: 'remix_disabled',
      contentRating: 'pg',
      manifest: {
        author: { userId: 7 },
        review: 'submitted',
        remix: { engine: { safe: DEFAULT_ENGINE.safe }, source: SOURCE },
      },
    });
    const { engine } = (
      dbMock.dbWrite.appBlock.create.mock.calls[0][0].data.manifest as {
        remix: { engine: object };
      }
    ).remix;
    expect(engine).not.toHaveProperty('mature');
  });

  it('takes an approved, enabled app back to review and out of menus when its author edits it', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(
      userRow('approved', SOURCE, 'remix') as never
    );

    const { version } = await submitUserRemixApp({
      ...submission,
      source: `${SOURCE}\n`,
      authorId: 7,
    });

    expect(version).toBe(2);
    expect(dbMock.dbWrite.appBlock.update.mock.calls[0][0].data).toMatchObject({
      status: 'remix_disabled',
      manifest: { review: 'submitted' },
    });
  });

  it('refuses a new app past the per-author cap, and still takes an edit there', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.appBlock.count.mockResolvedValue(10);
    await expect(submitUserRemixApp({ ...submission, authorId: 7 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(dbMock.dbWrite.appBlock.count.mock.calls[0][0]).toEqual({
      where: { blockId: { startsWith: 'remix-u7-' } },
    });
    expect(dbMock.dbWrite.appBlock.create).not.toHaveBeenCalled();

    // CONTROL: an edit of an app the author already has is not a new row.
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(userRow('approved') as never);
    await submitUserRemixApp({ ...submission, authorId: 7 });
    expect(dbMock.dbWrite.appBlock.update).toHaveBeenCalledTimes(1);
  });

  it('will not take over a block id a system app holds', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored(pixelArt, 1) as never);
    await expect(submitUserRemixApp({ ...submission, authorId: 7 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(dbMock.dbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('approves the source the mod read, conditional on the row not having changed since', async () => {
    const row = userRow('submitted');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });

    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(row),
      decision: 'approved',
      mature: true,
    });

    const { where, data } = dbMock.dbWrite.appBlock.updateMany.mock.calls[0][0] as {
      where: object;
      data: Record<string, unknown>;
    };
    expect(where).toEqual({ id: row.id, manifest: { equals: row.manifest } });
    expect(data).toMatchObject({
      contentRating: 'x',
      manifest: { review: 'approved', remix: { engine: DEFAULT_ENGINE } },
    });
    expect(data).not.toHaveProperty('status');
  });

  it('rejects by taking the app out of menus, without the mature engine', async () => {
    const row = userRow('approved', SOURCE, 'remix');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });

    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(row),
      decision: 'rejected',
      mature: true,
    });

    const { data } = dbMock.dbWrite.appBlock.updateMany.mock.calls[0][0] as {
      data: { status?: string; manifest: { review: string; remix: { engine: object } } };
    };
    expect(data.status).toBe('remix_disabled');
    expect(data.manifest.review).toBe('rejected');
    expect(data.manifest.remix.engine).not.toHaveProperty('mature');
  });

  it('refuses a review of a source other than the one stored, and one that lost a race', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(userRow('submitted') as never);
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(userRow('submitted', 'other')),
        decision: 'approved',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();

    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(userRow('submitted')),
        decision: 'rejected',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('enables a user app only while its review is approved, in the same write', async () => {
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 0 });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({ id: 'x' } as never);

    await expect(setRemixAppEnabled({ slug: 'u7-probe', enabled: true })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(dbMock.dbWrite.appBlock.updateMany.mock.calls[0][0].where).toMatchObject({
      blockId: 'remix-u7-probe',
      manifest: { path: ['review'], equals: 'approved' },
    });

    // CONTROL: a system app's enable, and a user app's disable, carry no review condition.
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: true });
    await setRemixAppEnabled({ slug: 'u7-probe', enabled: false });
    for (const call of dbMock.dbWrite.appBlock.updateMany.mock.calls.slice(1))
      expect(call[0].where).not.toHaveProperty('manifest');
  });

  it('lists a user app for review with its source and hash, and nothing a mod could edit', async () => {
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([userRow('submitted')] as never);
    dbMock.dbRead.appBlock.findMany.mockResolvedValue([userRow('submitted')] as never);

    const [row] = await listRemixAppsForAdmin();

    expect(row).not.toHaveProperty('input');
    expect(row).toMatchObject({
      slug: 'u7-probe',
      user: {
        authorId: 7,
        review: 'submitted',
        source: SOURCE,
        sha256: hashOf(userRow('submitted')),
      },
    });
  });
});
