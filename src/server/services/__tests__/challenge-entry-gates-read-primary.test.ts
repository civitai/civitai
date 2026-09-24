import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Every challenge lookup behind a challenge-entry gate treats a missing row as "no rule applies".
 * The replica can lag a challenge's creation or status change, so those lookups must read the
 * primary. Each case here gives the replica a view that would let the entry through (no row, or a
 * stale Active one) and the primary the real challenge, then asserts the gate still fires.
 *
 * If a case here starts failing because a lookup moved back to dbRead: that is the regression this
 * file exists to catch, not a test to update.
 */

const COLLECTION_ID = 100;
const USER_ID = 5;
const CREATOR_ID = 4242;
const IMAGE_ID = 9001;
const REQUIRED_VERSION_ID = 111;

const { mockChargeEntryFees, mockAmIBlockedByUser } = vi.hoisted(() => ({
  mockChargeEntryFees: vi.fn(),
  mockAmIBlockedByUser: vi.fn(async () => false),
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/caches', () => ({
  tagIdsForImagesCache: {},
  userCollectionCountCache: {},
}));
vi.mock('~/server/services/article.service', () => ({ getArticles: vi.fn() }));
vi.mock('~/server/services/home-block-cache.service', () => ({ homeBlockCacheBust: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: vi.fn(),
  bustFeaturedModelsCache: vi.fn(),
  getModelsWithImagesAndModelVersions: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ getPostsInfinite: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: mockAmIBlockedByUser }));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeEntryFees: mockChargeEntryFees,
}));

const { validateContestCollectionEntry } = await import('~/server/services/collection.service');

type ChallengeRow = {
  id: number;
  collectionId: number;
  source: 'User' | 'System';
  status: 'Scheduled' | 'Active' | 'Cancelled';
  createdById: number;
  maxParticipants: number | null;
  modelVersionIds: number[];
  entryFee: number;
  buzzType: 'yellow' | 'green';
};

const challenge = (overrides: Partial<ChallengeRow> = {}): ChallengeRow => ({
  id: 1,
  collectionId: COLLECTION_ID,
  source: 'User',
  status: 'Active',
  createdById: CREATOR_ID,
  maxParticipants: null,
  modelVersionIds: [],
  entryFee: 0,
  buzzType: 'yellow',
  ...overrides,
});

// Evaluates the `where` shapes the entry gates use, so each client answers from its own rows.
function matches(row: ChallengeRow, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof ChallengeRow];
    if (key === 'maxParticipants') return value !== null;
    if (key === 'modelVersionIds') return (value as number[]).length > 0;
    return value === cond;
  });
}

function seed({ replica, primary }: { replica: ChallengeRow[]; primary: ChallengeRow[] }) {
  const answer =
    (rows: ChallengeRow[]) =>
    async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) => matches(row, where)) ?? null;
  dbMock.dbRead.challenge.findFirst.mockImplementation(answer(replica));
  dbMock.dbWrite.challenge.findFirst.mockImplementation(answer(primary));
}

const sqlOf = (strings: unknown) => (strings as string[]).join('?');

function seedRawQueries({
  judgedImageIds = [],
  participants = { total: 0, mine: 0 },
}: {
  judgedImageIds?: number[];
  participants?: { total: number; mine: number };
}) {
  dbMock.dbRead.$queryRaw.mockImplementation(async (strings: unknown) => {
    const sql = sqlOf(strings);
    if (sql.includes('"ChallengeJudge"')) return judgedImageIds.map((imageId) => ({ imageId }));
    if (sql.includes('COUNT(DISTINCT "addedById")')) return [participants];
    return [];
  });
}

const entry = (overrides: Record<string, unknown> = {}) =>
  validateContestCollectionEntry({
    collectionId: COLLECTION_ID,
    userId: USER_ID,
    imageIds: [IMAGE_ID],
    metadata: {},
    canAccessUserChallenges: true,
    ...overrides,
  } as Parameters<typeof validateContestCollectionEntry>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.user.findUnique.mockResolvedValue({ id: USER_ID, meta: {} });
  dbMock.dbRead.imageResourceNew.findMany.mockResolvedValue([]);
  dbMock.dbRead.collection.findMany.mockResolvedValue([]);
  mockAmIBlockedByUser.mockResolvedValue(false);
  mockChargeEntryFees.mockResolvedValue({ paidImageIds: [IMAGE_ID], unpaidImageIds: [] });
  seedRawQueries({});
});

describe('challenge-entry gates when the replica has not caught up', () => {
  it('lets an entry through when the primary challenge has no rule that stops it', async () => {
    seed({ replica: [], primary: [challenge()] });

    await expect(entry()).resolves.toBeUndefined();
  });

  it('applies the user-challenge flag gate', async () => {
    seed({ replica: [], primary: [challenge()] });

    await expect(entry({ canAccessUserChallenges: false })).rejects.toThrow(
      'This challenge is not currently available.'
    );
  });

  it("applies the creator's block gate", async () => {
    seed({ replica: [], primary: [challenge()] });
    mockAmIBlockedByUser.mockResolvedValue(true);

    await expect(entry()).rejects.toThrow('This challenge is not available.');
    expect(mockAmIBlockedByUser).toHaveBeenCalledWith({
      userId: USER_ID,
      targetUserId: CREATOR_ID,
    });
  });

  it('refuses entries until the challenge is Active', async () => {
    seed({ replica: [], primary: [challenge({ status: 'Scheduled' })] });

    await expect(entry()).rejects.toThrow('Challenge is starting shortly');
  });

  it('refuses an entry into your own challenge', async () => {
    seed({ replica: [], primary: [challenge({ source: 'System', createdById: USER_ID })] });

    await expect(entry()).rejects.toThrow('You cannot submit entries to your own challenge.');
  });

  it('refuses an image a judge has already scored', async () => {
    seed({ replica: [], primary: [challenge({ source: 'System' })] });
    seedRawQueries({ judgedImageIds: [IMAGE_ID] });

    await expect(entry()).rejects.toThrow('This image has already been judged');
  });

  it('enforces the participant cap', async () => {
    seed({ replica: [], primary: [challenge({ maxParticipants: 1 })] });
    seedRawQueries({ participants: { total: 1, mine: 0 } });

    await expect(entry()).rejects.toThrow('maximum number of participants');
  });

  it('enforces the required-model rule', async () => {
    seed({ replica: [], primary: [challenge({ modelVersionIds: [REQUIRED_VERSION_ID] })] });

    await expect(entry()).rejects.toThrow("This image doesn't use a required model");
  });

  it('charges the entry fee', async () => {
    seed({ replica: [], primary: [challenge({ entryFee: 50 })] });

    await expect(entry()).resolves.toBeUndefined();
    expect(mockChargeEntryFees).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 1, userId: USER_ID, entryFee: 50 })
    );
  });

  it('neither charges nor accepts an entry into a challenge the replica still sees as Active but the primary has Cancelled', async () => {
    seed({
      replica: [challenge({ entryFee: 50 })],
      primary: [challenge({ entryFee: 50, status: 'Cancelled' })],
    });

    await expect(entry()).rejects.toThrow('Challenge is starting shortly');
    expect(mockChargeEntryFees).not.toHaveBeenCalled();
  });
});
