import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Leak-safety + cache-routing contract for `modelVersionDonationGoals`.
 *
 * The response varies by viewer: an OWNER or MODERATOR (`canSeeAllGoals`) sees ALL goals
 * including inactive/draft ones; the PUBLIC (anonymous / non-owner / non-moderator) viewer sees
 * only active goals. The DB-load-reduction lever caches ONLY the public, viewer-independent
 * variant keyed by modelVersionId. These tests pin the critical invariants:
 *
 *   (1) a public (cache-hit) read skips the per-viewer version + goals DB queries,
 *   (2) an owner/moderator read NEVER reads from or writes to the public cache (no draft leak),
 *   (3) two anonymous users — and a logged-in non-owner — share the SAME modelVersionId key and
 *       get an identical payload (the key does not span the privilege dimension),
 *   (4) the public payload is shape- and value-identical to the uncached privileged computation
 *       for the same underlying goal row.
 */

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  });
  const read = { modelVersion: mk(), donationGoal: mk(), model: mk(), $queryRaw: vi.fn() };
  const write = { modelVersion: mk(), model: mk(), $queryRaw: vi.fn() };
  return { mockDbRead: read, mockDbWrite: write };
});

const { mockCacheFetch, mockCacheBust } = vi.hoisted(() => ({
  mockCacheFetch: vi.fn(),
  mockCacheBust: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  modelVersionPublicDonationGoalsCache: { fetch: mockCacheFetch, bust: mockCacheBust },
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>(
    '@civitai/redis/client'
  );
  return { ...actual, redis: { get: vi.fn(), set: vi.fn() }, sysRedis: { get: vi.fn() } };
});
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: {},
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  ingestModelById: vi.fn(),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ filesForModelVersionCache: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import { modelVersionDonationGoals } from '~/server/services/model-version.service';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
// A single active PUBLIC goal, already summed — the exact element shape the endpoint returns.
const publicGoal = (over: Record<string, unknown> = {}) => ({
  id: 10,
  goalAmount: 1000,
  title: 'Goal',
  active: true,
  isEarlyAccess: false,
  userId: 7,
  createdAt: CREATED_AT,
  description: 'desc',
  total: 250,
  ...over,
});
// The DonationGoal row the privileged path reads (no `total` — that's summed separately).
const goalRow = (over: Record<string, unknown> = {}) => ({
  id: 10,
  goalAmount: 1000,
  title: 'Goal',
  active: true,
  isEarlyAccess: false,
  userId: 7,
  createdAt: CREATED_AT,
  description: 'desc',
  ...over,
});
const ownerVersion = (ownerId: number) => ({
  id: 5,
  modelId: 2,
  earlyAccessEndsAt: null,
  model: { userId: ownerId },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('modelVersionDonationGoals — public cache routing', () => {
  it('(1) serves the public variant from the cache without any per-viewer DB read', async () => {
    mockCacheFetch.mockResolvedValueOnce({ '5': { modelVersionId: 5, goals: [publicGoal()] } });

    const res = await modelVersionDonationGoals({ id: 5 }); // anonymous

    expect(res).toEqual([publicGoal()]);
    expect(mockCacheFetch).toHaveBeenCalledWith([5]);
    // The expensive per-viewer reads are elided on a public cache hit.
    expect(mockDbRead.modelVersion.findFirstOrThrow).not.toHaveBeenCalled();
    expect(mockDbRead.donationGoal.findMany).not.toHaveBeenCalled();
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('(1b) 404s a missing version on the public path (no cache entry → NOT_FOUND)', async () => {
    mockCacheFetch.mockResolvedValueOnce({}); // lookupFn seeds no entry for a missing version

    await expect(modelVersionDonationGoals({ id: 999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('modelVersionDonationGoals — privileged bypass (no draft-goal leak)', () => {
  it('(2) an OWNER read is computed fresh and NEVER touches the public cache', async () => {
    mockDbRead.modelVersion.findFirstOrThrow.mockResolvedValueOnce(ownerVersion(7));
    // Owner sees ALL goals incl. a draft/inactive one that must never enter the shared cache.
    mockDbRead.donationGoal.findMany.mockResolvedValueOnce([
      goalRow(),
      goalRow({ id: 11, active: false, title: 'Draft' }),
    ]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 250 }]);

    const res = await modelVersionDonationGoals({ id: 5, userId: 7 }); // owner

    // Leak axis: the privileged path must NOT read from or write to the shared public cache.
    expect(mockCacheFetch).not.toHaveBeenCalled();
    expect(mockCacheBust).not.toHaveBeenCalled();
    // It reads ALL goals for the version (no active/isEarlyAccess restriction).
    expect(mockDbRead.donationGoal.findMany).toHaveBeenCalledWith({
      where: { modelVersionId: 5 },
      select: {
        id: true,
        goalAmount: true,
        title: true,
        active: true,
        isEarlyAccess: true,
        userId: true,
        createdAt: true,
        description: true,
      },
    });
    expect(res).toContainEqual(expect.objectContaining({ id: 11, active: false, title: 'Draft' }));
  });

  it('(2b) a MODERATOR (non-owner) read also bypasses the public cache', async () => {
    mockDbRead.modelVersion.findFirstOrThrow.mockResolvedValueOnce(ownerVersion(7));
    mockDbRead.donationGoal.findMany.mockResolvedValueOnce([goalRow({ active: false })]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 250 }]);

    const res = await modelVersionDonationGoals({ id: 5, userId: 999, isModerator: true });

    expect(mockCacheFetch).not.toHaveBeenCalled();
    expect(mockCacheBust).not.toHaveBeenCalled();
    expect(res).toContainEqual(expect.objectContaining({ id: 10, active: false }));
  });
});

describe('modelVersionDonationGoals — shared key does not span the privilege dimension', () => {
  it('(3) two anon users AND a logged-in non-owner share the identical modelVersionId key', async () => {
    const payload = { '5': { modelVersionId: 5, goals: [publicGoal()] } };
    mockCacheFetch.mockResolvedValue(payload);
    // Logged-in non-owner still resolves the owner (to confirm non-ownership) but then serves
    // the SAME public cache — never the privileged fresh path.
    mockDbRead.modelVersion.findFirstOrThrow.mockResolvedValue(ownerVersion(7));

    const anon1 = await modelVersionDonationGoals({ id: 5 });
    const anon2 = await modelVersionDonationGoals({ id: 5 });
    const nonOwner = await modelVersionDonationGoals({ id: 5, userId: 999 });

    expect(anon1).toEqual(anon2);
    expect(nonOwner).toEqual(anon1);
    // Every read used the SAME viewer-independent key [5] — no per-user dimension.
    for (const call of mockCacheFetch.mock.calls) expect(call[0]).toEqual([5]);
    // The public (non-owner) path never reads goals directly from the DB.
    expect(mockDbRead.donationGoal.findMany).not.toHaveBeenCalled();
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('modelVersionDonationGoals — output shape identical to uncached', () => {
  it('(4) the cached public element matches the fresh privileged element for the same goal', async () => {
    // Public (cache) result for the shared active goal.
    mockCacheFetch.mockResolvedValueOnce({ '5': { modelVersionId: 5, goals: [publicGoal()] } });
    const [pub] = await modelVersionDonationGoals({ id: 5 }); // anonymous

    // Uncached privileged result computed from the equivalent DB row + summed total.
    mockDbRead.modelVersion.findFirstOrThrow.mockResolvedValueOnce(ownerVersion(7));
    mockDbRead.donationGoal.findMany.mockResolvedValueOnce([goalRow()]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 250 }]);
    const [priv] = await modelVersionDonationGoals({ id: 5, isModerator: true });

    expect(Object.keys(pub).sort()).toEqual(Object.keys(priv).sort());
    expect(pub).toEqual(priv);
    expect(pub.createdAt).toBeInstanceOf(Date); // Date type preserved (msgpack round-trip)
  });
});
