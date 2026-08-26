import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `setModelVersionNsfw` — the moderator override on the automatic version-name flag.
 *
 * Two properties fail silently if reverted. The SYSTEM-OWNED refusal: clearing there is not
 * blocked by the database guard (it fires only `WHEN (NEW."nsfw")`), and the level derivation
 * has no branch for an unflagged system-owned version, so the row would keep the NSFW level
 * with the flag gone and nothing would revisit it — a successful-looking call that corrupts.
 * And the RECOMPUTE: `nsfw` is an input to the derived level, so a write without it leaves the
 * flag cleared and the version still stamped NSFW everywhere anyone reads.
 */

const { mockUpdateVersionLevels, mockUpdateModelLevels, mockBustPublicModelResponseCache } =
  vi.hoisted(() => ({
    mockUpdateVersionLevels: vi.fn(),
    mockUpdateModelLevels: vi.fn(),
    mockBustPublicModelResponseCache: vi.fn(),
  }));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateModelVersionNsfwLevels: mockUpdateVersionLevels,
  updateModelNsfwLevels: mockUpdateModelLevels,
}));
vi.mock('~/server/services/model-response-cache', () => ({
  bustPublicModelResponseCache: mockBustPublicModelResponseCache,
  publicModelResponseKey: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ updateModelLastVersionAt: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/model-version-moderation.adapter', () => ({
  moderateModelVersionName: vi.fn(),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  writePaidAccessForModelVersion: vi.fn(),
  materializePaidAccessEndsAt: vi.fn(),
  bustPaidAccessCache: vi.fn(),
  paidAccessInputFromLegacyConfig: vi.fn(() => null),
  earlyAccessDonationGoalFromLegacyConfig: vi.fn(() => null),
  earlyAccessConfigFromPaidAccess: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));

const { setModelVersionNsfw } = await import('~/server/services/model-version.service');

const version = (over: Partial<{ nsfw: boolean; ownerId: number }> = {}) => ({
  id: 7,
  nsfw: over.nsfw ?? true,
  modelId: 3,
  model: { userId: over.ownerId ?? 99 },
});

const call = (over: Partial<{ nsfw: boolean; isModerator: boolean }> = {}) =>
  setModelVersionNsfw({
    id: 7,
    nsfw: over.nsfw ?? false,
    userId: 5,
    isModerator: over.isModerator ?? true,
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(version());
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({ id: 7 });
});

describe('setModelVersionNsfw', () => {
  it('refuses a non-moderator before reading anything', async () => {
    await expect(call({ isModerator: false })).rejects.toThrow();
    expect(dbMock.dbWrite.modelVersion.findUnique).not.toHaveBeenCalled();
  });

  it('clears the flag and recomputes both levels', async () => {
    await call();

    expect(dbMock.dbWrite.modelVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { nsfw: false } })
    );
    expect(mockUpdateVersionLevels).toHaveBeenCalledExactlyOnceWith([7]);
    expect(mockUpdateModelLevels).toHaveBeenCalledExactlyOnceWith([3]);
  });

  // The version's level is embedded in the origin-side public response and in
  // dataForModelsCache for a day. Without the bust the clear is invisible for the whole TTL.
  it('busts the public model response cache', async () => {
    await call();

    expect(mockBustPublicModelResponseCache).toHaveBeenCalled();
  });

  it('refuses a system-owned model in both directions', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(version({ ownerId: -1 }));
    await expect(call({ nsfw: false })).rejects.toThrow(/system-owned/);

    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(version({ ownerId: -1, nsfw: false }));
    await expect(call({ nsfw: true })).rejects.toThrow(/system-owned/);

    expect(dbMock.dbWrite.modelVersion.update).not.toHaveBeenCalled();
  });

  it('is a no-op when the flag already holds the requested value', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(version({ nsfw: false }));

    await call({ nsfw: false });

    expect(dbMock.dbWrite.modelVersion.update).not.toHaveBeenCalled();
    expect(mockUpdateVersionLevels).not.toHaveBeenCalled();
  });

  it('throws when the version is gone', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(null);

    await expect(call()).rejects.toThrow();
  });
});
