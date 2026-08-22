import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `PaidAccess.ownerId` is a denormalised copy of the model owner. It decides who generates free from a
 * gated version (`generation/paid-access-gating.ts`) and whose scheduled sales may reprice it
 * (`getSalesFor`), while the model-card sale badge resolves the owner from `Model.userId` instead — so a
 * transfer that moves one and not the other leaves those two answers disagreeing.
 *
 * A revert here is the statement disappearing from the transaction array, which the first assertion
 * reports by name rather than as a shape mismatch further down.
 *
 * Same import-the-real-model.service scaffold as `model.service.vae-append-no-mutation.test.ts`; only
 * the I/O surfaces are stubbed.
 */

const MODEL_IDS = [11, 12];
const VERSION_IDS = [101, 102];
const SOURCE_USER_ID = 5;
const TARGET_USER_ID = 9;
const MOD_USER_ID = 1;

type RawCall = { sql: string; values: unknown[] };

/** Where an interpolated value sat, so a value can be tied to the fragment it followed. */
const PARAM = ' ?? ';

const {
  mockBustPaidAccessCache,
  mockBustModelSaleCache,
  mockBustDonationGoals,
  mockDeleteBasicDataForUser,
} = vi.hoisted(() => ({
  mockBustPaidAccessCache: vi.fn(),
  mockBustModelSaleCache: vi.fn(),
  mockBustDonationGoals: vi.fn(),
  mockDeleteBasicDataForUser: vi.fn(),
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { cancellableQuery: vi.fn() },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: vi.fn(),
  deleteFilesForModelVersionCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn().mockResolvedValue({}),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  bustPaidAccessCache: mockBustPaidAccessCache,
  bustModelSaleCache: mockBustModelSaleCache,
}));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn().mockResolvedValue(new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: mockDeleteBasicDataForUser,
  getCosmeticsForUsers: vi.fn().mockResolvedValue({}),
  getProfilePicturesForUsers: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: vi.fn() },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: mockBustDonationGoals },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn() },
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {},
  Tracker: class {
    modelEvent = vi.fn();
  },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import { transferModelOwnership } from '~/server/services/model.service';

/** The operations handed to the ONE $transaction call, in order. */
let transactionOps: unknown[] = [];

function statementFor(table: string): RawCall | undefined {
  const ops = transactionOps as { __raw?: RawCall }[];
  return ops.map((op) => op?.__raw).find((raw) => raw?.sql.includes(`"${table}"`));
}

const paidAccessStatement = () => statementFor('PaidAccess');
const donationGoalStatement = () => statementFor('DonationGoal');

beforeEach(() => {
  transactionOps = [];

  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: TARGET_USER_ID });
  dbMock.dbWrite.model.findMany.mockResolvedValue(
    MODEL_IDS.map((id) => ({ id, userId: SOURCE_USER_ID, nsfw: false }))
  );
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue(VERSION_IDS.map((id) => ({ id })));
  dbMock.dbWrite.model.updateMany.mockImplementation((args: unknown) => ({ __op: 'model', args }));
  dbMock.dbWrite.modelMetric.updateMany.mockImplementation((args: unknown) => ({
    __op: 'modelMetric',
    args,
  }));
  // Posts, then images.
  dbMock.dbWrite.$queryRaw
    .mockReset()
    .mockResolvedValueOnce([{ id: 501 }])
    .mockResolvedValueOnce([{ id: 601 }]);
  // A tagged-template stand-in for Prisma's $executeRaw. The marker it returns is what lands in the
  // $transaction array, so a statement can be identified there by its own SQL. Interpolated values are
  // kept SEPARATE from the SQL: joining the template strings drops every one of them.
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      __raw: { sql: strings.join(PARAM), values },
    })
  );
  dbMock.dbWrite.$transaction.mockImplementation(async (ops: unknown[]) => {
    transactionOps = ops;
    // One result per operation, distinguishable so an index shift in the caller is visible.
    // Raw statements resolve to a row count, Prisma ops to { count } — as they do for real.
    return ops.map((op, i) =>
      (op as { __raw?: unknown })?.__raw ? 1000 + i : { count: 1000 + i }
    );
  });
});

describe('transferModelOwnership moves the PaidAccess owner', () => {
  it('updates PaidAccess in the SAME transaction as the Model row', async () => {
    await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    const statement = paidAccessStatement();
    expect(
      statement,
      'no UPDATE "PaidAccess" statement in the transfer transaction — the gate owner is left on the previous owner'
    ).toBeDefined();
    // The Model update is in the same array, so the two can never be committed apart.
    expect((transactionOps as { __op?: string }[]).some((op) => op?.__op === 'model')).toBe(true);
  });

  it('sets ownerId to the target user for every version of the transferred models', async () => {
    await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    const statement = paidAccessStatement();
    expect(statement).toBeDefined();
    // Values are matched to the fragment they follow, not merely to the value list: the id being
    // written and the ids being matched are both in that list, so a statement that assigned the wrong
    // one of them would still contain every value this test expects.
    const fragments = (statement as RawCall).sql.split(PARAM);
    const valueAfter = (pattern: RegExp) => {
      const i = fragments.findIndex((fragment) => pattern.test(fragment));
      expect(i, `no interpolated value follows ${pattern}`).toBeGreaterThanOrEqual(0);
      return (statement as RawCall).values[i];
    };
    expect(valueAfter(/SET\s+"ownerId"\s*=\s*$/)).toBe(TARGET_USER_ID);
    // Scoped through ModelVersion to the models being transferred, not to a user or a version list.
    expect((statement as RawCall).sql).toMatch(/FROM\s+"ModelVersion"/);
    expect(valueAfter(/mv\."modelId"\s*=\s*ANY\($/)).toEqual(MODEL_IDS);
    expect((statement as RawCall).values).not.toContain(SOURCE_USER_ID);
    // updatedAt is @updatedAt in Prisma, which a raw UPDATE does not apply.
    expect((statement as RawCall).sql).toMatch(/"updatedAt"\s*=\s*NOW\(\)/);
  });

  it('busts every owner-derived cache for the transferred versions', async () => {
    await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    expect(mockBustPaidAccessCache).toHaveBeenCalledWith('ModelVersion', VERSION_IDS);
    expect(mockBustModelSaleCache).toHaveBeenCalledWith(VERSION_IDS);
    expect(mockBustDonationGoals).toHaveBeenCalledWith(VERSION_IDS);
  });

  it('moves DonationGoal.userId in the same transaction, on both target spellings', async () => {
    await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    const statement = donationGoalStatement();
    expect(
      statement,
      'no UPDATE "DonationGoal" statement in the transfer transaction — a donation on the transferred model still pays the previous owner'
    ).toBeDefined();
    const fragments = (statement as RawCall).sql.split(PARAM);
    const i = fragments.findIndex((fragment) => /SET\s+"userId"\s*=\s*$/.test(fragment));
    expect(i).toBeGreaterThanOrEqual(0);
    expect((statement as RawCall).values[i]).toBe(TARGET_USER_ID);
    // The goal's target is dual-written; matching only one spelling leaves the other half behind.
    expect((statement as RawCall).sql).toMatch(/dg\."modelVersionId"\s*=\s*mv\.id/);
    expect((statement as RawCall).sql).toMatch(/dg\."entityId"\s*=\s*mv\.id/);
    expect((statement as RawCall).values).not.toContain(SOURCE_USER_ID);
  });

  it('reports each count from its own operation', async () => {
    const result = await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    // $transaction returns 1000 + position, so a stale index reads a neighbouring statement's count.
    const positionOf = (predicate: (op: unknown) => boolean) => transactionOps.findIndex(predicate);
    const modelPos = positionOf((op) => (op as { __op?: string })?.__op === 'model');
    const metricPos = positionOf((op) => (op as { __op?: string })?.__op === 'modelMetric');
    const rawPos = (table: string) =>
      positionOf((op) => !!(op as { __raw?: RawCall })?.__raw?.sql.includes(`"${table}"`));
    expect(result.modelsUpdated).toBe(1000 + modelPos);
    expect(result.metricsUpdated).toBe(1000 + metricPos);
    expect(result.paidAccessUpdated).toBe(1000 + rawPos('PaidAccess'));
    expect(result.donationGoalsUpdated).toBe(1000 + rawPos('DonationGoal'));
  });
});
