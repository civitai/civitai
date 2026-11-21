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
  clearRemixMinorThemed,
  remixReviewHash,
  visibleRemixApps,
  type RemixAppRow,
} from '~/server/services/remix-app-registry.service';
import type { RemixAppInput } from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import { REDIS_KEYS } from '~/server/redis/client';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import { REMIX_REVIEW_LOG_MAX } from '~/shared/remix-apps/row.schema';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

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
      where: expect.objectContaining({
        id: 'ab_rx_test_charcoal_________',
        status: 'remix_disabled',
      }),
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
  const MOD = 88;
  const userRow = (
    review: string,
    source = SOURCE,
    status = 'remix_disabled',
    extra: object = {}
  ): RemixAppRow => ({
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
      ...extra,
    },
    status,
    featuredOrder: 9,
  });
  const submission = { name: 'probe', title: 'Probe', icon: 'sparkles' as const, source: SOURCE };
  const hashOf = (row: RemixAppRow) => remixReviewHash(row.manifest as never);
  const reviewOf = (row: RemixAppRow) =>
    (row.manifest as { review: 'submitted' | 'approved' | 'rejected' }).review;
  type Written = {
    where: object;
    data: { status?: string; contentRating?: string; manifest: Record<string, unknown> };
  };
  const lastWrite = () => dbMock.dbWrite.appBlock.updateMany.mock.calls.at(-1)![0] as Written;
  const logOf = (w: Written) => w.data.manifest.reviewLog as Record<string, unknown>[];
  const marked = { minorThemed: { by: MOD, at: '2026-11-19T00:00:00.000Z' } };
  beforeEach(() => {
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([]);
  });

  it("creates the author's app disabled, awaiting review, on the safe engine only", async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.appBlock.aggregate.mockResolvedValue({ _max: { featuredOrder: 3 } } as never);

    const result = await submitUserRemixApp({ ...submission, authorId: 7 });

    expect(result).toEqual({ slug: 'u7-probe', version: 1, sha256: hashOf(userRow('submitted')) });
    const { data } = dbMock.dbWrite.appBlock.create.mock.calls[0][0];
    expect(data).toMatchObject({
      blockId: 'remix-u7-probe',
      status: 'remix_disabled',
      contentRating: 'pg',
      manifest: {
        author: { userId: 7 },
        review: 'submitted',
        remix: { engine: { safe: DEFAULT_ENGINE.safe }, source: SOURCE },
        reviewLog: [{ by: 7, action: 'submitted', sha256: result.sha256 }],
      },
    });
    expect((data.manifest as { remix: { engine: object } }).remix.engine).not.toHaveProperty(
      'mature'
    );
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
    expect(lastWrite().where).toMatchObject({ manifest: { equals: expect.anything() } });
    expect(lastWrite().data).toMatchObject({
      status: 'remix_disabled',
      manifest: { review: 'submitted' },
    });
  });

  it("keeps the server's log and minor-themed mark through an author's edit, whatever the edit carries", async () => {
    const prior = [
      { by: MOD, at: '2026-11-18T00:00:00.000Z', action: 'rejected', reason: 'minor-themed' },
    ];
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(
      userRow('rejected', SOURCE, 'remix_disabled', { ...marked, reviewLog: prior }) as never
    );

    await submitUserRemixApp({
      ...submission,
      authorId: 7,
      ...({ reviewLog: [], minorThemed: undefined, review: 'approved' } as object),
    });

    const { manifest } = lastWrite().data;
    expect(manifest.minorThemed).toEqual(marked.minorThemed);
    expect(manifest.review).toBe('submitted');
    expect(manifest.reviewLog).toEqual([
      ...prior,
      expect.objectContaining({ by: 7, action: 'submitted' }),
    ]);
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
    redis.generation.clear(); // the lock the refused call held; a real release deletes it
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(userRow('approved') as never);
    await submitUserRemixApp({ ...submission, authorId: 7 });
    expect(dbMock.dbWrite.appBlock.updateMany).toHaveBeenCalledTimes(1);
  });

  it('will not take over a block id a system app holds', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored(pixelArt, 1) as never);
    await expect(submitUserRemixApp({ ...submission, authorId: 7 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(dbMock.dbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('approves the version the mod read, conditional on the row not having changed since, and logs it', async () => {
    const row = userRow('submitted');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });

    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(row),
      seenReview: reviewOf(row),
      decision: 'approved',
      mature: true,
      moderatorId: MOD,
    });

    const written = lastWrite();
    expect(written.where).toEqual({ id: row.id, manifest: { equals: row.manifest } });
    expect(written.data).toMatchObject({
      contentRating: 'x',
      manifest: { review: 'approved', remix: { engine: DEFAULT_ENGINE } },
    });
    expect(written.data).not.toHaveProperty('status');
    expect(logOf(written)).toEqual([
      expect.objectContaining({ by: MOD, action: 'approved', sha256: hashOf(row), mature: true }),
    ]);
  });

  it('rejects with a reason, taking the app out of menus without the mature engine', async () => {
    const row = userRow('approved', SOURCE, 'remix');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(row),
        seenReview: reviewOf(row),
        decision: 'rejected',
        moderatorId: MOD,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();

    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(row),
      seenReview: reviewOf(row),
      decision: 'rejected',
      reason: 'broken',
      note: 'Throws on every image',
      mature: true,
      moderatorId: MOD,
    });

    const written = lastWrite();
    expect(written.data.status).toBe('remix_disabled');
    expect(written.data.manifest.review).toBe('rejected');
    expect((written.data.manifest.remix as { engine: object }).engine).not.toHaveProperty('mature');
    expect(written.data.manifest).not.toHaveProperty('minorThemed');
    expect(logOf(written)).toEqual([
      expect.objectContaining({
        action: 'rejected',
        reason: 'broken',
        note: 'Throws on every image',
      }),
    ]);
  });

  it('marks an app rejected as minor-themed for good: no mature engine until a second mod clears it', async () => {
    const row = userRow('submitted');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(row),
      seenReview: reviewOf(row),
      decision: 'rejected',
      reason: 'minor-themed',
      moderatorId: MOD,
    });
    expect(lastWrite().data.manifest.minorThemed).toEqual({ by: MOD, at: expect.any(String) });

    const markedRow = userRow('submitted', SOURCE, 'remix_disabled', marked);
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(markedRow as never);
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([markedRow] as never);
    dbMock.dbWrite.appBlock.updateMany.mockClear();
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(markedRow),
        seenReview: reviewOf(markedRow),
        decision: 'approved',
        mature: true,
        moderatorId: 99,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();

    // CONTROL: the same app approves for safe sources, and keeps its mark.
    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(markedRow),
      seenReview: reviewOf(markedRow),
      decision: 'approved',
      moderatorId: 99,
    });
    expect(lastWrite().data.manifest.minorThemed).toEqual(marked.minorThemed);

    await expect(
      clearRemixMinorThemed({ slug: 'u7-probe', moderatorId: MOD })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await clearRemixMinorThemed({ slug: 'u7-probe', moderatorId: 99 });
    expect(lastWrite().data.manifest).not.toHaveProperty('minorThemed');
    expect(logOf(lastWrite()).at(-1)).toMatchObject({ by: 99, action: 'cleared-minor-themed' });
  });

  it.each([
    [
      'source',
      { remix: { icon: 'sparkles', engine: { safe: DEFAULT_ENGINE.safe }, source: 'other' } },
    ],
    ['icon', { remix: { icon: 'pick', engine: { safe: DEFAULT_ENGINE.safe }, source: SOURCE } }],
    ['description', { description: 'Now with a description' }],
  ])('refuses an approval when the stored %s differs from what the mod read', async (_, change) => {
    const read = userRow('submitted');
    const stored = userRow('submitted', SOURCE, 'remix_disabled', change);
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored as never);
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(read),
        seenReview: reviewOf(read),
        decision: 'approved',
        moderatorId: MOD,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an approval that carries a reject reason', async () => {
    const row = userRow('submitted');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(row),
        seenReview: reviewOf(row),
        decision: 'approved',
        mature: true,
        reason: 'minor-themed',
        moderatorId: MOD,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it("bars the mature engine while any of the author's apps is marked, not only the marked one", async () => {
    const row = userRow('submitted');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
      { manifest: row.manifest },
      { manifest: { ...(row.manifest as object), ...marked } },
    ] as never);
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(row),
        seenReview: reviewOf(row),
        decision: 'approved',
        mature: true,
        moderatorId: 99,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.appBlock.findMany.mock.calls[0][0]).toMatchObject({
      where: { blockId: { startsWith: 'remix-u7-' } },
    });
  });

  it("takes the mature engine off the author's other apps when one is rejected as minor-themed", async () => {
    // Approved mature itself, so the reject must not trip over its own stale copy in the sweep.
    const reviewed = userRow('approved', SOURCE, 'remix');
    (reviewed.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
    const sibling = {
      ...userRow('approved', 'other', 'remix'),
      id: 'ab_rx_u7_other_____________',
      blockId: 'remix-u7-other',
    };
    (sibling.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(reviewed as never);
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([reviewed, sibling] as never);
    // The table as it stands: a write conditional on a manifest that has since changed matches nothing.
    const current = new Map([reviewed, sibling].map((r) => [r.id, JSON.stringify(r.manifest)]));
    dbMock.dbWrite.appBlock.updateMany.mockImplementation((async ({ where, data }: Written) => {
      const { id, manifest } = where as { id: string; manifest: { equals: unknown } };
      if (current.get(id) !== JSON.stringify(manifest.equals)) return { count: 0 };
      current.set(id, JSON.stringify(data.manifest));
      return { count: 1 };
    }) as never);

    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(reviewed),
      seenReview: reviewOf(reviewed),
      decision: 'rejected',
      reason: 'minor-themed',
      moderatorId: MOD,
    });

    const revoke = lastWrite();
    expect(revoke.where).toEqual({ id: sibling.id, manifest: { equals: sibling.manifest } });
    expect(revoke.data.contentRating).toBe('pg');
    // Out of menus and back to review, not deleted.
    expect(revoke.data.status).toBe('remix_disabled');
    expect(revoke.data.manifest.review).toBe('submitted');
    expect((revoke.data.manifest.remix as { engine: object }).engine).toEqual({
      safe: DEFAULT_ENGINE.safe,
    });
    expect(logOf(revoke).at(-1)).toMatchObject({ by: MOD, action: 'mature-revoked' });

    // And a mature app of a marked author is not enabled again.
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(sibling as never);
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
      { manifest: { ...(reviewed.manifest as object), ...marked } },
    ] as never);
    dbMock.dbWrite.appBlock.updateMany.mockClear();
    await expect(
      setRemixAppEnabled({ slug: 'u7-other', enabled: true, moderatorId: MOD })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('refuses the mature engine at run time on any app of a marked author', async () => {
    const sibling = {
      ...userRow('approved', 'other', 'remix'),
      id: 'ab_rx_u7_other_____________',
      blockId: 'remix-u7-other',
    };
    (sibling.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
    const markedRow = userRow('rejected', SOURCE, 'remix_disabled', marked);
    const matureSource = {
      id: 1,
      url: 'abc-123',
      type: MediaType.image,
      nsfwLevel: 8,
      ingestion: ImageIngestionStatus.Scanned,
    };
    const runOn = async (rows: RemixAppRow[]) => {
      redis.cache.clear();
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue(rows as never);
      const entry = await getRegisteredRemixApp(
        'u7-other',
        { features: { remixAppsUserCode: true } },
        { allowDisabled: false }
      );
      return resolveRemixAppEngine(entry.app as never, matureSource, {
        isGreen: false,
        showNsfw: true,
      });
    };
    const refused = { refusal: 'Probe does not run on mature images.' };

    // POSITIVE CONTROL: with no mark the same row reaches the mature engine.
    expect(await runOn([sibling])).toMatchObject({ tier: 'mature' });
    expect(await runOn([sibling, markedRow])).toEqual(refused);
    // A marked row that no longer validates still bars it.
    const invalid = { ...markedRow, manifest: { ...(markedRow.manifest as object), remix: 'x' } };
    expect(await runOn([sibling, invalid])).toEqual(refused);
  });

  it('re-reads and sweeps a sibling written while the minor-themed reject runs', async () => {
    const reviewed = userRow('submitted');
    const sibling = {
      ...userRow('approved', 'other', 'remix'),
      id: 'ab_rx_u7_other_____________',
      blockId: 'remix-u7-other',
    };
    (sibling.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
    // A mod enabled it after the sweep read it, so the sweep's first write is conditional on a stale copy.
    const moved = {
      ...sibling,
      manifest: {
        ...(sibling.manifest as object),
        reviewLog: [{ by: 99, at: 'x', action: 'enabled' }],
      },
    };
    dbMock.dbWrite.appBlock.findUnique
      .mockResolvedValueOnce(reviewed as never)
      .mockResolvedValueOnce(moved as never);
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([reviewed, sibling] as never);
    const current = new Map([reviewed, moved].map((r) => [r.id, JSON.stringify(r.manifest)]));
    dbMock.dbWrite.appBlock.updateMany.mockImplementation((async ({ where, data }: Written) => {
      const { id, manifest } = where as { id: string; manifest: { equals: unknown } };
      if (current.get(id) !== JSON.stringify(manifest.equals)) return { count: 0 };
      current.set(id, JSON.stringify(data.manifest));
      return { count: 1 };
    }) as never);

    await reviewUserRemixApp({
      slug: 'u7-probe',
      sha256: hashOf(reviewed),
      seenReview: reviewOf(reviewed),
      decision: 'rejected',
      reason: 'minor-themed',
      moderatorId: MOD,
    });

    const held = JSON.parse(current.get(sibling.id)!);
    expect(held.review).toBe('submitted');
    expect(held.remix.engine).toEqual({ safe: DEFAULT_ENGINE.safe });
    expect(lastWrite().data.status).toBe('remix_disabled');
    expect(lastWrite().where).toEqual({ id: sibling.id, manifest: { equals: moved.manifest } });
  });

  describe('the minor-themed sweep and bar, scoped', () => {
    const sibling = (slug: string, mature: boolean) => {
      const row = {
        ...userRow('approved', slug, 'remix'),
        id: `ab_rx_u7_${slug}`.padEnd(28, '_'),
        blockId: `remix-u7-${slug}`,
      };
      if (mature) (row.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
      return row;
    };
    const writtenIds = () =>
      dbMock.dbWrite.appBlock.updateMany.mock.calls.map((c) => (c[0].where as { id: string }).id);

    it.each([
      ['broken', [] as string[]],
      ['minor-themed', [sibling('mature', true).id]],
    ] as const)('a %s reject sweeps only the mature siblings', async (reason, swept) => {
      const reviewed = userRow('submitted');
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(reviewed as never);
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
        reviewed,
        sibling('mature', true),
        sibling('safe', false),
      ] as never);
      await reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(reviewed),
        seenReview: reviewOf(reviewed),
        decision: 'rejected',
        reason,
        moderatorId: MOD,
      });
      expect(writtenIds()).toEqual([reviewed.id, ...swept]);
    });

    it('gives up with a conflict after three tries when a sibling keeps changing', async () => {
      const reviewed = userRow('submitted');
      const mature = sibling('mature', true);
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(reviewed as never);
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue([reviewed, mature] as never);
      let calls = 0;
      dbMock.dbWrite.appBlock.updateMany.mockImplementation((async ({ where }: Written) => {
        // Bounded, so a sweep that never gives up fails here instead of hanging.
        if (++calls > 10) throw new Error('sweep did not give up');
        return { count: (where as { id: string }).id === reviewed.id ? 1 : 0 };
      }) as never);
      // Every re-read returns the row the sweep keeps losing to.
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValueOnce(reviewed as never);
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(mature as never);
      await expect(
        reviewUserRemixApp({
          slug: 'u7-probe',
          sha256: hashOf(reviewed),
          seenReview: reviewOf(reviewed),
          decision: 'rejected',
          reason: 'minor-themed',
          moderatorId: MOD,
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(writtenIds().filter((id) => id === mature.id)).toHaveLength(3);
    });

    it("still enables a marked author's safe app", async () => {
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(sibling('safe', false) as never);
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
        userRow('rejected', SOURCE, 'remix_disabled', marked),
      ] as never);
      await setRemixAppEnabled({ slug: 'u7-safe', enabled: true, moderatorId: MOD });
      expect(lastWrite().data.status).toBe('remix');
    });

    it("leaves other authors' and system apps on the mature engine", async () => {
      const otherMarked = {
        ...userRow('rejected', SOURCE, 'remix_disabled', marked),
        id: 'ab_rx_u8_probe_____________',
        blockId: 'remix-u8-probe',
      };
      (otherMarked.manifest as { author: object }).author = { userId: 8 };
      redis.cache.clear();
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
        sibling('mature', true),
        otherMarked,
        stored(pixelArt, 1),
      ] as never);
      const flagOn = { features: { remixAppsUserCode: true } };
      const engineOf = async (slug: string) =>
        (await getRegisteredRemixApp(slug, flagOn, { allowDisabled: true })).app.engine;
      expect(await engineOf('u7-mature')).toEqual(DEFAULT_ENGINE);
      expect(await engineOf('pixel-art')).toHaveProperty('mature');
      // POSITIVE CONTROL: the marked author's own app loses it.
      (otherMarked.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
      (otherMarked.manifest as { review: string }).review = 'approved';
      redis.cache.clear();
      expect(await engineOf('u8-probe')).toEqual({ safe: DEFAULT_ENGINE.safe });
    });

    it('refuses to clear a mark that is not there', async () => {
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(userRow('rejected') as never);
      await expect(
        clearRemixMinorThemed({ slug: 'u7-probe', moderatorId: 99 })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('the security-lane races', () => {
    const matureSibling = (slug: string) => {
      const row = {
        ...userRow('approved', slug, 'remix'),
        id: `ab_rx_u7_${slug}`.padEnd(28, '_'),
        blockId: `remix-u7-${slug}`,
      };
      (row.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
      return row;
    };
    const writtenIds = () =>
      dbMock.dbWrite.appBlock.updateMany.mock.calls.map((c) => (c[0].where as { id: string }).id);

    it("refuses a decision made on a view older than another mod's decision", async () => {
      // B rejected it as minor-themed after A opened it as submitted; the source is unchanged.
      const row = userRow('rejected', SOURCE, 'remix_disabled', marked);
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
      const approveAsSeen = (seenReview: 'submitted' | 'rejected') =>
        reviewUserRemixApp({
          slug: 'u7-probe',
          sha256: hashOf(row),
          seenReview,
          decision: 'approved',
          moderatorId: 99,
        });
      await expect(approveAsSeen('submitted')).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
      // POSITIVE CONTROL: a mod who saw the rejection may decide.
      await approveAsSeen('rejected');
      expect(dbMock.dbWrite.appBlock.updateMany).toHaveBeenCalledTimes(1);
    });

    it('deletes only the row it read, so a mark set in between survives', async () => {
      const row = userRow('submitted');
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
      dbMock.dbWrite.appBlock.deleteMany.mockResolvedValue({ count: 1 });
      await deleteRemixApp({ slug: 'u7-probe' });
      expect(dbMock.dbWrite.appBlock.deleteMany.mock.calls[0][0]).toEqual({
        where: { id: row.id, status: 'remix_disabled', manifest: { equals: row.manifest } },
      });
    });

    it('sends a mature approval back to review when a mark landed after its check', async () => {
      const row = userRow('submitted');
      const markedSibling = {
        ...userRow('rejected', 'x', 'remix_disabled', marked),
        id: 'ab_rx_u7_x_________________',
        blockId: 'remix-u7-x',
      };
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
      const current = new Map([[row.id, JSON.stringify(row.manifest)]]);
      dbMock.dbWrite.appBlock.updateMany.mockImplementation((async ({ where, data }: Written) => {
        const { id, manifest } = where as { id: string; manifest: { equals: unknown } };
        if (current.get(id) !== JSON.stringify(manifest.equals)) return { count: 0 };
        current.set(id, JSON.stringify(data.manifest));
        return { count: 1 };
      }) as never);
      // The check before the write reads no mark; every read after it sees the sibling's.
      dbMock.dbWrite.appBlock.findMany.mockResolvedValueOnce([]);
      dbMock.dbWrite.appBlock.findMany.mockImplementation((async () => [
        { ...row, manifest: JSON.parse(current.get(row.id)!) },
        markedSibling,
      ]) as never);

      await expect(
        reviewUserRemixApp({
          slug: 'u7-probe',
          sha256: hashOf(row),
          seenReview: 'submitted',
          decision: 'approved',
          mature: true,
          moderatorId: MOD,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const held = JSON.parse(current.get(row.id)!);
      expect(held.review).toBe('submitted');
      expect(held.remix.engine).toEqual({ safe: DEFAULT_ENGINE.safe });
      expect(lastWrite().data.status).toBe('remix_disabled');
    });

    it('sweeps every sibling even when one keeps failing, and says the decision was saved', async () => {
      const reviewed = userRow('submitted');
      const stuck = matureSibling('stuck');
      const fine = matureSibling('fine');
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValueOnce(reviewed as never);
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stuck as never);
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue([reviewed, stuck, fine] as never);
      let calls = 0;
      dbMock.dbWrite.appBlock.updateMany.mockImplementation((async ({ where }: Written) => {
        // Bounded, so a sweep that never gives up fails here instead of running out of memory.
        if (++calls > 10) throw new Error('sweep did not give up');
        return { count: (where as { id: string }).id === stuck.id ? 0 : 1 };
      }) as never);
      await expect(
        reviewUserRemixApp({
          slug: 'u7-probe',
          sha256: hashOf(reviewed),
          seenReview: 'submitted',
          decision: 'rejected',
          reason: 'minor-themed',
          moderatorId: MOD,
        })
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('was saved') });
      expect(writtenIds()).toContain(fine.id);
    });

    it('runs the sweep even when the registry bump fails, and reports the sweep, not the cache', async () => {
      const reviewed = userRow('submitted');
      const sibling = matureSibling('other');
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(reviewed as never);
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue([reviewed, sibling] as never);
      // Every bump fails: the sibling's own, then the reject's.
      redisMock.redis.set.mockRejectedValue(new Error('cluster down'));
      await expect(
        reviewUserRemixApp({
          slug: 'u7-probe',
          sha256: hashOf(reviewed),
          seenReview: 'submitted',
          decision: 'rejected',
          reason: 'minor-themed',
          moderatorId: MOD,
        })
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('was saved') });
      expect(writtenIds()).toEqual([reviewed.id, sibling.id]);
    });
  });

  it('will not delete a marked app, which would drop its mark', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(
      userRow('rejected', SOURCE, 'remix_disabled', marked) as never
    );
    await expect(deleteRemixApp({ slug: 'u7-probe' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.appBlock.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses an author's save that lost a race to a mod's write, and one over a row it cannot read", async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(userRow('submitted') as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 0 });
    await expect(submitUserRemixApp({ ...submission, authorId: 7 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    redis.generation.clear();
    const broken = userRow('submitted');
    (broken.manifest as Record<string, unknown>).version = 'not-a-version';
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(broken as never);
    dbMock.dbWrite.appBlock.updateMany.mockClear();
    await expect(submitUserRemixApp({ ...submission, authorId: 7 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('will not take over a block id held by a row that is not a remix app', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({
      ...userRow('submitted'),
      status: 'published',
    } as never);
    await expect(submitUserRemixApp({ ...submission, authorId: 7 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('shows an unapproved user app only to its author and moderators', () => {
    const apps = [
      { slug: 'sys' },
      { slug: 'u7-a', author: { userId: 7 }, review: 'submitted' as const },
      { slug: 'u7-b', author: { userId: 7 }, review: 'approved' as const },
    ];
    const on = { remixAppsUserCode: true };
    const slugs = (user?: { id: number; isModerator?: boolean }) =>
      visibleRemixApps(apps, { features: on, user }).map((a) => a.slug);
    expect(slugs({ id: 9 })).toEqual(['sys', 'u7-b']);
    expect(slugs({ id: 7 })).toEqual(['sys', 'u7-a', 'u7-b']);
    expect(slugs({ id: 9, isModerator: true })).toEqual(['sys', 'u7-a', 'u7-b']);
  });

  it('binds a review to the listing text the mod read, not only the code', async () => {
    const retitled = userRow('submitted');
    (retitled.manifest as { name: string }).name = 'Something else';
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(retitled as never);
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(userRow('submitted')),
        seenReview: reviewOf(userRow('submitted')),
        decision: 'approved',
        moderatorId: MOD,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a review that lost a race to a submit', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(userRow('submitted') as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      reviewUserRemixApp({
        slug: 'u7-probe',
        sha256: hashOf(userRow('submitted')),
        seenReview: reviewOf(userRow('submitted')),
        decision: 'rejected',
        reason: 'spam',
        moderatorId: MOD,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps only the latest review log entries', async () => {
    const full = Array.from({ length: REMIX_REVIEW_LOG_MAX }, (_, i) => ({
      by: MOD,
      at: `2026-11-19T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      action: i % 2 ? 'enabled' : 'disabled',
    }));
    const row = userRow('approved', SOURCE, 'remix', { reviewLog: full });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });

    await setRemixAppEnabled({ slug: 'u7-probe', enabled: false, moderatorId: MOD });

    // The log is the server's record, never part of what a mod's approval hashes.
    expect(hashOf(row)).toBe(hashOf(userRow('approved', SOURCE, 'remix')));
    const log = logOf(lastWrite());
    expect(log).toHaveLength(REMIX_REVIEW_LOG_MAX);
    expect(log[0]).toEqual(full[1]);
    expect(log.at(-1)).toMatchObject({ action: 'disabled', by: MOD });
  });

  it('enables a user app only while its review is approved, conditional on the row read, and logs it', async () => {
    for (const review of ['submitted', 'rejected']) {
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(userRow(review) as never);
      await expect(
        setRemixAppEnabled({ slug: 'u7-probe', enabled: true, moderatorId: MOD })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }
    expect(dbMock.dbWrite.appBlock.updateMany).not.toHaveBeenCalled();

    const approved = userRow('approved');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(approved as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    await setRemixAppEnabled({ slug: 'u7-probe', enabled: true, moderatorId: MOD });
    expect(lastWrite().where).toEqual({ id: approved.id, manifest: { equals: approved.manifest } });
    expect(lastWrite().data.status).toBe('remix');
    expect(logOf(lastWrite())).toEqual([expect.objectContaining({ by: MOD, action: 'enabled' })]);

    // CONTROL: a system app's enable carries no review condition.
    await setRemixAppEnabled({ slug: 'pixel-art', enabled: true });
    expect(lastWrite().where).not.toHaveProperty('manifest');
  });

  it('lists a user app for review with its source, hash and log, and nothing a mod could edit', async () => {
    const log = [
      { by: MOD, at: '2026-11-19T00:00:00.000Z', action: 'rejected', reason: 'minor-themed' },
    ];
    const listed = userRow('submitted', SOURCE, 'remix_disabled', { ...marked, reviewLog: log });
    (listed.manifest as { remix: { engine: object } }).remix.engine = DEFAULT_ENGINE;
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue([listed] as never);
    dbMock.dbRead.appBlock.findMany.mockResolvedValue([listed] as never);

    const [row] = await listRemixAppsForAdmin();

    expect(row).not.toHaveProperty('input');
    expect(row).toMatchObject({
      slug: 'u7-probe',
      user: {
        authorId: 7,
        review: 'submitted',
        source: SOURCE,
        sha256: hashOf(userRow('submitted')),
        mature: true,
        reviewLog: log,
        minorThemed: marked.minorThemed,
      },
    });
  });
});
