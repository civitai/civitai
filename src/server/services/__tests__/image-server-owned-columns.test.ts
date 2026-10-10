import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as z from 'zod';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));
// `setVideoThumbnail` ingests the thumbnail it creates; the ingestion request is not under test.
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createImageIngestionRequest: vi.fn(async () => ({ data: {} })),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { upsertCreatorAnnouncementSchema } from '~/server/schema/announcement.schema';
import { upsertArticleInput } from '~/server/schema/article.schema';
import { upsertBountyEntryInputSchema } from '~/server/schema/bounty-entry.schema';
import { upsertBountyInputSchema } from '~/server/schema/bounty.schema';
import {
  upsertChallengeEventSchema,
  upsertChallengeSchema,
  userChallengeUpsertSchema,
} from '~/server/schema/challenge.schema';
import { addSimpleImagePostInput, upsertCollectionInput } from '~/server/schema/collection.schema';
import { upsertCosmeticShopSectionInput } from '~/server/schema/cosmetic-shop.schema';
import { setVideoThumbnailSchema } from '~/server/schema/image.schema';
import { createPostWithImagesSchema, postAddImageInput } from '~/server/schema/post.schema';
import { purchasableRewardUpsertSchema } from '~/server/schema/purchasable-reward.schema';
import { userProfileUpdateSchema } from '~/server/schema/user-profile.schema';
import { resolveCoverImageId, type CoverImageDeps } from '~/server/services/cover-image.service';
import {
  createEntityImages,
  createImage,
  setVideoThumbnail,
  updateEntityImages,
} from '~/server/services/image.service';
import { CLIENT_IMAGE_COLUMNS, pickClientImageColumns } from '~/server/utils/image-columns';

const URL_KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';
const OWNER = 7;
const OTHER_USER = 8;
const FOREIGN_POST = 9_001;
const OWN_POST = 9_002;

/** A client payload that also tries to set every server-owned column. */
const withServerColumns = (extra: Record<string, unknown> = {}) => ({
  url: URL_KEY,
  name: 'upload.png',
  width: 512,
  height: 768,
  type: 'image',
  postId: FOREIGN_POST,
  id: 123_456,
  index: 3,
  ...extra,
});

type AnySchema = z.ZodType;
const field = (schema: { shape: Record<string, unknown> }, key: string) =>
  schema.shape[key] as AnySchema;
const element = (schema: { shape: Record<string, unknown> }, key: string) =>
  (schema.shape[key] as z.ZodArray<AnySchema>).element;

/**
 * Every route input that carries a client image, by the field that carries it. `keepsId`
 * routes accept `id` as a reference to an existing row; the rest drop it. `post.addImage`
 * names its target post, which `addPostImage` checks, so it is tested separately below.
 */
const ROUTE_IMAGE_FIELDS: [string, AnySchema, { keepsId: boolean; indexed: boolean }][] = [
  [
    'post.createWithImages images[]',
    element(createPostWithImagesSchema, 'images'),
    { keepsId: false, indexed: true },
  ],
  [
    'collection.addSimpleImagePost images[]',
    element(addSimpleImagePostInput, 'images'),
    { keepsId: false, indexed: false },
  ],
  [
    'image.setThumbnail customThumbnail',
    field(setVideoThumbnailSchema, 'customThumbnail'),
    { keepsId: false, indexed: false },
  ],
  [
    'article.upsert coverImage',
    field(upsertArticleInput, 'coverImage'),
    { keepsId: true, indexed: false },
  ],
  [
    'announcement.upsertCreatorAnnouncement coverImage',
    field(upsertCreatorAnnouncementSchema, 'coverImage'),
    { keepsId: true, indexed: false },
  ],
  [
    'challenge.upsert coverImage',
    field(upsertChallengeSchema, 'coverImage'),
    { keepsId: true, indexed: false },
  ],
  [
    'challenge.upsertUserChallenge coverImage',
    field(userChallengeUpsertSchema, 'coverImage'),
    { keepsId: true, indexed: false },
  ],
  [
    'challenge.upsertEvent coverImage',
    field(upsertChallengeEventSchema, 'coverImage'),
    { keepsId: true, indexed: false },
  ],
  [
    'collection.upsert image',
    field(upsertCollectionInput, 'image'),
    { keepsId: true, indexed: false },
  ],
  [
    'userProfile.update coverImage',
    field(userProfileUpdateSchema, 'coverImage'),
    { keepsId: true, indexed: false },
  ],
  [
    'userProfile.update sfwCoverImage',
    field(userProfileUpdateSchema, 'sfwCoverImage'),
    { keepsId: true, indexed: false },
  ],
  [
    'bounty.upsert images[]',
    element(upsertBountyInputSchema, 'images'),
    { keepsId: true, indexed: false },
  ],
  [
    'bountyEntry.upsert images[]',
    element(upsertBountyEntryInputSchema, 'images'),
    { keepsId: true, indexed: false },
  ],
  [
    'cosmeticShop.upsertShopSection image',
    field(upsertCosmeticShopSectionInput, 'image'),
    { keepsId: true, indexed: false },
  ],
  [
    'purchasableReward.upsert coverImage',
    field(purchasableRewardUpsertSchema, 'coverImage'),
    { keepsId: true, indexed: false },
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.create.mockResolvedValue({ id: 4242 } as never);
});

describe('route inputs: server-owned image columns', () => {
  it.each(ROUTE_IMAGE_FIELDS)('%s drops postId', (_route, schema) => {
    const parsed = schema.parse(withServerColumns()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('postId');
    expect(parsed.url).toBe(URL_KEY);
    expect(parsed.width).toBe(512);
  });

  it.each(ROUTE_IMAGE_FIELDS)('%s handles id per its contract', (_route, schema, { keepsId }) => {
    const parsed = schema.parse(withServerColumns()) as Record<string, unknown>;
    if (keepsId) expect(parsed.id).toBe(123_456);
    else expect(parsed).not.toHaveProperty('id');
  });

  it.each(ROUTE_IMAGE_FIELDS.filter(([, , o]) => o.keepsId))(
    '%s accepts only a positive integer id',
    (_route, schema) => {
      for (const id of [0, -1, 1.5]) {
        expect(schema.safeParse(withServerColumns({ id })).success).toBe(false);
      }
    }
  );

  it.each(ROUTE_IMAGE_FIELDS.filter(([, , o]) => !o.indexed))(
    '%s drops index',
    (_route, schema) => {
      const parsed = schema.parse(withServerColumns()) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('index');
    }
  );

  it.each(ROUTE_IMAGE_FIELDS.filter(([, , o]) => o.indexed))(
    '%s keeps a non-negative integer index and rejects others',
    (_route, schema) => {
      expect((schema.parse(withServerColumns({ index: 2 })) as { index: number }).index).toBe(2);
      expect(schema.safeParse(withServerColumns({ index: -1 })).success).toBe(false);
      expect(schema.safeParse(withServerColumns({ index: 1.5 })).success).toBe(false);
    }
  );

  it('post.addImage keeps its target post, drops id, and bounds index', () => {
    const parsed = postAddImageInput.parse(withServerColumns({ postId: OWN_POST }));
    expect(parsed.postId).toBe(OWN_POST);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed.index).toBe(3);
    expect(postAddImageInput.safeParse(withServerColumns({ index: -1 })).success).toBe(false);
    expect(postAddImageInput.safeParse(withServerColumns({ index: 0.5 })).success).toBe(false);
  });
});

describe('pickClientImageColumns', () => {
  it('copies exactly the client columns', () => {
    const client = {
      name: 'n.png',
      url: URL_KEY,
      hash: 'h',
      height: 11,
      width: 13,
      type: 'video',
      mimeType: 'video/mp4',
      sizeKB: 17,
      meta: { prompt: 'p' },
      metadata: { duration: 19 },
    };
    const picked = pickClientImageColumns({
      ...client,
      id: 23,
      postId: 29,
      index: 31,
      userId: OTHER_USER,
      ingestion: 'Scanned',
      toolIds: [37],
    });
    expect(picked).toEqual(client);
    expect([...CLIENT_IMAGE_COLUMNS].sort()).toEqual(Object.keys(client).sort());
  });
});

describe('createImage', () => {
  const createData = () =>
    dbMock.dbWrite.image.create.mock.calls[0][0].data as Record<string, unknown>;

  it('refuses a postId owned by another user, before writing', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue({ userId: OTHER_USER } as never);

    await expect(
      createImage({
        url: URL_KEY,
        type: 'image',
        userId: OWNER,
        postId: FOREIGN_POST,
        skipIngestion: true,
      })
    ).rejects.toThrow(/authoriz|permission/i);

    expect(dbMock.dbWrite.post.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FOREIGN_POST } })
    );
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
  });

  it('refuses a postId that does not exist', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue(null as never);

    await expect(
      createImage({
        url: URL_KEY,
        type: 'image',
        userId: OWNER,
        postId: FOREIGN_POST,
        skipIngestion: true,
      })
    ).rejects.toThrow();
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
  });

  it('writes into the caller’s own post with the given position', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue({ userId: OWNER } as never);

    await createImage({
      url: URL_KEY,
      type: 'image',
      userId: OWNER,
      postId: OWN_POST,
      index: 4,
      skipIngestion: true,
    });

    expect(createData()).toMatchObject({ url: URL_KEY, userId: OWNER, postId: OWN_POST, index: 4 });
  });

  it('never inserts a passed id, and skips the post check without a post', async () => {
    await createImage({ url: URL_KEY, type: 'image', userId: OWNER, id: 77, skipIngestion: true });

    expect(createData()).not.toHaveProperty('id');
    expect(createData().postId ?? null).toBeNull();
    expect(dbMock.dbWrite.post.findUnique).not.toHaveBeenCalled();
  });
});

describe('entity image writers', () => {
  const createManyRows = () =>
    dbMock.dbWrite.image.createMany.mock.calls[0][0].data as Record<string, unknown>[];
  const withAllColumns = withServerColumns() as never;

  it('createEntityImages writes no id, postId or index', async () => {
    await createEntityImages({
      images: [withAllColumns],
      userId: OWNER,
      entityType: 'Bounty',
      entityId: 1,
    });

    const [row] = createManyRows();
    expect(row).toMatchObject({ url: URL_KEY, userId: OWNER, width: 512 });
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('postId');
    expect(row).not.toHaveProperty('index');
  });

  it('updateEntityImages writes no id, postId or index for a new image', async () => {
    const { id: _id, ...fresh } = withServerColumns();
    await updateEntityImages({
      images: [fresh as never],
      userId: OWNER,
      entityType: 'Bounty',
      entityId: 1,
    });

    const [row] = createManyRows();
    expect(row).toMatchObject({ url: URL_KEY, userId: OWNER });
    expect(row).not.toHaveProperty('postId');
    expect(row).not.toHaveProperty('index');
  });

  it('updateEntityImages refuses to link an existing image the caller does not own', async () => {
    dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([] as never);
    dbMock.dbWrite.image.count.mockResolvedValue(0 as never);

    await expect(
      updateEntityImages({
        images: [{ id: 555, url: URL_KEY, type: 'image' }],
        userId: OWNER,
        entityType: 'Bounty',
        entityId: 1,
      })
    ).rejects.toThrow();

    expect(dbMock.dbWrite.image.count).toHaveBeenCalledWith({
      where: { id: { in: [555] }, userId: OWNER },
    });
    expect(dbMock.dbWrite.imageConnection.createMany).not.toHaveBeenCalled();
  });

  it('updateEntityImages links the caller’s own image and keeps already-linked ones', async () => {
    dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([{ imageId: 1 }] as never);
    dbMock.dbWrite.image.count.mockResolvedValue(1 as never);

    await updateEntityImages({
      images: [
        { id: 1, url: URL_KEY, type: 'image' },
        { id: 555, url: URL_KEY, type: 'image' },
      ],
      userId: OWNER,
      entityType: 'Bounty',
      entityId: 1,
    });

    expect(dbMock.dbWrite.image.count).toHaveBeenCalledWith({
      where: { id: { in: [555] }, userId: OWNER },
    });
    expect(dbMock.dbWrite.imageConnection.createMany).toHaveBeenCalledWith({
      data: [{ imageId: 555, entityId: 1, entityType: 'Bounty' }],
    });
  });
});

describe('setVideoThumbnail', () => {
  it('creates the custom thumbnail with no id, postId or index from the client', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      id: 10,
      type: 'video',
      metadata: {},
      userId: OWNER,
    } as never);
    dbMock.dbWrite.image.update.mockResolvedValue({ id: 10 } as never);

    await setVideoThumbnail({
      imageId: 10,
      frame: null,
      customThumbnail: withServerColumns() as never,
      userId: OWNER,
    });

    const data = dbMock.dbWrite.image.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ url: URL_KEY, userId: OWNER, metadata: { parentId: 10 } });
    expect(data).not.toHaveProperty('id');
    expect(data.postId ?? null).toBeNull();
    expect(data.index ?? null).toBeNull();
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { metadata: { thumbnailFrame: null, thumbnailId: 4242 } } })
    );
  });
});

describe('resolveCoverImageId', () => {
  it('creates a new cover with only client columns', async () => {
    const createImageDep = vi.fn().mockResolvedValue({ id: 99 });
    const deps: CoverImageDeps = {
      findReusableImageId: vi.fn().mockResolvedValue(null),
      objectExists: vi.fn().mockResolvedValue(true),
      createImage: createImageDep,
      logExistenceUnknown: vi.fn(),
    };
    const { id: _id, ...cover } = withServerColumns();

    expect(await resolveCoverImageId({ coverImage: cover as never, userId: OWNER }, deps)).toBe(99);

    const args = createImageDep.mock.calls[0][0];
    expect(args).toMatchObject({ url: URL_KEY, userId: OWNER });
    expect(args).not.toHaveProperty('postId');
    expect(args).not.toHaveProperty('index');
    expect(args).not.toHaveProperty('id');
  });
});
