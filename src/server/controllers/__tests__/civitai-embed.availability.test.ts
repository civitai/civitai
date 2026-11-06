import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '~/server/createContext';
import type * as ImageService from '~/server/services/image.service';
import type * as ModelService from '~/server/services/model.service';
import { NsfwLevel } from '~/server/common/enums';
import { getEmbedAvailabilitySchema } from '~/server/schema/civitai-embed.schema';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const { getModelsWithImagesAndModelVersions, getAllImages, getAllImagesIndex, held } = vi.hoisted(
  () => ({
    getModelsWithImagesAndModelVersions: vi.fn(),
    getAllImages: vi.fn(),
    getAllImagesIndex: vi.fn(),
    held: vi.fn(),
  })
);

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions,
  getHeldGalleryLevel: vi.fn(async () => undefined),
  getHeldLevelsByPost: held,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages,
  getAllImagesIndex,
}));

const { getEmbedAvailabilityHandler } = await import(
  '~/server/controllers/civitai-embed.controller'
);

const OWNER = 7;
const signedOut = { user: undefined, features: { canViewNsfw: true } };
const signedInMod = { user: { id: OWNER, isModerator: true }, features: { canViewNsfw: true } };

function ctx(viewer: { user?: unknown; features: Record<string, unknown> }) {
  return {
    ...viewer,
    req: { headers: {} },
    ip: '127.0.0.1',
    cache: { canCache: true },
  } as unknown as Context;
}

/** What each feed would return to whoever asked, with the fields a card needs. */
function feeds(models: object[], images: object[]) {
  getModelsWithImagesAndModelVersions.mockResolvedValue({ items: models, isPrivate: false });
  getAllImages.mockResolvedValue({ items: images, nextCursor: undefined });
  getAllImagesIndex.mockResolvedValue({ items: images, nextCursor: undefined });
}

const run = (raw: Record<string, unknown>, viewer: Parameters<typeof ctx>[0]) =>
  getEmbedAvailabilityHandler({ input: getEmbedAvailabilitySchema.parse(raw), ctx: ctx(viewer) });

const modelCall = () => getModelsWithImagesAndModelVersions.mock.calls[0][0];
const imageCall = () => (getAllImages.mock.calls[0] ?? getAllImagesIndex.mock.calls[0])[0];

beforeEach(() => {
  vi.clearAllMocks();
  held.mockReset().mockResolvedValue(new Map());
});

describe('getEmbedAvailability', () => {
  it('asks both feeds as nobody, so owner and moderator carve-outs never reach the answer', async () => {
    feeds([], []);
    await run({ modelIds: [1], imageIds: [2] }, signedInMod);

    expect(modelCall().user).toBeUndefined();
    expect(imageCall().user).toBeUndefined();
  });

  it("holds the owner's own held image like anyone's: missing, not above their level", async () => {
    // The owner may see an image above its model's held level; this answer is not theirs to keep.
    held.mockResolvedValue(new Map([[50, { level: NsfwLevel.PG, ownerId: OWNER }]]));
    feeds([], [{ id: 2, postId: 50, nsfwLevel: NsfwLevel.X }]);

    const { images } = await run(
      { imageIds: [2], browsingLevel: NsfwLevel.PG },
      { user: { id: OWNER }, features: { canViewNsfw: true } }
    );
    expect(images).toEqual([{ id: 2, available: false, aboveViewerLevel: false }]);
  });

  it("clamps a signed-out caller's forged level to PG, so nothing reads as mature", async () => {
    feeds([{ id: 1, nsfwLevel: NsfwLevel.X, name: 'leak' }], []);
    const { models } = await run(
      { modelIds: [1], browsingLevel: allBrowsingLevelsFlag },
      signedOut
    );

    expect(modelCall().input.browsingLevel).toBe(publicBrowsingLevelsFlag);
    expect(models).toEqual([{ id: 1, available: false, aboveViewerLevel: false }]);
  });

  it('asks for exactly the requested ids, uncursored, with POI and minor items left out', async () => {
    feeds([], []);
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    await run({ modelIds: ids, imageIds: ids }, signedInMod);

    for (const { input } of [modelCall(), { input: imageCall() }])
      expect(input).toMatchObject({ ids, limit: 100, disablePoi: true, disableMinor: true });
    expect(modelCall().input.cursor).toBeUndefined();
    expect(imageCall().cursor).toBeUndefined();
  });

  it('answers each requested id in order with booleans only, and no id it was not asked', async () => {
    feeds(
      [
        { id: 3, nsfwLevel: NsfwLevel.PG, name: 'a', user: { id: 1 } },
        { id: 1, nsfwLevel: NsfwLevel.R, name: 'b', user: { id: 1 } },
        { id: 999, nsfwLevel: NsfwLevel.PG, name: 'extra', user: { id: 1 } },
      ],
      []
    );
    const { models } = await run(
      { modelIds: [1, 2, 3], browsingLevel: NsfwLevel.PG },
      { user: { id: 5 }, features: { canViewNsfw: true } }
    );

    expect(models).toEqual([
      { id: 1, available: false, aboveViewerLevel: true },
      { id: 2, available: false, aboveViewerLevel: false },
      { id: 3, available: true, aboveViewerLevel: false },
    ]);
  });
});

describe('getEmbedAvailability input', () => {
  it('answers a repeated id once', async () => {
    feeds([{ id: 1, nsfwLevel: NsfwLevel.PG }], []);
    const { models } = await run({ modelIds: [1, 1, 2, 1] }, signedOut);

    expect(models.map((m) => m.id)).toEqual([1, 2]);
  });

  it('refuses more ids per type than one card request can hold', () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(getEmbedAvailabilitySchema.safeParse({ modelIds: ids }).success).toBe(false);
  });
});
