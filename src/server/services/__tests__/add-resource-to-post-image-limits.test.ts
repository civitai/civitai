import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  MAX_MANUAL_CHECKPOINTS_PER_IMAGE,
  MAX_MANUAL_RESOURCES_PER_IMAGE,
} from '~/server/common/constants';
import type * as CommonService from '~/server/services/common.service';
import { Availability, ModelStatus, ModelType } from '~/shared/utils/prisma/enums';
import { manualResourceLimitMessages } from '~/utils/manual-image-resources';

/**
 * Server enforcement of the manual image resource limits in `addResourceToPostImage`, the only
 * route that credits an arbitrary number of resources to an image by hand. The editor enforces
 * the same limits, but this is the boundary API and OAuth clients reach.
 *
 * The module scaffold mirrors update-post-image-hidemeta-bust.test.ts.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
  preventReplicationLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/caches', () => {
  const cacheStub = () => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    bust: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    refreshMany: vi.fn(),
  });
  return {
    imageMetaCache: cacheStub(),
    imageResourcesCache: cacheStub(),
    modelVersionAccessCache: cacheStub(),
    postStatCache: cacheStub(),
    thumbnailCache: cacheStub(),
    imageMetadataCache: cacheStub(),
    userBasicCache: cacheStub(),
    userImageVideoCountCaches: cacheStub(),
    userPostCountCache: cacheStub(),
  };
});
vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  createImageResources: vi.fn(),
  deleteImageFromS3: vi.fn(),
  deleteImagesForModelVersionCache: vi.fn(),
  getImagesForPosts: vi.fn(),
  imagesForModelVersionsCache: { refresh: vi.fn() },
  enqueueImageIngestion: vi.fn(),
  invalidateManyImageExistence: vi.fn(),
  purgeImageGenerationDataCache: vi.fn(),
  purgeResizeCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/image-delivery.service', () => ({
  bustImageDeliveryMetadataCache: vi.fn(),
}));
vi.mock('~/server/services/collection.service', () => ({
  getCollectionById: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  removeEntityFromAllCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/post-collection-visibility', () => ({ canViewCollectionPost: vi.fn() }));
vi.mock('~/server/services/tag.service', () => ({
  findOrCreateTagsByName: vi.fn(),
  getVotableImageTags: vi.fn(),
}));
vi.mock('~/server/services/technique.service', () => ({ getTechniqueByName: vi.fn() }));
vi.mock('~/server/services/tool.service', () => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
const { hasEntityAccess } = vi.hoisted(() => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess,
}));

const { addResourceToPostImage, createPost } = await import('~/server/services/post.service');

const IMAGE_ID = 101;
const OTHER_IMAGE_ID = 102;
const NEW_VERSION_ID = 9_000_000;
const OWNER_ID = 2;
const user = { id: 1 } as Parameters<typeof addResourceToPostImage>[0]['user'];

const publishedVersion = {
  id: NEW_VERSION_ID,
  status: ModelStatus.Published,
  publishedAt: null as Date | null,
  availability: Availability.Public,
};
const publishedModel = {
  userId: OWNER_ID,
  status: ModelStatus.Published,
  availability: Availability.Public,
};

const mockVersionFindFirst = dbMock.dbRead.modelVersion.findFirst;
const mockImageFindMany = dbMock.dbWrite.image.findMany;

// The shared db mock hands `dbWrite` itself to a `$transaction` callback, which would let the lock,
// the read and the insert all move outside the transaction unnoticed. A separate client makes
// "inside the transaction" observable.
const tx = {
  $queryRaw: vi.fn(),
  imageResourceHelper: { findMany: vi.fn() },
  imageResourceNew: { createManyAndReturn: vi.fn() },
};

let nextVersionId = 1;
const rows = (n: number, modelType: ModelType, detected: boolean, imageId = IMAGE_ID) =>
  Array.from({ length: n }, () => ({
    imageId,
    modelVersionId: nextVersionId++,
    modelType,
    detected,
  }));

function arrange({
  adding,
  existing,
  imageIds = [IMAGE_ID],
}: {
  adding: ModelType;
  existing: ReturnType<typeof rows>;
  imageIds?: number[];
}) {
  mockVersionFindFirst.mockResolvedValue({
    ...publishedVersion,
    name: 'v1',
    model: { ...publishedModel, id: 1, name: 'm', type: adding },
    files: [],
  });
  mockImageFindMany.mockResolvedValue(
    imageIds.map(() => ({ postId: null, meta: null, type: 'image' }))
  );
  dbMock.dbWrite.$transaction.mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
  tx.$queryRaw.mockResolvedValue([]);
  tx.imageResourceHelper.findMany.mockResolvedValue(existing);
  tx.imageResourceNew.createManyAndReturn.mockResolvedValue(
    imageIds.map((imageId) => ({ imageId, modelVersionId: NEW_VERSION_ID }))
  );
}

const add = (imageIds = [IMAGE_ID]) =>
  addResourceToPostImage({ id: imageIds, modelVersionId: NEW_VERSION_ID, user });

const expectNothingWritten = () => {
  expect(tx.imageResourceNew.createManyAndReturn).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.imageResourceNew.createManyAndReturn).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('addResourceToPostImage manual resource limits', () => {
  it('refuses a manual resource past the total limit, and writes nothing', async () => {
    arrange({
      adding: ModelType.LORA,
      existing: rows(MAX_MANUAL_RESOURCES_PER_IMAGE, ModelType.LORA, false),
    });
    await expect(add()).rejects.toThrow(manualResourceLimitMessages.total);
    expectNothingWritten();
  });

  it('refuses a checkpoint past the checkpoint limit, and writes nothing', async () => {
    arrange({
      adding: ModelType.Checkpoint,
      existing: rows(MAX_MANUAL_CHECKPOINTS_PER_IMAGE, ModelType.Checkpoint, false),
    });
    await expect(add()).rejects.toThrow(manualResourceLimitMessages.checkpoints);
    expectNothingWritten();
  });

  it('does not count auto-detected resources toward either limit', async () => {
    arrange({
      adding: ModelType.Checkpoint,
      existing: [
        ...rows(MAX_MANUAL_RESOURCES_PER_IMAGE, ModelType.LORA, true),
        ...rows(MAX_MANUAL_CHECKPOINTS_PER_IMAGE, ModelType.Checkpoint, true),
      ],
    });
    await expect(add()).resolves.toBeDefined();
    expect(tx.imageResourceNew.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(tx.imageResourceNew.createManyAndReturn.mock.calls[0][0].data).toEqual([
      { imageId: IMAGE_ID, modelVersionId: NEW_VERSION_ID, detected: false },
    ]);
  });

  // The mock returns the fixture rows whatever is selected, so the select itself is pinned.
  it('reads the model type and detected flag of every image being credited', async () => {
    arrange({ adding: ModelType.LORA, existing: [], imageIds: [IMAGE_ID, OTHER_IMAGE_ID] });
    await add([IMAGE_ID, OTHER_IMAGE_ID]);
    expect(tx.imageResourceHelper.findMany).toHaveBeenCalledWith({
      where: { imageId: { in: [IMAGE_ID, OTHER_IMAGE_ID] } },
      select: { imageId: true, modelVersionId: true, modelType: true, detected: true },
    });
  });

  it('refuses the whole request when any one of several images is at a limit', async () => {
    arrange({
      adding: ModelType.LORA,
      imageIds: [IMAGE_ID, OTHER_IMAGE_ID],
      existing: rows(MAX_MANUAL_RESOURCES_PER_IMAGE, ModelType.LORA, false, OTHER_IMAGE_ID),
    });
    await expect(add([IMAGE_ID, OTHER_IMAGE_ID])).rejects.toThrow(
      manualResourceLimitMessages.total
    );
    expectNothingWritten();
  });

  it("does not count one image's resources against another image", async () => {
    // Each image fits on its own; together they are one past the total limit.
    arrange({
      adding: ModelType.LORA,
      imageIds: [IMAGE_ID, OTHER_IMAGE_ID],
      existing: [
        ...rows(MAX_MANUAL_RESOURCES_PER_IMAGE - 1, ModelType.LORA, false, IMAGE_ID),
        ...rows(1, ModelType.LORA, false, OTHER_IMAGE_ID),
      ],
    });
    await expect(add([IMAGE_ID, OTHER_IMAGE_ID])).resolves.toBeDefined();
    expect(tx.imageResourceNew.createManyAndReturn).toHaveBeenCalledTimes(1);
  });

  it('locks exactly the requested image rows, then reads and writes in the same transaction', async () => {
    arrange({ adding: ModelType.LORA, existing: [], imageIds: [IMAGE_ID, OTHER_IMAGE_ID] });
    await add([IMAGE_ID, OTHER_IMAGE_ID]);

    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, idList] = tx.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toBe('SELECT id FROM "Image" WHERE id IN (?) ORDER BY id FOR UPDATE');
    expect(idList.values).toEqual([IMAGE_ID, OTHER_IMAGE_ID]);

    const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    const readOrder = tx.imageResourceHelper.findMany.mock.invocationCallOrder[0];
    const writeOrder = tx.imageResourceNew.createManyAndReturn.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
    expect(readOrder).toBeLessThan(writeOrder);
    expect(dbMock.dbWrite.imageResourceNew.createManyAndReturn).not.toHaveBeenCalled();
  });
});

/**
 * Both routes that take a model version id from the caller and write it: crediting a resource to an
 * image, and creating a post on a version. A version the caller may not view must be refused with
 * exactly the error a nonexistent id gets.
 */
describe('model version visibility on caller-supplied version ids', () => {
  const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const moderator = { id: 3, isModerator: true } as typeof user;

  type Case = {
    name: string;
    version?: Partial<typeof publishedVersion>;
    model?: Partial<typeof publishedModel>;
    viewer?: typeof user;
    granted?: boolean;
  };

  const ALLOWED: Case[] = [
    { name: 'a published version' },
    { name: 'your own draft', version: { status: ModelStatus.Draft }, model: { userId: user.id } },
    {
      name: 'your own private model',
      model: { userId: user.id, availability: Availability.Private },
    },
    {
      name: "a moderator, on someone else's draft",
      version: { status: ModelStatus.Draft },
      viewer: moderator,
    },
    {
      name: "someone else's private version you were granted",
      version: { availability: Availability.Private },
      granted: true,
    },
    {
      name: "a moderator, on someone else's private version with no grant",
      version: { availability: Availability.Private },
      viewer: moderator,
      granted: false,
    },
  ];

  const REFUSED: Case[] = [
    { name: "someone else's draft", version: { status: ModelStatus.Draft } },
    {
      name: "a published version of someone else's draft model",
      model: { status: ModelStatus.Draft },
    },
    { name: "someone else's release scheduled for later", version: { publishedAt: FUTURE } },
    {
      name: "someone else's private version",
      version: { availability: Availability.Private },
      granted: false,
    },
    {
      name: "a version of someone else's private model",
      model: { availability: Availability.Private },
      granted: false,
    },
  ];

  const row = (c: Case) => ({
    ...publishedVersion,
    ...c.version,
    model: { ...publishedModel, ...c.model },
  });

  const paths = {
    attach: {
      async run(found: ReturnType<typeof row> | null, viewer: typeof user) {
        arrange({ adding: ModelType.LORA, existing: [] });
        mockVersionFindFirst.mockResolvedValue(
          found && {
            ...found,
            name: 'v1',
            model: { ...found.model, id: 1, name: 'm', type: ModelType.LORA },
            files: [],
          }
        );
        return addResourceToPostImage({
          id: [IMAGE_ID],
          modelVersionId: NEW_VERSION_ID,
          user: viewer,
        });
      },
      written: () => tx.imageResourceNew.createManyAndReturn.mock.calls.length > 0,
    },
    createPost: {
      async run(found: ReturnType<typeof row> | null, viewer: typeof user) {
        dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(found);
        dbMock.dbWrite.post.create.mockResolvedValue({ id: 5, collectionId: null, tags: [] });
        return createPost({
          userId: viewer.id,
          isModerator: viewer.isModerator,
          modelVersionId: NEW_VERSION_ID,
        });
      },
      written: () => dbMock.dbWrite.post.create.mock.calls.length > 0,
    },
  };

  // Grants only the exact question the check should ask, so a call made for the wrong user,
  // version or entity type reads as a refusal.
  const grant = (granted: boolean | undefined, viewer: typeof user) =>
    hasEntityAccess.mockImplementation(
      async ({ entityType, entityIds, userId, isModerator }: Record<string, unknown>) => [
        {
          hasAccess:
            !!granted &&
            entityType === 'ModelVersion' &&
            JSON.stringify(entityIds) === JSON.stringify([NEW_VERSION_ID]) &&
            userId === viewer.id &&
            isModerator === !!viewer.isModerator,
        },
      ]
    );

  const errorOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
    );

  describe.each(Object.entries(paths))('%s', (_, path) => {
    it.each(ALLOWED.map((c) => [c.name, c] as const))('allows %s', async (_name, c) => {
      grant(c.granted, c.viewer ?? user);
      await expect(path.run(row(c), c.viewer ?? user)).resolves.toBeDefined();
      expect(path.written()).toBe(true);
    });

    it('refuses a nonexistent id as not found, and writes nothing', async () => {
      expect(await errorOf(path.run(null, user))).toEqual({
        code: 'NOT_FOUND',
        message: 'Model version not found.',
      });
      expect(path.written()).toBe(false);
    });

    it.each(REFUSED.map((c) => [c.name, c] as const))(
      'refuses %s with the nonexistent-id error, and writes nothing',
      async (_name, c) => {
        const missing = await errorOf(path.run(null, user));
        vi.clearAllMocks();
        grant(c.granted, c.viewer ?? user);

        const refused = await errorOf(path.run(row(c), c.viewer ?? user));

        expect(missing).not.toBeNull();
        expect(refused).toEqual(missing);
        expect(path.written()).toBe(false);
      }
    );

    // hasEntityAccess also refuses a paid-gated version to a non-purchaser; that is a usage gate,
    // and consulting it for a public version would refuse every early-access release.
    it('does not consult entity access for a public version', async () => {
      grant(false, user);
      await expect(path.run(row({ name: 'public' }), user)).resolves.toBeDefined();
      expect(hasEntityAccess).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['a private model', Availability.Private],
    ['a public model', Availability.Public],
  ])('createPost gives the post the availability of %s', async (_name, availability) => {
    await paths.createPost.run(
      row({ name: 'own', model: { userId: user.id, availability } }),
      user
    );
    expect(dbMock.dbWrite.post.create.mock.calls[0][0].data.availability).toBe(availability);
  });
});
