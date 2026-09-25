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

function arrange(rows: unknown[], owner: { id: number; isModerator: boolean } = OWNER) {
  dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows).mockResolvedValue([]);
  dbMock.dbWrite.image.findUnique.mockResolvedValue({ user: owner, meta: {} } as never);
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async (args: {
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
          userId === owner.id &&
          isModerator === owner.isModerator,
      }))
  );
}

/** The version ids in the ImageResourceNew upsert, or null when no upsert ran. */
function writtenVersionIds(): number[] | null {
  const insert = dbMock.dbWrite.$queryRaw.mock.calls
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

  it('inside a transaction, drops a private version that needs a grant without looking it up', async () => {
    arrange([asserted(V.published), asserted(V.strangerPrivateGranted)]);

    await createImageResources({
      imageId: IMAGE_ID,
      tx: dbMock.dbWrite as unknown as Parameters<typeof createImageResources>[0]['tx'],
    });

    expect(hasEntityAccess).not.toHaveBeenCalled();
    expect(writtenVersionIds()).toEqual([V.published]);
  });
});
