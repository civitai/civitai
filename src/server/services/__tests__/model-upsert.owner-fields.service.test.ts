import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as AppealTextHash from '~/server/services/text-scan/actions/appeal-text-hash';
import type * as ModelNsfw from '~/server/services/text-scan/actions/model-nsfw';
import type * as ModelCoverService from '~/server/services/model-cover.service';
import type * as ComFaceRecheck from '~/server/services/model-com-face-recheck.service';
import type * as TextScanPreview from '~/server/services/text-scan/preview';
import type { TextScanField } from '~/server/services/text-scan/types';

// Unit tests for upsertModel's owner-writable fields: moderation-owned meta and availability.
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
  bustUserSettings: vi.fn(),
  patchUserSettings: vi.fn(),
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  bustFetchThroughCache: vi.fn(),
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObjects: vi.fn() }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: vi.fn() }));
// Pinned per test: 'off' by default keeps the profanity tests about the path they were written for.
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
const { mockAssertCoverImagesValid } = vi.hoisted(() => ({
  mockAssertCoverImagesValid: vi.fn(),
}));
vi.mock('~/server/services/model-cover.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCoverService>()),
  assertCoverImagesValid: mockAssertCoverImagesValid,
}));
const { mockQueueComFaceRecheck, mockQueueComFaceRestore } = vi.hoisted(() => ({
  mockQueueComFaceRecheck: vi.fn(),
  mockQueueComFaceRestore: vi.fn(),
}));
vi.mock('~/server/services/model-com-face-recheck.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ComFaceRecheck>()),
  queueComFaceRecheck: mockQueueComFaceRecheck,
  queueComFaceRestore: mockQueueComFaceRestore,
}));
const { mockPreviewComFaceIntent, mockPreviewTextScanNsfw } = vi.hoisted(() => ({
  mockPreviewComFaceIntent: vi.fn(),
  mockPreviewTextScanNsfw: vi.fn(),
}));
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewComFaceIntent: mockPreviewComFaceIntent,
  previewTextScanNsfw: mockPreviewTextScanNsfw,
}));
const { mockSettleAppeals } = vi.hoisted(() => ({ mockSettleAppeals: vi.fn() }));
vi.mock('~/server/services/text-scan/actions/appeal-text-hash', async (importOriginal) => ({
  ...(await importOriginal<typeof AppealTextHash>()),
  settleFlagAppealsAfterModeratorLift: mockSettleAppeals,
}));
const {
  mockApplyHeldVerdict,
  mockLeavingPrivate,
  mockFinishApply,
  mockDropLiftedBy,
  mockHoldLead,
  mockHoldLeadAfterSfwOnlyLift,
} = vi.hoisted(() => ({
  mockHoldLeadAfterSfwOnlyLift: vi.fn(async (..._args: unknown[]) => undefined),
  mockDropLiftedBy: vi.fn(async (..._args: unknown[]) => undefined),
  mockHoldLead: vi.fn(async (..._args: unknown[]) => undefined),
  mockApplyHeldVerdict: vi.fn(async (): Promise<null> => null),
  mockLeavingPrivate: vi.fn(async (_db: unknown, _id: number) => false),
  mockFinishApply: vi.fn(async (_id: number) => undefined),
}));
vi.mock('~/server/services/text-scan/actions/model-nsfw', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelNsfw>()),
  applyHeldRestrictedVerdict: mockApplyHeldVerdict,
  applyHeldVerdictLeavingPrivate: mockLeavingPrivate,
  finishHeldVerdictApply: mockFinishApply,
  dropLiftedBy: mockDropLiftedBy,
  holdLeadAfterFlagLift: mockHoldLead,
  holdLeadAfterSfwOnlyLift: mockHoldLeadAfterSfwOnlyLift,
}));
import { MODERATION_FLOW_META_KEYS } from '~/server/utils/minor-flag-meta';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { Availability } from '~/shared/utils/prisma/enums';
import type { ModelMeta, ModelUpsertInput } from '~/server/schema/model.schema';
import {
  comFaceIntentTextHash,
  reusableComFaceIntent,
} from '~/server/services/model-com-face-intent.service';
import {
  copyGallerySettingsToAllModelsByUser,
  heldGalleryLevel,
  upsertModel,
} from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { trackModActivity } from '~/server/services/moderator.service';
import { recordedOwnership } from './model-ownership-db';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODERATOR_ID = 7;
const MODEL_ID = 42;

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
  availability: Availability.Public as Availability,
  status: ModelStatus.Published as ModelStatus,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  allowNoCredit: true,
  allowCommercialUse: ['Image'] as string[],
  allowDerivatives: true,
  allowDifferentLicense: false,
  coverImageId: null as number | null,
  sfwName: null as string | null,
  sfwCoverImageId: null as number | null,
};

// The row the save's transaction locks: the same as the first read unless a test says otherwise.
let lockedRow: Partial<typeof storedModel> | null = null;
let lockHeld = false;
const isModelLock = (strings: TemplateStringsArray, values: unknown[]) =>
  Array.isArray(strings) &&
  /FROM "Model"\s+WHERE id = \?\s+FOR NO KEY UPDATE/.test(strings.join('?')) &&
  values[0] === MODEL_ID;

function mockStored(overrides: Partial<typeof storedModel> = {}) {
  const firstRow = { ...storedModel, ...overrides };
  lockedRow = firstRow;
  mockDbWrite.model.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
    where.id === MODEL_ID ? (lockHeld ? lockedRow : firstRow) : null) as never);
}

/** What a write that landed after the save's first read left in the row it then locks. */
function mockLocked(overrides: Partial<typeof storedModel>) {
  lockedRow = { ...lockedRow, ...overrides };
}

const baseInput = {
  name: 'Test Model',
  description: 'A description',
  type: ModelType.Checkpoint,
  uploadType: ModelUploadType.Created,
  status: ModelStatus.Draft,
} satisfies Partial<ModelUpsertInput>;

function upsert(input: Partial<ModelUpsertInput> & { userId: number; isModerator?: boolean }) {
  return upsertModel({ ...baseInput, ...input } as Parameters<typeof upsertModel>[0]);
}

function updateData() {
  return mockDbWrite.model.update.mock.calls[0][0].data as Record<string, unknown>;
}

function createData() {
  return mockDbWrite.model.create.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  lockHeld = false;
  vi.mocked(getTextScanMode).mockResolvedValue('off');
  mockEvaluateContent.mockReturnValue({
    shouldMarkNSFW: false,
    reason: 'No profanity detected',
    suggestedLevel: 1,
    metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
    matchedWords: [],
  });
  mockStored();
  mockDbRead.model.count.mockResolvedValue(0);
  mockGetHighestTierSubscription.mockResolvedValue({ tier: 'gold' });
  mockDbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockDbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (isModelLock(strings, values)) lockHeld = true;
    return [];
  }) as never);
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
      status: ModelStatus.Published,
      meta: null,
      availability: 'Public',
      ...data,
      modelVersions: [],
    })
  );
});

const FLOW_KEYS = [
  'cannotPublish',
  'cannotPromote',
  'unpublishedReason',
  'unpublishedAt',
  'unpublishedBy',
  'customMessage',
  'needsReview',
  'declinedReason',
  'declinedAt',
  'takenDownAt',
  'takenDownBy',
  'archivedAt',
  'archivedBy',
] as const;

const FORGED = {
  cannotPublish: false,
  cannotPromote: false,
  unpublishedReason: 'forged',
  unpublishedAt: '2000-01-01T00:00:00.000Z',
  unpublishedBy: 999,
  customMessage: 'forged',
  needsReview: false,
  declinedReason: 'forged',
  declinedAt: '2000-01-01T00:00:00.000Z',
  takenDownAt: '2000-01-01T00:00:00.000Z',
  takenDownBy: 999,
  archivedAt: '2000-01-01T00:00:00.000Z',
  archivedBy: 999,
};

const STORED_FLOW_META = {
  cannotPublish: true,
  cannotPromote: true,
  unpublishedReason: 'violation',
  unpublishedAt: '2026-01-01T00:00:00.000Z',
  unpublishedBy: MODERATOR_ID,
  customMessage: 'stored',
  needsReview: true,
  declinedReason: 'stored',
  declinedAt: '2026-01-01T00:00:00.000Z',
  takenDownAt: '2026-01-01T00:00:00.000Z',
  takenDownBy: MODERATOR_ID,
  archivedAt: '2026-01-01T00:00:00.000Z',
  archivedBy: MODERATOR_ID,
};

describe('moderation-flow meta keys', () => {
  it('covers every key a moderation flow writes', () => {
    expect([...MODERATION_FLOW_META_KEYS].sort()).toEqual([...FLOW_KEYS].sort());
  });

  it('preserves stored values when a non-moderator update sends them back changed', async () => {
    mockStored({ meta: { ...STORED_FLOW_META, hideBuzz: false } });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { ...FORGED, hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ ...STORED_FLOW_META, hideBuzz: true });
  });

  it('does not let a non-moderator update add a flow key the model never had', async () => {
    mockStored({ meta: null });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { ...FORGED, hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ hideBuzz: true });
  });

  it('drops flow keys from a non-moderator create and keeps owner keys', async () => {
    await upsert({
      userId: OWNER_ID,
      meta: { ...FORGED, hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(createData().meta).toEqual({ hideBuzz: true, bountyId: undefined });
  });

  it('lets a moderator write flow keys through upsert as before', async () => {
    mockStored({ meta: STORED_FLOW_META });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { cannotPublish: false } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ ...STORED_FLOW_META, cannotPublish: false });
  });
});

// A content wipe's removal record: client meta can neither set nor change it, a moderator's included
// (their edit form sends stored meta back, which could put a stale record onto a live model).
describe('removal record keys', () => {
  const RECORD = {
    removedWithOwner: true,
    statusBeforeRemoval: 'Published',
    versionsUnpublishedByRemoval: [{ id: 1, status: 'Published' }],
  };

  it.each([
    ['an owner', OWNER_ID, false],
    ['a moderator', MODERATOR_ID, true],
  ])('drops them from %s’s meta on a model without them', async (_, userId, isModerator) => {
    mockStored({ meta: {} });
    await upsert({
      id: MODEL_ID,
      userId,
      isModerator,
      meta: { ...RECORD, hideBuzz: true } as ModelUpsertInput['meta'],
    });
    expect(updateData().meta).toEqual({ hideBuzz: true });
  });

  it('keeps the stored record when a moderator saves different values', async () => {
    mockStored({ meta: RECORD });
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { removedWithOwner: false, statusBeforeRemoval: 'Draft' } as ModelUpsertInput['meta'],
    });
    expect(updateData().meta).toEqual(RECORD);
  });
});

// The .com re-check's record that it took the model off civitai.com. If client meta could clear it,
// the owner would lose the notice; if it could forge one, the owner would see a removal that never happened.
describe('comFaceRemoved', () => {
  const MARKER = { at: '2026-11-05T00:00:00.000Z', sfwCoverImageId: 5, reason: 'detected' };

  it.each([
    ['an owner', OWNER_ID, false],
    ['a moderator', MODERATOR_ID, true],
  ])('is dropped from %s’s meta on a model without it', async (_, userId, isModerator) => {
    mockStored({ meta: {} });
    await upsert({
      id: MODEL_ID,
      userId,
      isModerator,
      meta: { comFaceRemoved: MARKER, hideBuzz: true } as ModelUpsertInput['meta'],
    });
    expect(updateData().meta).toEqual({ hideBuzz: true });
  });

  it.each([
    ['an owner clears', OWNER_ID, false, null],
    ['a moderator clears', MODERATOR_ID, true, null],
    ['an owner rewrites', OWNER_ID, false, { ...MARKER, sfwCoverImageId: 999 }],
  ])('keeps the stored marker when %s it', async (_, userId, isModerator, sent) => {
    mockStored({ meta: { comFaceRemoved: MARKER } });
    await upsert({
      id: MODEL_ID,
      userId,
      isModerator,
      meta: { comFaceRemoved: sent, hideBuzz: true } as ModelUpsertInput['meta'],
    });
    expect(updateData().meta).toEqual({ comFaceRemoved: MARKER, hideBuzz: true });
  });
});

// A moderator's unlock is a ruling on this listing: the intent check must not lock it again.
describe('a moderator lifting the nsfw lock', () => {
  const words = ['trigger'];
  const listingHash = comFaceIntentTextHash({
    name: storedModel.name,
    description: storedModel.description,
    triggerWords: words,
  });
  const detection = {
    detected: true,
    reason: 'r',
    textHash: listingHash,
    at: '2026-11-01T00:00:00.000Z',
    priorSystemNsfwLock: { source: 'text-scan', at: '2026-10-01T00:00:00.000Z' },
    laterVerdict: { source: 'xguard-text-moderation', at: '2026-11-02T00:00:00.000Z' },
  };

  beforeEach(() => {
    mockDbWrite.modelVersion.findMany.mockImplementation((async (args: {
      select?: { trainedWords?: boolean };
    }) => (args.select?.trainedWords ? [{ trainedWords: words }] : [])) as never);
  });

  const unlock = () =>
    upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, lockedProperties: [] });

  it('overturns the stored detection of the listing as it stands', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'], meta: { comFaceIntent: detection } });
    await unlock();
    const meta = updateData().meta as ModelMeta;
    expect(meta.comFaceIntent).toMatchObject({ detected: true, textHash: listingHash });
    expect(meta.comFaceIntent?.overturnedAt).toEqual(expect.any(String));
    expect(meta.comFaceIntent).not.toHaveProperty('priorSystemNsfwLock');
    expect(meta.comFaceIntent).not.toHaveProperty('laterVerdict');
    expect(reusableComFaceIntent(meta, listingHash)).toEqual({ detected: false, reason: 'r' });
  });

  it.each([
    ['no stored verdict', {}],
    ['a verdict on other text', { comFaceIntent: { ...detection, textHash: 'old' } }],
  ])('stores the listing as allowed when there is %s', async (_, meta) => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'], meta });
    await unlock();
    const written = updateData().meta as ModelMeta;
    expect(written.comFaceIntent).toMatchObject({ detected: false, textHash: listingHash });
    expect(written.comFaceIntent?.overturnedAt).toEqual(expect.any(String));
  });

  // The ruling covers the listing this save leaves, not the one it replaced.
  it('rules on the edited listing when the unlock save also edits it', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'], meta: { comFaceIntent: detection } });
    const edited = { name: 'Renamed', description: 'Rewritten' };
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      lockedProperties: [],
      ...edited,
    });
    const editedHash = comFaceIntentTextHash({ ...edited, triggerWords: words });
    const meta = updateData().meta as ModelMeta;
    expect(meta.comFaceIntent).toMatchObject({ detected: false, textHash: editedHash });
    expect(reusableComFaceIntent(meta, editedHash)).toEqual({ detected: false });
    expect(reusableComFaceIntent(meta, listingHash)).toBeNull();
  });

  it("leaves the verdict alone on an owner's save (control)", async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'], meta: { comFaceIntent: detection } });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, lockedProperties: [] });
    expect((updateData().meta as ModelMeta).comFaceIntent).toEqual(detection);
  });

  it('leaves the verdict alone when the save keeps the lock (control)', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'], meta: { comFaceIntent: detection } });
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      lockedProperties: ['nsfw'],
    });
    expect((updateData().meta as ModelMeta).comFaceIntent).toEqual(detection);
  });
});

describe('the locked row', () => {
  const RECORD = {
    removedWithOwner: true,
    statusBeforeRemoval: 'Published',
    versionsUnpublishedByRemoval: [{ id: 1, status: 'Published' }],
  };

  it('refuses an owner’s save of a model a content wipe kept, writing nothing', async () => {
    mockStored({ meta: RECORD });
    await expect(upsert({ id: MODEL_ID, userId: OWNER_ID })).rejects.toThrow(/not authorized/);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses it when the wipe kept the model after the save read it', async () => {
    mockStored({ meta: {} });
    mockLocked({ meta: RECORD });
    await expect(upsert({ id: MODEL_ID, userId: OWNER_ID })).rejects.toThrow(/not authorized/);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('keeps the record a wipe wrote after a moderator’s save read the model', async () => {
    mockStored({ meta: {} });
    mockLocked({ meta: RECORD });
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { hideBuzz: true } as ModelUpsertInput['meta'],
    });
    expect(updateData().meta).toEqual({ ...RECORD, hideBuzz: true });
  });

  it('keeps a moderation key written after an owner’s save read the model', async () => {
    mockStored({ meta: {} });
    mockLocked({ meta: { cannotPublish: true } });
    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { hideBuzz: true } as ModelUpsertInput['meta'],
    });
    expect(updateData().meta).toEqual({ cannotPublish: true, hideBuzz: true });
  });

  it('refuses an owner’s stale availability once the model was made private after the read', async () => {
    mockStored({ availability: Availability.Public });
    mockLocked({ availability: Availability.Private });
    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Public })
    ).rejects.toThrow(/availability/);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('writes the owner’s meta over the row it read (control)', async () => {
    mockStored({ meta: { hideDownloads: true } });
    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { hideBuzz: true } as ModelUpsertInput['meta'],
    });
    expect(updateData().meta).toEqual({ hideDownloads: true, hideBuzz: true });
  });
});

describe('stored snapshot', () => {
  it('reads the stored row from the primary, never the replica', async () => {
    await upsert({ id: MODEL_ID, userId: OWNER_ID });

    expect(mockDbRead.model.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MODEL_ID } })
    );
  });
});

describe('cannotPromote on a private model', () => {
  const privateStored = (meta: Record<string, unknown>) =>
    mockStored({ availability: Availability.Private, meta });

  it('keeps cannotPromote forced on and records a moderator ban for publish', async () => {
    privateStored({ cannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { cannotPromote: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ cannotPromote: true, restoreCannotPromote: true });
  });

  it('records a moderator ban set after the save read the model', async () => {
    privateStored({ cannotPromote: true });
    mockLocked({ meta: { cannotPromote: true, restoreCannotPromote: true } });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true });

    expect(updateData().meta).toEqual({ cannotPromote: true, restoreCannotPromote: true });
  });

  it('keeps cannotPromote forced on for a model made private after the save read it', async () => {
    mockStored({ availability: Availability.Public, meta: {} });
    mockLocked({ availability: Availability.Private, meta: { cannotPromote: true } });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { cannotPromote: false } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ cannotPromote: true });
  });

  it('keeps cannotPromote forced on and drops the marker on a moderator unban', async () => {
    privateStored({ cannotPromote: true, restoreCannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { cannotPromote: false } as ModelUpsertInput['meta'],
    });

    const meta = updateData().meta as Record<string, unknown>;
    expect(meta.cannotPromote).toBe(true);
    expect(meta).not.toHaveProperty('restoreCannotPromote');
  });

  it('leaves the marker alone when the moderator does not send cannotPromote', async () => {
    privateStored({ cannotPromote: true, restoreCannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({
      cannotPromote: true,
      restoreCannotPromote: true,
      hideBuzz: true,
    });
  });

  it('never lets the client author the marker', async () => {
    privateStored({ cannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { restoreCannotPromote: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ cannotPromote: true });
  });
});

describe('availability', () => {
  it('refuses a non-moderator Private to Public change on a published model', async () => {
    mockStored({ availability: Availability.Private });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Public })
    ).rejects.toThrow(/publish/i);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator Public to Private change on a published model', async () => {
    mockStored({ availability: Availability.Public });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Private, sfwOnly: true })
    ).rejects.toThrow(/private/i);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('accepts replaying the stored availability on a published model', async () => {
    mockStored({ availability: Availability.Private });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Private });

    expect(mockDbWrite.model.update).toHaveBeenCalledTimes(1);
  });

  it('lets a moderator change availability on a published model', async () => {
    mockStored({ availability: Availability.Private });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      availability: Availability.Public,
    });

    expect(updateData().availability).toBe(Availability.Public);
  });

  it('refuses a non-moderator availability change on a Draft model too', async () => {
    mockStored({ availability: Availability.Public, status: ModelStatus.Draft });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Private, sfwOnly: true })
    ).rejects.toThrow(/private/i);

    mockStored({ availability: Availability.Private, status: ModelStatus.Draft });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Public })
    ).rejects.toThrow(/private/i);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator Private create', async () => {
    await expect(
      upsert({ userId: OWNER_ID, availability: Availability.Private, sfwOnly: true })
    ).rejects.toThrow(/private/i);
    expect(mockDbWrite.model.create).not.toHaveBeenCalled();
  });

  it('lets a moderator create a Private model', async () => {
    mockGetHighestTierSubscription.mockResolvedValue(null);

    await upsert({
      userId: MODERATOR_ID,
      isModerator: true,
      availability: Availability.Private,
      sfwOnly: true,
    });

    expect(createData().availability).toBe(Availability.Private);
  });

  it('leaves a Public create alone', async () => {
    mockGetHighestTierSubscription.mockResolvedValue(null);

    await upsert({ userId: OWNER_ID, availability: Availability.Public });

    expect(createData().availability).toBe(Availability.Public);
  });

  it('records the creator as the first owner of the new model, in the create transaction', async () => {
    mockGetHighestTierSubscription.mockResolvedValue(null);
    mockDbWrite.model.create.mockResolvedValueOnce({
      id: 4242,
      nsfwLevel: 0,
      meta: null,
      availability: Availability.Public,
    } as never);
    // A distinct client with its own raw writer, so a write on dbWrite would not pass for one on it.
    const txExecuteRaw = vi.fn(async () => 1);
    const tx = new Proxy(mockDbWrite, {
      get: (target, key) =>
        key === '$executeRaw' ? txExecuteRaw : (target as Record<string | symbol, unknown>)[key],
    });
    mockDbWrite.$transaction.mockImplementationOnce(async (fn: (client: unknown) => unknown) =>
      fn(tx)
    );

    await upsert({ userId: OWNER_ID, availability: Availability.Public });

    const ownership = (txExecuteRaw.mock.calls as unknown as [Prisma.Sql][])
      .map(([sql]) => sql)
      .find((sql) => sql.sql.includes('"ModelOwnership"'));
    expect(ownership, 'no ownership row written in the transaction').toBeDefined();
    expect(
      await recordedOwnership(
        [
          [4242, OWNER_ID],
          [4243, OWNER_ID],
        ],
        [ownership!]
      )
    ).toEqual([{ modelId: 4242, userId: OWNER_ID, reason: 'create', actorId: OWNER_ID }]);
  });
});

describe('flag appeals settled by a moderator save', () => {
  it('settles the poi appeal when a moderator turns poi off', async () => {
    mockStored({ poi: true });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: false });

    expect(mockSettleAppeals).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      userId: MODERATOR_ID,
      liftedLabels: ['poi'],
    });
    expect(mockSettleAppeals.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDbWrite.model.update.mock.invocationCallOrder[0]
    );
  });

  it('names every label the save lifted', async () => {
    mockStored({ poi: true, minor: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      poi: false,
      minor: false,
    });

    expect(mockSettleAppeals).toHaveBeenCalledWith(
      expect.objectContaining({ liftedLabels: ['minor', 'poi'] })
    );
  });

  it('settles nothing when no flag went from set to unset', async () => {
    mockStored({ poi: true });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: true });
    mockStored({ poi: false });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: false });

    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });

  it('settles nothing for a flag the moderator did not set, even if another path cleared it', async () => {
    mockStored({ poi: true });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true });

    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });

  it('never settles for the owner, whose locks keep the flag in force', async () => {
    mockStored({ poi: true, lockedProperties: ['poi'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: false });

    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });
});

describe('real-person hash state on a save', () => {
  const wroteKey = (key: string) =>
    mockDbWrite.$executeRaw.mock.calls.some(([strings, ...values]) =>
      Prisma.sql(strings as TemplateStringsArray, ...(values as never[])).values.includes(key)
    );

  // Otherwise the nightly sweep puts back a flag the moderator just lifted in the edit form.
  it('a moderator lifting poi stamps the model cleared', async () => {
    mockStored({ poi: true });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: false });
    expect(wroteKey('poiHashCleared')).toBe(true);
  });

  it('a moderator setting poi takes the model off the match queue', async () => {
    mockStored({ poi: false });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: true });
    expect(wroteKey('poiHashMatch')).toBe(true);
    expect(wroteKey('poiHashCleared')).toBe(false);
  });

  it('an owner turning a self-declared poi off does not clear the model for the match', async () => {
    mockStored({ poi: true, lockedProperties: [] });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: false });
    expect(wroteKey('poiHashCleared')).toBe(false);
  });

  it('an owner ticking poi does not take the model off the match queue', async () => {
    mockStored({ poi: false, lockedProperties: [] });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: true });
    expect(wroteKey('poiHashMatch')).toBe(false);
  });

  it('a save that leaves poi alone touches neither', async () => {
    mockStored({ poi: true });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true });
    expect(wroteKey('poiHashCleared')).toBe(false);
    expect(wroteKey('poiHashMatch')).toBe(false);
  });
});

describe('merge permissions on save', () => {
  it('stores "different permissions" off when the owner saves with merges off', async () => {
    mockStored({ allowDerivatives: true, allowDifferentLicense: true } as Partial<
      typeof storedModel
    >);

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      allowDerivatives: false,
      allowDifferentLicense: true,
    });

    expect(updateData()).toMatchObject({ allowDerivatives: false, allowDifferentLicense: false });
  });

  it('does the same on create', async () => {
    await upsert({ userId: OWNER_ID, allowDerivatives: false, allowDifferentLicense: true });

    expect(createData()).toMatchObject({ allowDerivatives: false, allowDifferentLicense: false });
  });

  it('control: keeps it on while merges are allowed', async () => {
    mockStored({ allowDerivatives: false, allowDifferentLicense: false } as Partial<
      typeof storedModel
    >);

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      allowDerivatives: true,
      allowDifferentLicense: true,
    });

    expect(updateData()).toMatchObject({ allowDerivatives: true, allowDifferentLicense: true });
  });
});

describe('permission snapshots', () => {
  it('records a permission change in the save transaction', async () => {
    mockStored();
    mockDbWrite.modelPermissionSnapshot.findFirst.mockResolvedValue(null);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, allowDerivatives: false });

    expect(mockDbWrite.modelPermissionSnapshot.createMany).toHaveBeenCalledTimes(1);
    const { data } = mockDbWrite.modelPermissionSnapshot.createMany.mock.calls[0][0] as {
      data: Record<string, unknown>[];
    };
    expect(data).toEqual([
      expect.objectContaining({ modelId: MODEL_ID, source: 'baseline', allowDerivatives: true }),
      expect.objectContaining({
        modelId: MODEL_ID,
        source: 'live',
        allowDerivatives: false,
        actorUserId: OWNER_ID,
        actorRole: 'owner',
      }),
    ]);
  });

  it('control: a save that leaves permissions alone writes and reads nothing', async () => {
    mockStored();

    await upsert({ id: MODEL_ID, userId: OWNER_ID, allowDerivatives: true, name: 'Renamed' });

    expect(mockDbWrite.modelPermissionSnapshot.findFirst).not.toHaveBeenCalled();
    expect(mockDbWrite.modelPermissionSnapshot.createMany).not.toHaveBeenCalled();
  });
});

describe('moderation log for flag edits', () => {
  const logged = () => vi.mocked(trackModActivity).mock.calls.map(([, input]) => input.activity);

  it.each([
    ['poi', false, true, 'setPoi'],
    ['poi', true, false, 'unsetPoi'],
    ['minor', false, true, 'setMinor'],
    ['minor', true, false, 'unsetMinor'],
    ['sfwOnly', false, true, 'setSfwOnly'],
    ['sfwOnly', true, false, 'unsetSfwOnly'],
  ] as const)('logs %s %s -> %s as %s', async (field, before, after, activity) => {
    mockStored({ [field]: before });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, [field]: after });

    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR_ID,
      { entityType: 'model', entityId: MODEL_ID, activity },
      expect.anything()
    );
  });

  it('writes the row inside the save transaction', async () => {
    mockStored({ poi: false });
    // The shared mock hands dbWrite itself to the callback, so a write on dbWrite after commit
    // would pass for one on the transaction. A distinct client tells them apart.
    const tx = new Proxy(mockDbWrite, {});
    mockDbWrite.$transaction.mockImplementationOnce(async (fn: (client: unknown) => unknown) =>
      fn(tx)
    );

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: true });

    expect(vi.mocked(trackModActivity).mock.calls[0][2]).toBe(tx);
  });

  it('fails the save when the row cannot be written', async () => {
    mockStored({ poi: false });
    vi.mocked(trackModActivity).mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: true })
    ).rejects.toThrow('insert failed');
  });

  it('logs each property locked or unlocked, compared as a set', async () => {
    mockStored({ lockedProperties: ['category', 'minor'] });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      lockedProperties: ['poi', 'category', 'nsfw'],
    });

    expect(logged().sort()).toEqual([
      'lockProperty:nsfw',
      'lockProperty:poi',
      'unlockProperty:minor',
    ]);
  });

  it('logs a moderator editing their own model', async () => {
    mockStored({ userId: MODERATOR_ID, poi: false });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: true });

    expect(logged()).toEqual(['setPoi']);
  });

  it('compares against the row the transaction replaced, not the earlier read', async () => {
    // The earlier read still shows poi; by the time the transaction reads, something else lifted it.
    mockDbWrite.model.findUnique
      .mockResolvedValueOnce({ ...storedModel, poi: true })
      .mockResolvedValueOnce({ ...storedModel, poi: false });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: false });

    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('logs nothing for a moderator save that changes no flag', async () => {
    mockStored({ poi: true, lockedProperties: ['nsfw', 'poi'] });

    // minor and sfwOnly default to false in the schema, so a form save always sends them.
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      poi: true,
      minor: false,
      sfwOnly: false,
      lockedProperties: ['poi', 'nsfw'],
    });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, name: 'Renamed' });

    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('logs nothing for an owner changing an unlocked flag', async () => {
    mockStored({ poi: false });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: true });

    expect(updateData()).toMatchObject({ poi: true });
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('logs nothing for a moderator create', async () => {
    await upsert({ userId: MODERATOR_ID, isModerator: true, poi: true, minor: true });

    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

describe('cover gate', () => {
  // The create form sends both covers as explicit nulls. Comparing them to a missing stored row
  // read as a cover change and refused every new model; keep null-vs-no-row equal.
  it('lets a create with null covers through', async () => {
    await upsert({ userId: OWNER_ID, coverImageId: null, sfwCoverImageId: null, sfwName: null });

    expect(mockDbWrite.model.create).toHaveBeenCalledTimes(1);
    expect(mockAssertCoverImagesValid).not.toHaveBeenCalled();
  });

  it.each(['coverImageId', 'sfwCoverImageId'] as const)(
    'refuses a create that picks %s',
    async (field) => {
      await expect(upsert({ userId: OWNER_ID, [field]: 9 })).rejects.toThrow(
        'Covers can be picked once the model has published images.'
      );
      expect(mockDbWrite.model.create).not.toHaveBeenCalled();
    }
  );

  it('validates a cover changed on update', async () => {
    mockStored({ coverImageId: null });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, coverImageId: 9 });

    expect(mockAssertCoverImagesValid).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: MODEL_ID, ownerId: OWNER_ID, coverImageId: 9 })
    );
  });
});

describe('.com face re-check after a listing edit', () => {
  const withFace = { sfwName: 'Retro Style', sfwCoverImageId: 5 };

  it('queues it for an owner who renames a model that has a .com face', async () => {
    mockStored(withFace);
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed' });
    expect(mockQueueComFaceRecheck).toHaveBeenCalledTimes(1);
    expect(mockQueueComFaceRecheck).toHaveBeenCalledWith(MODEL_ID);
  });

  it('queues it for an owner who edits the description', async () => {
    mockStored(withFace);
    await upsert({ id: MODEL_ID, userId: OWNER_ID, description: 'New description' });
    expect(mockQueueComFaceRecheck).toHaveBeenCalledTimes(1);
    expect(mockQueueComFaceRecheck).toHaveBeenCalledWith(MODEL_ID);
  });

  it('does not queue it for a moderator’s edit', async () => {
    mockStored(withFace);
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, name: 'Renamed' });
    expect(mockQueueComFaceRecheck).not.toHaveBeenCalled();
  });

  it('arms the restore check on a .red listing edit only, not on a .com edit', async () => {
    mockStored({ sfwName: 'Retro Style', sfwCoverImageId: null });
    mockPreviewComFaceIntent.mockResolvedValue({
      status: 'ok',
      output: { detected: false, reason: 'stub' },
    });
    mockPreviewTextScanNsfw.mockResolvedValue({ status: 'ok', level: 1, reason: 'stub' });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, sfwName: 'Retro Style 2' });
    expect(mockQueueComFaceRestore).not.toHaveBeenCalled();

    await upsert({ id: MODEL_ID, userId: OWNER_ID, description: 'New description' });
    expect(mockQueueComFaceRestore).toHaveBeenCalledWith(MODEL_ID);
  });

  it('does not queue it for a model without a .com face', async () => {
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed' });
    expect(mockQueueComFaceRecheck).not.toHaveBeenCalled();
  });

  describe('with the stored title and description sent back unchanged', () => {
    // The save repeats the stored listing, so only the field under test can trigger the queue.
    const unchanged = { name: baseInput.name, description: baseInput.description };
    beforeEach(() => {
      mockPreviewComFaceIntent.mockResolvedValue({
        status: 'ok',
        output: { detected: false, reason: 'stub' },
      });
      mockPreviewTextScanNsfw.mockResolvedValue({ status: 'ok', level: 1, reason: 'stub' });
    });

    it('does not queue it when nothing in the listing changed', async () => {
      mockStored({ ...withFace, ...unchanged });
      await upsert({ id: MODEL_ID, userId: OWNER_ID, sfwName: withFace.sfwName });
      expect(mockQueueComFaceRecheck).not.toHaveBeenCalled();
    });

    it('queues it when the owner retitles the .com face', async () => {
      mockStored({ ...withFace, ...unchanged });
      await upsert({ id: MODEL_ID, userId: OWNER_ID, sfwName: 'Retro Style Two' });
      expect(mockQueueComFaceRecheck).toHaveBeenCalledWith(MODEL_ID);
    });

    it('queues it when the owner picks another .com cover', async () => {
      mockStored({ ...withFace, ...unchanged });
      await upsert({ id: MODEL_ID, userId: OWNER_ID, sfwCoverImageId: 6 });
      expect(mockQueueComFaceRecheck).toHaveBeenCalledWith(MODEL_ID);
    });

    it('does not queue it when the owner clears the .com face', async () => {
      mockStored({ ...withFace, ...unchanged });
      await upsert({ id: MODEL_ID, userId: OWNER_ID, sfwName: '' });
      expect(mockQueueComFaceRecheck).not.toHaveBeenCalled();
    });
  });

  it('checks the stored title, description and the owner’s trigger words when an owner sets a face', async () => {
    mockStored({ name: 'Stored Title', description: '<p>Stored description</p>' });
    mockDbRead.modelVersion.findMany.mockResolvedValue([
      { trainedWords: ['stored-trigger'] },
    ] as never);
    mockPreviewComFaceIntent.mockResolvedValue({
      status: 'ok',
      output: { detected: false, reason: 'stub' },
    });
    mockPreviewTextScanNsfw.mockResolvedValue({ status: 'ok', level: 1, reason: 'stub' });

    // Neither listing field is in the save, so both come from the stored row.
    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      sfwName: 'Retro Style',
      name: undefined,
      description: undefined,
    });

    expect(mockDbRead.modelVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { modelId: MODEL_ID, model: { userId: OWNER_ID } } })
    );
    expect(mockPreviewComFaceIntent).toHaveBeenCalledTimes(1);
    const text = (mockPreviewComFaceIntent.mock.calls[0][0] as { fields: TextScanField[] }).fields
      .map((field) => field.text)
      .join(' ');
    expect(text).toContain('Stored Title');
    expect(text).toContain('Stored description');
    expect(text).toContain('stored-trigger');
  });

  it('refuses an owner’s save whose .com cover was cleared after the save read it', async () => {
    mockStored(withFace);
    mockLocked({ sfwCoverImageId: null });
    await expect(upsert({ id: MODEL_ID, userId: OWNER_ID, sfwCoverImageId: 5 })).rejects.toThrow(
      'civitai.com card changed while you were editing'
    );
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('drops the removal marker when a save sets a .com cover again', async () => {
    mockStored({
      sfwName: 'Retro Style',
      sfwCoverImageId: null,
      meta: {
        comFaceRemoved: { at: '2026-11-05T00:00:00.000Z', sfwCoverImageId: 5, reason: 'detected' },
      },
    });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, sfwCoverImageId: 6 });
    expect(updateData().meta).not.toHaveProperty('comFaceRemoved');
  });

  it('drops the removal marker when the owner turns the face off', async () => {
    mockStored({
      sfwName: 'Retro Style',
      sfwCoverImageId: null,
      meta: {
        comFaceRemoved: { at: '2026-11-05T00:00:00.000Z', sfwCoverImageId: 5, reason: 'detected' },
      },
    });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, sfwName: null });
    expect(updateData().meta).not.toHaveProperty('comFaceRemoved');
  });
});

describe('name length cap', () => {
  const name = (n: number) => 'n'.repeat(n);

  it('refuses a new model named over 150 characters', async () => {
    await expect(upsert({ userId: OWNER_ID, name: name(151) })).rejects.toThrow(
      'Model name must be 150 characters or fewer.'
    );
    expect(mockDbWrite.model.create).not.toHaveBeenCalled();
  });

  it('creates a model named exactly 150 characters', async () => {
    await upsert({ userId: OWNER_ID, name: name(150) });
    expect(createData().name).toBe(name(150));
  });

  it('saves an existing over-limit model whose name is re-sent unchanged', async () => {
    mockStored({ name: name(200) });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: name(200) });
    expect(mockDbWrite.model.update).toHaveBeenCalled();
  });

  it('saves an existing over-limit name stored with whitespace the schema trims off', async () => {
    mockStored({ name: `${name(200)} ` });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: name(200) });
    expect(mockDbWrite.model.update).toHaveBeenCalled();
  });

  it('refuses renaming a model to over 150 characters', async () => {
    await expect(upsert({ id: MODEL_ID, userId: OWNER_ID, name: name(151) })).rejects.toThrow(
      'Model name must be 150 characters or fewer.'
    );
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses an edit that shortens an over-limit name but leaves it over 150', async () => {
    mockStored({ name: name(200) });
    await expect(upsert({ id: MODEL_ID, userId: OWNER_ID, name: name(170) })).rejects.toThrow(
      'Model name must be 150 characters or fewer.'
    );
  });

  it('accepts renaming an over-limit model down to 150 characters', async () => {
    mockStored({ name: name(200) });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: name(150) });
    expect(updateData().name).toBe(name(150));
  });
});

describe('a held scan verdict', () => {
  it.each(['minor', 'poi'] as const)(
    'is applied when the owner’s save unticks %s',
    async (flag) => {
      mockStored({ [flag]: true });
      await upsert({ id: MODEL_ID, userId: OWNER_ID, [flag]: false });
      expect(mockApplyHeldVerdict).toHaveBeenCalledTimes(1);
      expect(mockApplyHeldVerdict).toHaveBeenCalledWith(MODEL_ID, { ownerCleared: true });
    }
  );

  it('is retried by a later save while it is still held on an unrestricted model', async () => {
    mockStored({
      meta: { restrictedNsfwVerdict: { source: 'text-scan', at: 'x', restriction: 'poi' } },
    });
    await upsert({ id: MODEL_ID, userId: OWNER_ID });
    expect(mockApplyHeldVerdict).toHaveBeenCalledTimes(1);
    expect(mockApplyHeldVerdict).toHaveBeenCalledWith(MODEL_ID, { ownerCleared: false });
  });

  it('is not retried once applied', async () => {
    mockStored({
      meta: {
        restrictedNsfwVerdict: { source: 'text-scan', at: 'x', restriction: 'poi', applied: {} },
      },
    });
    await upsert({ id: MODEL_ID, userId: OWNER_ID });
    expect(mockApplyHeldVerdict).not.toHaveBeenCalled();
  });

  it.each(['minor', 'poi'] as const)(
    'is left held while the save keeps %s (control)',
    async (flag) => {
      mockStored({ [flag]: true });
      await upsert({ id: MODEL_ID, userId: OWNER_ID, [flag]: true });
      expect(mockApplyHeldVerdict).not.toHaveBeenCalled();
    }
  );

  it('is revived by a later save while a kept verdict waits on an unrestricted model', async () => {
    mockStored({
      meta: {
        restrictedNsfwVerdictDormant: { source: 'text-scan', at: 'x', restriction: 'minor' },
      },
    });
    await upsert({ id: MODEL_ID, userId: OWNER_ID });
    expect(mockApplyHeldVerdict).toHaveBeenCalledTimes(1);
  });

  it('does not fail the save when applying it fails', async () => {
    mockStored({ poi: true });
    mockApplyHeldVerdict.mockRejectedValueOnce(new Error('boom'));
    await expect(upsert({ id: MODEL_ID, userId: OWNER_ID, poi: false })).resolves.toBeTruthy();
  });
});

describe('a held scan verdict on a model leaving Private', () => {
  it('is applied in the save when a moderator makes a Private model public', async () => {
    mockStored({ availability: Availability.Private, sfwOnly: true });
    mockLeavingPrivate.mockResolvedValueOnce(true);
    // Each transaction gets a client of its own, so the apply is seen to share the save's.
    const clients: unknown[] = [];
    const previous = mockDbWrite.$transaction.getMockImplementation();
    mockDbWrite.$transaction.mockImplementation((async (arg: unknown, ...rest: unknown[]) => {
      if (typeof arg !== 'function') return previous?.(arg as never, ...(rest as []));
      const tx = Object.create(mockDbWrite);
      clients.push(tx);
      return arg(tx);
    }) as never);
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      availability: Availability.Public,
    });
    expect(mockLeavingPrivate).toHaveBeenCalledTimes(1);
    const [db, id] = mockLeavingPrivate.mock.calls[0];
    expect(id).toBe(MODEL_ID);
    expect(clients).toContain(db);
    expect(mockDbWrite.model.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockLeavingPrivate.mock.invocationCallOrder[0]
    );
    expect(mockFinishApply).toHaveBeenCalledWith(MODEL_ID);
  });

  it('is not applied while the model stays Private (control)', async () => {
    mockStored({ availability: Availability.Private, sfwOnly: true });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, name: 'Renamed' });
    expect(mockLeavingPrivate).not.toHaveBeenCalled();
  });
});

describe('ownerDeclaredFlags is server-owned', () => {
  const STORED = { ownerDeclaredFlags: { at: '2026-11-01T00:00:00.000Z', flags: ['minor'] } };

  it('cannot be added by an owner save', async () => {
    mockStored({ meta: null });
    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { ownerDeclaredFlags: { at: 'x', flags: ['minor'] }, hideBuzz: true } as never,
    });
    expect(updateData().meta).toEqual({ hideBuzz: true });
  });

  it('cannot be cleared or changed by an owner or a moderator save', async () => {
    for (const isModerator of [false, true]) {
      vi.clearAllMocks();
      mockStored({ meta: STORED });
      await upsert({
        id: MODEL_ID,
        userId: isModerator ? MODERATOR_ID : OWNER_ID,
        isModerator,
        meta: { ownerDeclaredFlags: { at: 'x', flags: [] }, hideBuzz: true } as never,
      });
      expect(updateData().meta).toEqual({ ...STORED, hideBuzz: true });
    }
  });
});

describe('who lifted a held lead, on a save', () => {
  const lifted = {
    restrictedNsfwVerdict: {
      source: 'text-scan',
      at: 'x',
      restriction: 'minor',
      liftedBy: 'moderator',
    },
  };

  it.each(['minor', 'poi'] as const)(
    'a save that keeps %s forgets the earlier lift',
    async (flag) => {
      mockStored({ [flag]: true, sfwOnly: true, meta: lifted });
      await upsert({ id: MODEL_ID, userId: OWNER_ID, [flag]: true });
      expect(mockDropLiftedBy.mock.calls.map((c) => c.slice(1))).toEqual([
        [MODEL_ID, { flagged: true }],
      ]);
    }
  );

  it('leaves the lead alone when no lift is recorded (control)', async () => {
    mockStored({ minor: true, sfwOnly: true });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: true });
    expect(mockDropLiftedBy).not.toHaveBeenCalled();
  });

  it.each(['minor', 'poi'] as const)(
    'a moderator untick of %s is a moderator lift: the lead waits, never applied by the save',
    async (flag) => {
      mockStored({ [flag]: true, sfwOnly: true });
      await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, [flag]: false });
      expect(mockHoldLead.mock.calls.map((c) => c.slice(1))).toEqual([[MODEL_ID, 'moderator']]);
      expect(mockApplyHeldVerdict).toHaveBeenCalledWith(MODEL_ID, { ownerCleared: false });
    }
  );

  it('a moderator lifting the SFW-only lock is a moderator lift: the lead waits', async () => {
    mockStored({ sfwOnly: true, lockedProperties: ['nsfw', 'sfwOnly'] });
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      sfwOnly: false,
      lockedProperties: [],
    });
    expect(mockHoldLeadAfterSfwOnlyLift.mock.calls.map((c) => c.slice(1))).toEqual([[MODEL_ID]]);
  });

  it("an owner's save never records a moderator's lift", async () => {
    mockStored({ sfwOnly: true, lockedProperties: ['nsfw', 'sfwOnly'] });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, lockedProperties: [] });
    expect(mockHoldLeadAfterSfwOnlyLift).not.toHaveBeenCalled();
  });

  it('a moderator save that keeps the SFW-only lock records no lift (control)', async () => {
    mockStored({ sfwOnly: true, lockedProperties: ['nsfw', 'sfwOnly'] });
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      lockedProperties: ['nsfw', 'sfwOnly'],
    });
    expect(mockHoldLeadAfterSfwOnlyLift).not.toHaveBeenCalled();
  });

  it("the owner's untick is the owner's (control)", async () => {
    mockStored({ minor: true, sfwOnly: true });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: false });
    expect(mockHoldLead).not.toHaveBeenCalled();
    expect(mockApplyHeldVerdict).toHaveBeenCalledWith(MODEL_ID, { ownerCleared: true });
  });
});

describe("a moderator's untick of a text-scan POI flag", () => {
  const scanFlagged = (prevLocks: string[]) => ({
    poi: true,
    sfwOnly: true,
    lockedProperties: ['poi', 'nsfw', 'sfwOnly'],
    meta: {
      textScanFlags: {
        poi: { workflowId: 'wf', textHash: 'h', prev: { lockedProperties: prevLocks } },
      },
    },
  });
  // What the model form sends: the loaded locks, less the poi lock if the moderator removed it.
  const formLift = (extra: Partial<ModelUpsertInput> = {}) =>
    upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      poi: false,
      sfwOnly: false,
      lockedProperties: ['nsfw', 'sfwOnly'],
      ...extra,
    });

  it('drops the nsfw and SFW-only locks the flag added, as the grant does', async () => {
    mockStored(scanFlagged([]));
    await formLift();
    expect(updateData().lockedProperties).toEqual([]);
  });

  it('keeps a lock the model had before the flag', async () => {
    mockStored(scanFlagged(['nsfw']));
    await formLift();
    expect(updateData().lockedProperties).toEqual(['nsfw']);
  });

  it('keeps them while the model is still minor', async () => {
    mockStored({ ...scanFlagged([]), minor: true });
    await formLift();
    expect(updateData().lockedProperties).toEqual(['nsfw', 'sfwOnly']);
  });

  it('keeps the SFW-only lock when the save leaves SFW-only on', async () => {
    mockStored(scanFlagged([]));
    await formLift({ sfwOnly: true });
    expect(updateData().lockedProperties).toEqual(['sfwOnly']);
  });

  it('keeps the nsfw lock when the save rates the model nsfw', async () => {
    mockStored(scanFlagged([]));
    await formLift({ nsfw: true });
    expect(updateData().lockedProperties).toEqual(['nsfw']);
  });

  it('strips nothing from a flag that recorded no prior locks', async () => {
    mockStored({ ...scanFlagged([]), meta: { textScanFlags: { poi: { textHash: 'h' } } } });
    await formLift();
    expect(updateData().lockedProperties).toEqual(['nsfw', 'sfwOnly']);
  });

  // An appeal grant, or a moderator's lift, stamps `appealGranted`; a POI set by hand after it is
  // not the scan's, and the old snapshot does not describe its locks.
  it('strips nothing once the scan flag was ruled on and POI was set again by hand', async () => {
    const flagged = scanFlagged([]);
    const appealGranted = { at: '2026-11-01T00:00:00Z', by: MODERATOR_ID, via: 'moderator' };
    const poi = { ...flagged.meta.textScanFlags.poi, appealGranted };
    mockStored({ ...flagged, meta: { textScanFlags: { poi } } });
    await formLift();
    expect(updateData().lockedProperties).toEqual(['nsfw', 'sfwOnly']);
  });

  it('keeps them on a save that leaves POI set (control)', async () => {
    mockStored(scanFlagged([]));
    await formLift({ poi: true, sfwOnly: true });
    expect(updateData().lockedProperties).toEqual(['nsfw', 'sfwOnly']);
  });
});

// RESTRICT sites of the minor content rule in its ceiling form: the gallery level a flagged model
// is written and served at. Expected values are the levels as they stood before the gates shared
// the rule (PG and PG-13, flag 3).
describe('flagged model gallery level', () => {
  const SFW = 3;
  const FLAGS = [
    ['minor', { minor: true }, SFW],
    ['SFW-only', { sfwOnly: true }, SFW],
    ['minor and SFW-only', { minor: true, sfwOnly: true }, SFW],
  ] as const;

  it.each(FLAGS)('a new %s model is written at safe for work', async (_, flags, level) => {
    await upsert({ userId: MODERATOR_ID, isModerator: true, ...flags });
    expect((createData().gallerySettings as { level: number }).level).toBe(level);
  });

  it.each(FLAGS)('a save flagging the model %s writes safe for work', async (_, flags, level) => {
    mockStored();
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, ...flags });
    expect((updateData().gallerySettings as { level: number }).level).toBe(level);
  });

  it.each([
    [{ minor: true, sfwOnly: false }, undefined, SFW],
    [{ minor: true, sfwOnly: false }, 0, SFW],
    [{ minor: true, sfwOnly: false }, 1, 1],
    [{ minor: true, sfwOnly: false }, 31, SFW],
    [{ minor: true, sfwOnly: false }, 28, SFW],
    [{ minor: false, sfwOnly: true }, 2, 2],
    [{ minor: false, sfwOnly: true }, 28, SFW],
  ])('a %o model with stored level %s serves %i', (model, stored, served) => {
    expect(heldGalleryLevel(stored, model)).toBe(served);
  });

  it('copying gallery settings to every model keeps each flagged model at safe for work', async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, minor boolean NOT NULL,
      "sfwOnly" boolean NOT NULL, "gallerySettings" jsonb)`);
    const rows = [
      [1, false, false],
      [2, true, false],
      [3, false, true],
      [4, true, true],
    ] as const;
    for (const [id, minor, sfwOnly] of rows)
      await pg.query(
        `INSERT INTO "Model" VALUES ($1, ${OWNER_ID}, $2, $3, '{"level": 31}'::jsonb)`,
        [id, minor, sfwOnly]
      );
    const raw = pgliteRaw(pg);
    mockDbWrite.user.findUnique.mockResolvedValue({ settings: {} } as never);
    mockDbWrite.model.findMany.mockResolvedValue([] as never);
    mockDbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);

    try {
      await copyGallerySettingsToAllModelsByUser({
        settings: { level: 28, users: [], tags: [] },
        userId: OWNER_ID,
      });

      const { rows: levels } = await pg.query<{ id: number; level: number }>(
        `SELECT id, ("gallerySettings"->>'level')::int AS level FROM "Model" ORDER BY id`
      );
      expect(levels).toEqual([
        { id: 1, level: 28 },
        { id: 2, level: SFW },
        { id: 3, level: SFW },
        { id: 4, level: SFW },
      ]);
    } finally {
      mockDbWrite.$executeRaw.mockReset();
      mockDbWrite.user.findUnique.mockReset();
      mockDbWrite.model.findMany.mockReset();
      await pg.close();
    }
  });
});
