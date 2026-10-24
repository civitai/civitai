import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';

// Unit tests for the private-model flow (privateModelFromTraining / publishPrivateModel): it must
// not let an owner change moderation-owned meta, skip the publish gates, or reset cannotPromote.
// Scaffold mirrors model-locked-properties.service.test.ts.

const { mockEvaluateContent, mockThrowOnBlockedLinkDomain, mockGetHighestTierSubscription } =
  vi.hoisted(() => ({
    mockEvaluateContent: vi.fn(),
    mockThrowOnBlockedLinkDomain: vi.fn(),
    mockGetHighestTierSubscription: vi.fn(),
  }));

vi.mock('~/libs/profanity-simple', () => ({
  createProfanityFilter: () => ({ evaluateContent: mockEvaluateContent }),
}));

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
  preventModelVersionLagBatch: vi.fn(),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, Tracker: class {} }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(() => false), FLIPT_FEATURE_FLAGS: {} }));
vi.mock('~/server/metrics', () => ({ modelMetrics: {} }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  modelTagCache: { refresh: vi.fn() },
  modelVotableTagsCache: { bust: vi.fn() },
  userBasicCache: {},
  userModelCountCache: { refresh: vi.fn() },
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: vi.fn(),
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: mockThrowOnBlockedLinkDomain,
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/collection.service', () => ({
  getAvailableCollectionItemsFilterForUser: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  saveItemInCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn(),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getUnavailableResources: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: {},
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: {} }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
  createModelVersionPostFromTraining: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: mockGetHighestTierSubscription,
}));
vi.mock('~/server/services/system-cache', () => ({ getCategoryTags: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  bustFetchThroughCache: vi.fn(),
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObjects: vi.fn() }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: vi.fn() }));
// Pinned per test: 'off' by default keeps the profanity tests about the path they were written for.
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));

import {
  privateModelFromTraining,
  publishPrivateModel,
  toggleCannotPromote,
} from '~/server/services/model.service';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { Availability, ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getTextScanMode } from '~/server/services/text-scan/mode';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODERATOR_ID = 7;
const MODEL_ID = 42;

const cleanEvaluation = {
  shouldMarkNSFW: false,
  reason: 'No profanity detected',
  suggestedLevel: 1,
  metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
  matchedWords: [] as string[],
};

const storedModel = {
  name: 'Test Model',
  description: 'A description',
  poi: false,
  userId: OWNER_ID,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  lockedProperties: [] as string[],
  gallerySettings: { level: 1, users: [] as number[], tags: [] as number[] },
  meta: null as Record<string, unknown> | null,
  availability: 'Public' as string,
  status: 'Draft' as string,
};

function mockStored(overrides: Partial<typeof storedModel> = {}) {
  mockDbWrite.model.findUnique.mockResolvedValue({ ...storedModel, ...overrides });
}

const baseInput = {
  name: 'Test Model',
  description: 'A description',
  type: ModelType.Checkpoint,
  uploadType: ModelUploadType.Created,
  status: ModelStatus.Draft,
} satisfies Partial<ModelUpsertInput>;

function privateFromTraining(
  input: Partial<ModelUpsertInput> & { user: { id: number; isModerator: boolean } }
) {
  return privateModelFromTraining({
    ...baseInput,
    id: MODEL_ID,
    sfwOnly: true,
    ...input,
  } as Parameters<typeof privateModelFromTraining>[0]);
}

function updateData() {
  return mockDbWrite.model.update.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanMode).mockResolvedValue('off');
  mockEvaluateContent.mockReturnValue(cleanEvaluation);
  mockStored();
  mockDbRead.model.count.mockResolvedValue(0);
  mockGetHighestTierSubscription.mockResolvedValue({ tier: 'gold' });
  mockDbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockDbWrite.model.create.mockResolvedValue({
    id: MODEL_ID,
    nsfwLevel: 1,
    meta: null,
    availability: 'Public',
  });
  mockDbWrite.model.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: MODEL_ID,
      name: 'Test Model',
      description: 'A description',
      nsfwLevel: 1,
      poi: false,
      minor: false,
      sfwOnly: false,
      nsfw: false,
      gallerySettings: { level: 1, users: [], tags: [] },
      status: ModelStatus.Draft,
      meta: null,
      availability: 'Public',
      ...data,
      modelVersions: [],
    })
  );
});

const owner = { id: OWNER_ID, isModerator: false };
const moderator = { id: MODERATOR_ID, isModerator: true };

const STORED_MODERATION_META = {
  cannotPromote: false,
  unpublishedReason: 'other',
  unpublishedAt: '2026-01-01T00:00:00.000Z',
  unpublishedBy: 9,
  declinedReason: 'duplicate',
  declinedAt: '2026-01-02T00:00:00.000Z',
  takenDownAt: '2026-01-03T00:00:00.000Z',
  takenDownBy: 9,
  archivedAt: '2026-01-04T00:00:00.000Z',
  archivedBy: 9,
  minorFlagSnapshot: { source: 'auto', prevMinorImageIds: [1] },
  textScanFlags: { minor: { open: true } },
  textModeration: { policy: 'x' },
  trainingStudioWorkflowId: 'wf-1',
};

function writtenMeta() {
  return updateData().meta as Record<string, unknown>;
}

describe('privateModelFromTraining — moderation-owned meta', () => {
  it('keeps every stored moderation-owned and flow key when a non-moderator sends none', async () => {
    mockStored({ meta: STORED_MODERATION_META });

    await privateFromTraining({ user: owner, meta: { commentsLocked: true } });

    expect(writtenMeta()).toMatchObject({
      ...STORED_MODERATION_META,
      commentsLocked: true,
      cannotPromote: true,
    });
  });

  it('ignores moderation-owned and flow keys the client sends', async () => {
    mockStored({ meta: { declinedReason: 'duplicate', minorFlagSnapshot: { source: 'auto' } } });

    await privateFromTraining({
      user: owner,
      meta: {
        declinedReason: 'forged',
        unpublishedReason: 'forged',
        archivedAt: 'forged',
        takenDownAt: 'forged',
        textScanFlags: { forged: true },
        minorFlagSnapshot: { source: 'forged' },
      } as never,
    });

    const meta = writtenMeta();
    expect(meta.declinedReason).toBe('duplicate');
    expect(meta.minorFlagSnapshot).toEqual({ source: 'auto' });
    expect(meta).not.toHaveProperty('unpublishedReason');
    expect(meta).not.toHaveProperty('archivedAt');
    expect(meta).not.toHaveProperty('takenDownAt');
    expect(meta).not.toHaveProperty('textScanFlags');
  });

  it('keeps passing client meta through for a moderator', async () => {
    mockStored({ meta: null });

    await privateFromTraining({
      user: moderator,
      meta: { declinedReason: 'by mod', commentsLocked: true } as never,
    });

    expect(writtenMeta()).toMatchObject({
      declinedReason: 'by mod',
      commentsLocked: true,
      cannotPromote: true,
    });
  });

  // The form hides these keys from moderators too, so their save never echoes them back.
  it('keeps the hidden moderation-owned keys a moderator cannot see', async () => {
    mockStored({ meta: STORED_MODERATION_META });

    await privateFromTraining({ user: moderator, meta: { declinedReason: 'by mod' } as never });

    const meta = writtenMeta();
    expect(meta.minorFlagSnapshot).toEqual(STORED_MODERATION_META.minorFlagSnapshot);
    expect(meta.textScanFlags).toEqual(STORED_MODERATION_META.textScanFlags);
    expect(meta.textModeration).toEqual(STORED_MODERATION_META.textModeration);
    expect(meta.declinedReason).toBe('by mod');
    expect(meta).not.toHaveProperty('takenDownAt');
  });
});

describe('privateModelFromTraining — publish gates', () => {
  it.each(['UnpublishedViolation', 'Deleted'])(
    'refuses a non-moderator when the stored status is %s',
    async (status) => {
      mockStored({ status });

      await expect(privateFromTraining({ user: owner })).rejects.toThrow();
      expect(mockDbWrite.model.update).not.toHaveBeenCalled();
    }
  );

  it('refuses a non-moderator when the stored meta says cannotPublish', async () => {
    mockStored({ meta: { cannotPublish: true } });

    await expect(privateFromTraining({ user: owner })).rejects.toThrow();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('lets a moderator through the cannotPublish gate', async () => {
    mockStored({ meta: { cannotPublish: true } });

    await expect(privateFromTraining({ user: moderator })).resolves.toBeTruthy();
    expect(mockDbWrite.model.update).toHaveBeenCalledTimes(1);
  });

  // Ruled by the Moderation Lead (hq:ky1cf68gw8ec): this flow does not restore a taken-down model,
  // whoever runs it. Restoring one is its own moderator action.
  it.each(['UnpublishedViolation', 'Deleted'])(
    'refuses a moderator too when the stored status is %s',
    async (status) => {
      mockStored({ status });

      await expect(privateFromTraining({ user: moderator })).rejects.toThrow();
      expect(mockDbWrite.model.update).not.toHaveBeenCalled();
    }
  );

  it.each(['Draft', 'Unpublished'])('still lets an owner through from %s', async (status) => {
    mockStored({ status });

    await expect(privateFromTraining({ user: owner })).resolves.toBeTruthy();
  });
});

describe('cannotPromote across a private cycle', () => {
  it('records a moderator-set cannotPromote before forcing it', async () => {
    mockStored({ meta: { cannotPromote: true } });

    await privateFromTraining({ user: owner });

    expect(writtenMeta()).toMatchObject({ cannotPromote: true, restoreCannotPromote: true });
  });

  it('records nothing when the model was promotable', async () => {
    mockStored({ meta: { cannotPromote: false } });

    await privateFromTraining({ user: owner });

    const meta = writtenMeta();
    expect(meta.cannotPromote).toBe(true);
    expect(meta).not.toHaveProperty('restoreCannotPromote');
  });

  it('does not mistake the forced value for a moderator ban when re-run on a private model', async () => {
    mockStored({ availability: Availability.Private, meta: { cannotPromote: true } });

    await privateFromTraining({ user: owner });

    expect(writtenMeta()).not.toHaveProperty('restoreCannotPromote');
  });

  it('never accepts the restore marker from the client', async () => {
    mockStored({ meta: null });

    await privateFromTraining({ user: owner, meta: { restoreCannotPromote: true } as never });

    expect(writtenMeta()).not.toHaveProperty('restoreCannotPromote');
  });
});

describe('privateModelFromTraining — stored snapshot', () => {
  it('reads the stored row from the primary, never the replica', async () => {
    await privateFromTraining({ user: owner });

    expect(mockDbRead.model.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MODEL_ID } })
    );
  });
});

describe('toggleCannotPromote on a private model', () => {
  const toggle = () => toggleCannotPromote({ id: MODEL_ID, isModerator: true });
  const mockPrivate = (meta: Record<string, unknown>) =>
    mockDbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      availability: Availability.Private,
      meta,
    });

  it('reads the stored row from the primary', async () => {
    mockPrivate({ cannotPromote: true });

    await toggle();

    expect(mockDbRead.model.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.model.findUnique).toHaveBeenCalled();
  });

  it('records a ban for publish while keeping cannotPromote forced on', async () => {
    mockPrivate({ cannotPromote: true });

    await toggle();

    expect(updateData().meta).toEqual({ cannotPromote: true, restoreCannotPromote: true });
  });

  it('drops the recorded ban on an unban while keeping cannotPromote forced on', async () => {
    mockPrivate({ cannotPromote: true, restoreCannotPromote: true });

    await toggle();

    const meta = updateData().meta as Record<string, unknown>;
    expect(meta.cannotPromote).toBe(true);
    expect(meta).not.toHaveProperty('restoreCannotPromote');
  });

  it('still toggles a public model directly', async () => {
    mockDbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      availability: Availability.Public,
      meta: { cannotPromote: false },
    });

    await toggle();

    expect(updateData().meta).toEqual({ cannotPromote: true });
  });
});

describe('publishPrivateModel', () => {
  function mockPrivateModel(overrides: { status?: string; meta?: Record<string, unknown> | null }) {
    mockDbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      availability: Availability.Private,
      status: ModelStatus.Published,
      meta: null,
      ...overrides,
    });
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 1 }]);
    // The in-transaction re-read: the version is still Published, the model is not taken down.
    mockDbWrite.$queryRaw.mockImplementation((async (strings: string[]) =>
      strings.join('').includes('FROM "ModelVersion"') ? [{ id: 1 }] : []) as never);
    mockDbWrite.post.findMany.mockResolvedValue([{ modelVersionId: 1 }]);
    mockDbRead.image.findMany.mockResolvedValue([]);
  }

  const publish = (isModerator: boolean, publishVersions = true) =>
    publishPrivateModel({ modelId: MODEL_ID, publishVersions, isModerator });

  it('restores a moderator-set cannotPromote and drops the marker', async () => {
    mockPrivateModel({ meta: { cannotPromote: true, restoreCannotPromote: true } });

    await publish(false);

    const meta = updateData().meta as Record<string, unknown>;
    expect(meta.cannotPromote).toBe(true);
    expect(meta).not.toHaveProperty('restoreCannotPromote');
  });

  // The checks above run before the write transaction; a takedown can land in between.
  const takenDownMeanwhile = ({ model = false, versions = [{ id: 1 }] }) =>
    mockDbWrite.$queryRaw.mockImplementation((async (strings: string[]) =>
      strings.join('').includes('FROM "ModelVersion"') ? versions : [{ downed: model }]) as never);

  it('refuses a version taken down after it was read, and writes nothing', async () => {
    mockPrivateModel({});
    takenDownMeanwhile({ versions: [] });

    await expect(publish(false)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses the owner when the model was taken down after it was read', async () => {
    mockPrivateModel({});
    takenDownMeanwhile({ model: true });

    await expect(publish(false)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('still lets a moderator publish a model taken down after it was read', async () => {
    mockPrivateModel({});
    takenDownMeanwhile({ model: true });

    await expect(publish(true)).resolves.toEqual({ versionIds: [1], held: false });
  });

  it("republishes only the owner's posts", async () => {
    mockPrivateModel({});

    await publish(false);
    const republish = mockDbWrite.$executeRaw.mock.calls
      .map(([strings]) => (strings as string[]).join('?'))
      .find((sql) => sql.includes('UPDATE "Post"'));
    expect(republish).toMatch(/"userId" = \?/);
  });

  it('reads the stored row from the primary, never the replica', async () => {
    mockPrivateModel({});

    await publish(false);

    expect(mockDbRead.model.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MODEL_ID } })
    );
  });

  it('publishes with the moderator ban recorded while private', async () => {
    mockPrivateModel({ meta: { cannotPromote: true, restoreCannotPromote: true } });

    await publish(false);

    expect((updateData().meta as Record<string, unknown>).cannotPromote).toBe(true);
  });

  it('makes the model promotable again when nothing was recorded', async () => {
    mockPrivateModel({ meta: { cannotPromote: true } });

    await publish(false);

    const meta = updateData().meta as Record<string, unknown>;
    expect(meta.cannotPromote).toBe(false);
    expect(meta).not.toHaveProperty('restoreCannotPromote');
  });

  it.each([ModelStatus.UnpublishedViolation, ModelStatus.Deleted])(
    'refuses a non-moderator when the stored status is %s, with or without publishing versions',
    async (status) => {
      mockPrivateModel({ status });

      await expect(publish(false)).rejects.toThrow();
      await expect(publish(false, false)).rejects.toThrow();
      expect(mockDbWrite.model.update).not.toHaveBeenCalled();
    }
  );

  it('refuses a non-moderator when the stored meta says cannotPublish', async () => {
    mockPrivateModel({ meta: { cannotPublish: true } });

    await expect(publish(false)).rejects.toThrow();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('lets a moderator through both gates', async () => {
    mockPrivateModel({ status: ModelStatus.UnpublishedViolation, meta: { cannotPublish: true } });

    await expect(publish(true)).resolves.toEqual({ versionIds: [1], held: false });
    expect(mockDbWrite.model.update).toHaveBeenCalledTimes(1);
  });

  it('publishes a clean private model for its owner', async () => {
    mockPrivateModel({});

    await expect(publish(false)).resolves.toEqual({ versionIds: [1], held: false });
  });
});
