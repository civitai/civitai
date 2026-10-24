import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisCaches from '~/server/redis/caches';
import type * as CommonService from '~/server/services/common.service';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

const { mockCacheRefresh, hasEntityAccess } = vi.hoisted(() => ({
  mockCacheRefresh: vi.fn(async () => undefined),
  hasEntityAccess: vi.fn(),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  imageResourcesCache: { refresh: mockCacheRefresh },
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { createImageResources } from '~/server/services/image.service';

/**
 * A version id listed in an image's meta.civitaiResources is written as a detected resource
 * without any hash having matched it. It is kept only when the image's owner can view that
 * version; anything else is dropped without failing the image.
 */

const IMAGE_ID = 1;
const OWNER = { id: 10, isModerator: false };
const STRANGER = 20;
const DAY = 24 * 60 * 60 * 1000;

const V = {
  published: 101,
  ownDraft: 102,
  strangerDraft: 103,
  strangerScheduled: 104,
  strangerPrivate: 105,
  strangerPrivateGranted: 106,
  nonexistent: 107,
  hashMatchedDraft: 108,
  postVersion: 109,
} as const;

const version = (
  id: number,
  over: {
    status?: ModelStatus;
    publishedAt?: Date | null;
    availability?: Availability;
    userId?: number;
  } = {}
) => ({
  id,
  status: over.status ?? ModelStatus.Published,
  publishedAt: over.publishedAt ?? null,
  availability: over.availability ?? Availability.Public,
  model: {
    userId: over.userId ?? STRANGER,
    status: ModelStatus.Published,
    availability: Availability.Public,
  },
});

const VERSIONS = [
  version(V.published),
  version(V.ownDraft, { status: ModelStatus.Draft, userId: OWNER.id }),
  version(V.strangerDraft, { status: ModelStatus.Draft }),
  version(V.strangerScheduled, { publishedAt: new Date(Date.now() + DAY) }),
  version(V.strangerPrivate, { availability: Availability.Private }),
  version(V.strangerPrivateGranted, { availability: Availability.Private }),
];

// get_image_resources row shapes. `asserted` is the meta.civitaiResources branch.
const asserted = (modelversionid: number) => ({
  id: IMAGE_ID,
  modelversionid,
  name: 'lora',
  hash: null,
  strength: 100,
  detected: true,
});
const hashMatched = (modelversionid: number) => ({
  id: IMAGE_ID,
  modelversionid,
  name: 'lora:x',
  hash: 'aabbccddeeff',
  strength: 100,
  detected: true,
});
const fromPost = (modelversionid: number) => ({
  id: IMAGE_ID,
  modelversionid,
  name: 'm - v',
  hash: null,
  strength: null,
  detected: false,
});

type Client = {
  $queryRaw: ReturnType<typeof vi.fn>;
  image: { findUnique: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> };
  modelVersion: { findMany: ReturnType<typeof vi.fn> };
};

// A client separate from dbWrite, so a read that leaves the transaction finds nothing there.
const tx: Client = {
  $queryRaw: vi.fn(),
  image: { findUnique: vi.fn(), update: vi.fn() },
  modelVersion: { findMany: vi.fn() },
};

function arrange(
  rows: unknown[],
  owner: { id: number; isModerator: boolean } | null = OWNER,
  client: Client = dbMock.dbWrite as unknown as Client
) {
  client.$queryRaw.mockReset();
  client.$queryRaw.mockResolvedValueOnce(rows).mockResolvedValue([]);
  client.image.findUnique.mockResolvedValue(owner && ({ user: owner, meta: {} } as never));
  client.modelVersion.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) => VERSIONS.filter((v) => args.where.id.in.includes(v.id))) as never);
  // Grants only the exact question the filter should ask.
  hasEntityAccess.mockImplementation(
    async ({ entityType, entityIds, userId, isModerator }: Record<string, unknown>) =>
      (entityIds as number[]).map((entityId) => ({
        entityId,
        hasAccess:
          entityType === 'ModelVersion' &&
          entityId === V.strangerPrivateGranted &&
          userId === owner?.id &&
          isModerator === owner?.isModerator,
      }))
  );
}

/** The version ids in the ImageResourceNew upsert, or null when no upsert ran. */
function writtenVersionIds(client: Client = dbMock.dbWrite as unknown as Client): number[] | null {
  const insert = client.$queryRaw.mock.calls
    .slice(1)
    .find(([strings]: [TemplateStringsArray]) => strings.join('').includes('ImageResourceNew'));
  if (!insert) return null;
  const values = insert[1].values as unknown[];
  return values.filter((_, i) => i % 4 === 1) as number[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createImageResources: version ids asserted in image meta', () => {
  it("keeps what the owner can view and drops the rest, including ids that don't exist", async () => {
    arrange(Object.values(V).slice(0, 7).map(asserted));

    await createImageResources({ imageId: IMAGE_ID });

    expect(writtenVersionIds()).toEqual([V.published, V.ownDraft, V.strangerPrivateGranted]);
  });

  it('asks for every grant in one call, for the image owner', async () => {
    arrange([asserted(V.strangerPrivate), asserted(V.strangerPrivateGranted)]);

    await createImageResources({ imageId: IMAGE_ID });

    expect(hasEntityAccess).toHaveBeenCalledTimes(1);
    expect(hasEntityAccess).toHaveBeenCalledWith({
      entityType: 'ModelVersion',
      entityIds: [V.strangerPrivate, V.strangerPrivateGranted],
      userId: OWNER.id,
      isModerator: false,
    });
  });

  it("keeps someone else's draft when the image owner is a moderator", async () => {
    arrange([asserted(V.strangerDraft)], { id: 30, isModerator: true });

    await createImageResources({ imageId: IMAGE_ID });

    expect(writtenVersionIds()).toEqual([V.strangerDraft]);
  });

  it('leaves hash-matched and post-derived resources alone', async () => {
    arrange([hashMatched(V.hashMatchedDraft), fromPost(V.postVersion), asserted(V.strangerDraft)]);

    await createImageResources({ imageId: IMAGE_ID });

    expect(writtenVersionIds()).toEqual([V.hashMatchedDraft, V.postVersion]);
    expect(dbMock.dbWrite.modelVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [V.strangerDraft] } } })
    );
  });

  it('writes nothing, and does not throw, when every asserted id is dropped', async () => {
    arrange([asserted(V.strangerDraft), asserted(V.nonexistent)]);

    await expect(createImageResources({ imageId: IMAGE_ID })).resolves.toBeNull();
    expect(writtenVersionIds()).toBeNull();
  });

  // Video metadata carries civitaiResources too, through the same path. Keeps a media-type
  // exemption from creeping into the filter.
  it('filters a video the same way as an image', async () => {
    arrange([asserted(V.published), asserted(V.strangerDraft)]);
    dbMock.dbWrite.image.findUnique.mockResolvedValue({
      user: OWNER,
      type: 'video',
      meta: {},
    } as never);

    await createImageResources({ imageId: IMAGE_ID });

    expect(writtenVersionIds()).toEqual([V.published]);
  });

  it('drops every asserted id when the image cannot be read', async () => {
    arrange([asserted(V.published), hashMatched(V.hashMatchedDraft)], null);

    await createImageResources({ imageId: IMAGE_ID });

    expect(writtenVersionIds()).toEqual([V.hashMatchedDraft]);
  });

  // The bounty callers insert the image in the same transaction, so a read outside it cannot see
  // the image and would drop every asserted id.
  it('inside a transaction, reads through it and drops a private version needing a grant without looking it up', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
    arrange([asserted(V.published), asserted(V.strangerPrivateGranted)], OWNER, tx);

    await createImageResources({
      imageId: IMAGE_ID,
      tx: tx as unknown as Parameters<typeof createImageResources>[0]['tx'],
    });

    expect(hasEntityAccess).not.toHaveBeenCalled();
    expect(writtenVersionIds(tx)).toEqual([V.published]);
  });
});
