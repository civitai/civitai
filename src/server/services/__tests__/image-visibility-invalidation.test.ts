import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { env } from '~/env/client';

/**
 * When a moderator changes who may see an image, the shared copies that can still show it are
 * dropped: every link-preview card that can draw it, the 404 gallery, its resources and the model
 * galleries it is in. Cloudflare is the boundary: its client records what would be purged.
 */

const { cfPurge } = vi.hoisted(() => ({ cfPurge: vi.fn() }));
vi.mock('cloudflare', () => ({
  default: class {
    zones = { purgeCache: cfPurge };
  },
}));
envMock.set({ CF_API_TOKEN: 'test-token', CF_ZONE_ID: 'test-zone' });

const { getImageOgCardUrls, VISIBILITY_REPURGE_DELAY_MS } = await import(
  '~/server/services/image-visibility-invalidation.service'
);
const { updateImageAcceptableMinor, imagesForModelVersionsCache } = await import(
  '~/server/services/image.service'
);
const versionGalleryBust = vi.spyOn(imagesForModelVersionsCache, 'bust');

const IMAGE = 7;
const card = (q: string) => `${env.NEXT_PUBLIC_BASE_URL}/api/og?${q}&v=2`;
const CARDS = [
  card(`type=image&id=${IMAGE}`),
  card('type=post&id=11'),
  card('type=model&id=21&mv=31&u=1000'),
  card('type=article&id=41'),
  card('type=challenge&id=61'),
  card('type=bounty&id=51'),
];
const RESOURCES_PATH = `/api/trpc/image.getResources?input=${IMAGE}`;

beforeEach(() => {
  vi.clearAllMocks();
  cfPurge.mockResolvedValue({ success: true });
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    postId: 11,
    post: { modelVersionId: 31, modelVersion: { modelId: 21 } },
  } as never);
  dbMock.dbRead.model.findMany.mockResolvedValue([
    { id: 21, updatedAt: new Date(1000), modelVersions: [{ id: 31, status: 'Published' }] },
  ] as never);
  dbMock.dbRead.article.findMany.mockResolvedValue([{ id: 41 }] as never);
  dbMock.dbRead.challenge.findMany.mockResolvedValue([{ id: 61 }] as never);
  dbMock.dbRead.imageConnection.findMany.mockResolvedValue([{ entityId: 51 }] as never);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    { isShowcase: false, modelVersionId: 31, modelId: 21, model3dId: null },
  ] as never);
  redisMock.redis.sMembers.mockImplementation((async (key: string) =>
    key.endsWith(`image-resources-${IMAGE}`) ? [RESOURCES_PATH] : []) as never);
});

describe('the link-preview cards an image can be drawn on', () => {
  it('are its own, its post, its models, its articles, its challenges and its bounties', async () => {
    expect(await getImageOgCardUrls(IMAGE)).toEqual(CARDS);
  });

  it('look for models that use it as either cover, or own its post', async () => {
    await getImageOgCardUrls(IMAGE);
    expect(dbMock.dbRead.model.findMany.mock.calls[0][0]?.where).toEqual({
      OR: [{ coverImageId: IMAGE }, { sfwCoverImageId: IMAGE }, { id: 21 }],
    });
    expect(dbMock.dbRead.article.findMany.mock.calls[0][0]?.where).toEqual({
      OR: [{ coverId: IMAGE }, { bannerId: IMAGE }],
    });
    expect(dbMock.dbRead.imageConnection.findMany.mock.calls[0][0]?.where).toEqual({
      imageId: IMAGE,
      entityType: 'Bounty',
    });
  });

  it('are only its own when it has no post and nothing uses it', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ postId: null, post: null } as never);
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.article.findMany.mockResolvedValue([]);
    dbMock.dbRead.challenge.findMany.mockResolvedValue([]);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([]);
    expect(await getImageOgCardUrls(IMAGE)).toEqual([card(`type=image&id=${IMAGE}`)]);
  });
});

describe('a moderator changing an image acceptable-minor flag', () => {
  const flip = (from: boolean, to: boolean) => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ acceptableMinor: from } as never);
    dbMock.dbWrite.image.update.mockResolvedValue({ id: IMAGE, acceptableMinor: to } as never);
    return updateImageAcceptableMinor({ id: IMAGE, collectionId: 1, acceptableMinor: to });
  };
  const purgedFiles = () => cfPurge.mock.calls.flatMap(([, { files }]) => files as string[]);
  const deleted = () => redisMock.redis.del.mock.calls.map(([key]) => String(key));

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [false, true],
    [true, false],
  ])(
    'from %s to %s purges the cards, the tagged edge entries and the 404 gallery',
    async (from, to) => {
      await flip(from, to);
      expect(purgedFiles().sort()).toEqual(
        [...CARDS, `https://civitai.com${RESOURCES_PATH}`].sort()
      );
      expect(redisMock.redis.sMembers).toHaveBeenCalledWith(expect.stringMatching(/:image-404$/));
      expect(redisMock.redis.purgeTags).toHaveBeenCalledWith(['image-404']);
      expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'image-visibility-invalidation' })
      );
    }
  );

  it("drops its post's and model version's gallery caches", async () => {
    await flip(false, true);
    expect(deleted()).toContainEqual(expect.stringMatching(/images-modelVersion:31$/));
    expect(versionGalleryBust).toHaveBeenCalledWith(31);
  });

  it('purges nothing when the flag is already set that way', async () => {
    await flip(true, true);
    expect(cfPurge).not.toHaveBeenCalled();
    expect(redisMock.redis.purgeTags).not.toHaveBeenCalled();
  });

  it('purges again once the replica has had time to catch up', async () => {
    vi.useFakeTimers();
    await flip(false, true);
    vi.clearAllMocks();
    cfPurge.mockResolvedValue({ success: true });
    await vi.advanceTimersByTimeAsync(VISIBILITY_REPURGE_DELAY_MS - 1);
    expect(redisMock.redis.purgeTags).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(redisMock.redis.purgeTags).toHaveBeenCalledWith(['image-404']));
    await vi.waitFor(() => expect(purgedFiles()).toEqual(expect.arrayContaining(CARDS)));
  });

  it('still purges the rest, and logs, when the card lookup fails', async () => {
    dbMock.dbRead.article.findMany.mockRejectedValue(new Error('replica timeout'));
    await expect(flip(false, true)).resolves.toEqual({ id: IMAGE, acceptableMinor: true });
    expect(purgedFiles()).toEqual([`https://civitai.com${RESOURCES_PATH}`]);
    expect(redisMock.redis.purgeTags).toHaveBeenCalledWith(['image-404']);
    expect(deleted()).toContainEqual(expect.stringMatching(/images-modelVersion:31$/));
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'image-visibility-invalidation',
        payload: { imageId: IMAGE },
      })
    );
  });
});

// A purge by tag reaches only entries cached under that tag. A built procedure's middlewares carry
// no identity to inspect, so the tagging is read from the router source.
describe('the cached reads the purge reaches by tag', () => {
  const router = readFileSync(join(process.cwd(), 'src/server/routers/image.router.ts'), 'utf8');
  const procedure = (name: string) =>
    router.slice(router.indexOf(`  ${name}: `)).split('.query(')[0];

  it('tag the 404 gallery in Redis and at the edge', () => {
    expect(procedure('get404Images').match(/tags: \(\) => \[IMAGE_404_CACHE_TAG\]/g)).toHaveLength(
      2
    );
  });

  it("tag an image's resources at the edge by image", () => {
    expect(procedure('getResources')).toContain(
      'tags: (input: { id: number }) => [imageResourcesEdgeTag(input.id)]'
    );
  });
});
