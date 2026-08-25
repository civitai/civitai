import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelVersionService from '~/server/services/model-version.service';

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
  mockBustMvCache,
  mockQueueModelsIndex,
  mockBustDonationGoals,
  mockDeleteBasicDataForUser,
} = vi.hoisted(() => ({
  mockBustPaidAccessCache: vi.fn(),
  mockBustMvCache: vi.fn(),
  mockQueueModelsIndex: vi.fn(),
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
  // Returns a promise for real, and the transfer now attaches a .catch to it.
  queueImageSearchIndexUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  bustPaidAccessCache: mockBustPaidAccessCache,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustMvCache: mockBustMvCache,
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
  modelsSearchIndex: { queueUpdate: mockQueueModelsIndex },
}));

import { transferModelOwnership } from '~/server/services/model.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

/** The operations handed to the ONE $transaction call, in order. */
let transactionOps: unknown[] = [];

function statementsFor(table: string): RawCall[] {
  const ops = transactionOps as { __raw?: RawCall }[];
  return ops
    .map((op) => op?.__raw)
    .filter((raw): raw is RawCall => !!raw?.sql.includes(`"${table}"`));
}

const paidAccessStatement = () => statementsFor('PaidAccess')[0];
/** Two, one per dual-written target spelling. */
const donationGoalStatements = () => statementsFor('DonationGoal');

/** Ticks on the transaction and on each bust, so the busts can be pinned AFTER the commit. */
let clock = 0;
let transactionAt = 0;
const bustAt: number[] = [];

/** Every value interpolated after a fragment matching `pattern`, in statement order. */
function valuesAfter(statement: RawCall, pattern: RegExp) {
  const fragments = statement.sql.split(PARAM);
  return fragments
    .map((fragment, i) => (pattern.test(fragment) ? statement.values[i] : undefined))
    .filter((v) => v !== undefined);
}

function valueAfter(statement: RawCall, pattern: RegExp) {
  const found = valuesAfter(statement, pattern);
  expect(found, `no interpolated value follows ${pattern}`).toHaveLength(1);
  return found[0];
}

/** Both statements are scoped to the transferred models and skip rows already on the target. */
function expectScopedToTransfer(statement: RawCall) {
  expect(valueAfter(statement, /"modelId"\s*=\s*ANY\($/)).toEqual(MODEL_IDS);
  expect((statement as RawCall).sql).toMatch(/mv\."modelId"\s*=\s*ANY\(/);
  // The guard is `<>`. Flipped to `=`, the statement matches only rows that are already correct —
  // a permanent no-op that leaves every value, position and fragment in this test unchanged.
  expect(valueAfter(statement, /"userId"\s*<>\s*$|"ownerId"\s*<>\s*$/)).toBe(TARGET_USER_ID);
}

beforeEach(() => {
  // The hoisted spies live for the whole file — without this their call counts accumulate across
  // tests, and toHaveBeenCalledExactlyOnceWith is the assertion that notices.
  vi.clearAllMocks();
  transactionOps = [];
  clock = 0;
  transactionAt = 0;
  bustAt.length = 0;
  for (const bust of [
    mockBustPaidAccessCache,
    mockBustMvCache,
    mockBustDonationGoals,
    mockQueueModelsIndex,
  ])
    bust.mockImplementation(() => {
      bustAt.push(++clock);
      return Promise.resolve();
    });

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
  // mockReset drops the canonical default too, so a third read on this path would return undefined
  // and die on .map far from its cause — hence the trailing default.
  dbMock.dbWrite.$queryRaw
    .mockReset()
    .mockResolvedValue([])
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
    transactionAt = ++clock;
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

  it('sets ownerId to the target user, scoped to the transferred models', async () => {
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
    expect(valueAfter(statement, /SET\s+"ownerId"\s*=\s*$/)).toBe(TARGET_USER_ID);
    // 🔴 The join predicate, not just the FROM. Without `pa."entityId" = mv.id` this is a cross join
    // and EVERY ModelVersion gate on the site moves to the target user — and `FROM "ModelVersion"`
    // alone still matches, so the FROM is the half that cannot be wrong.
    expect(statement.sql).toMatch(/FROM\s+"ModelVersion"/);
    expect(statement.sql).toMatch(/pa\."entityId"\s*=\s*mv\.id/);
    // The enum literal is load-bearing: a ComicChapter gate has no transfer path and must not move.
    expect(statement.sql).toMatch(/pa\."entityType"\s*=\s*'ModelVersion'::"PaidAccessEntityType"/);
    expectScopedToTransfer(statement);
    // updatedAt is @updatedAt in Prisma, which a raw UPDATE does not apply.
    expect(statement.sql).toMatch(/"updatedAt"\s*=\s*NOW\(\)/);
  });

  it('DELETES the PricingSlot rows rather than moving them', async () => {
    await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    const [statement, ...extra] = statementsFor('PricingSlot');
    expect(
      statement,
      'no "PricingSlot" statement in the transfer transaction — the slot strands on the previous owner, where it can never be released and blocks every future insert for that version'
    ).toBeDefined();
    expect(extra).toHaveLength(0);
    // 🔴 DELETE, never UPDATE. Moving ownerId would charge the recipient a slot for a price they
    // inherited rather than set — the thing #4309 rejected for PaidAccess in the other direction.
    expect(statement.sql).toMatch(/DELETE\s+FROM\s+"PricingSlot"/);
    expect(statement.sql).not.toMatch(/SET\s+"ownerId"/);
    // Without the join predicate this drops EVERY slot on the site, and `USING "ModelVersion"` alone
    // still matches — same reason as the gate statement above.
    expect(statement.sql).toMatch(/USING\s+"ModelVersion"/);
    expect(statement.sql).toMatch(/ps\."entityId"\s*=\s*mv\.id/);
    expect(statement.sql).toMatch(/ps\."entityType"\s*=\s*'ModelVersion'::"PaidAccessEntityType"/);
    expect(valueAfter(statement, /"modelId"\s*=\s*ANY\($/)).toEqual(MODEL_IDS);
    // No `ownerId <> target` guard, unlike the UPDATEs above: the row goes whoever holds it, because
    // what makes it harmful is the primary key blocking a re-insert, not whose name is on it.
    expect(statement.sql).not.toMatch(/"ownerId"/);
  });

  it('busts every owner-derived cache for the transferred versions', async () => {
    await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    expect(mockBustPaidAccessCache).toHaveBeenCalledExactlyOnceWith('ModelVersion', VERSION_IDS);
    expect(mockBustDonationGoals).toHaveBeenCalledExactlyOnceWith(VERSION_IDS);
    // modelVersionAccessCache holds Model.userId for a day and hasEntityAccess grants owner access
    // from it; bustMvCache is what reaches it, and it carries the model search-index update too.
    expect(mockBustMvCache).toHaveBeenCalledExactlyOnceWith(VERSION_IDS, MODEL_IDS);
    // The ids come from this read, so a narrowed query (say, published versions only) would leave the
    // rest holding a stale owner for the full hour while every assertion above still passed.
    expect(dbMock.dbWrite.modelVersion.findMany).toHaveBeenCalledWith({
      where: { modelId: { in: MODEL_IDS } },
      select: { id: true },
    });
    // 🔴 AFTER the commit. Busting first lets a concurrent read repopulate from pre-transfer rows,
    // which is the whole failure the busts exist to prevent — and the arguments are identical either
    // way, so nothing else here can tell the difference.
    expect(transactionAt).toBeGreaterThan(0);
    expect(Math.min(...bustAt)).toBeGreaterThan(transactionAt);
    // Enqueued here rather than only inside bustMvCache, where four throwable awaits sit in front of
    // it — and it is the one leg whose loss is permanent, since Meilisearch has no TTL to heal on.
    expect(mockQueueModelsIndex).toHaveBeenCalledWith(
      MODEL_IDS.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
  });

  it('moves DonationGoal.userId in the same transaction, on both target spellings', async () => {
    await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    const statements = donationGoalStatements();
    expect(
      statements.length,
      'the DonationGoal target is dual-written; one statement covers one spelling and leaves the other half of the goals paying the previous owner'
    ).toBe(2);
    const legacy = statements.find((st) => /dg\."modelVersionId"\s*=\s*mv\.id/.test(st.sql));
    const polymorphic = statements.find((st) => /dg\."entityId"\s*=\s*mv\.id/.test(st.sql));
    expect(legacy, 'no statement matches the legacy modelVersionId target').toBeDefined();
    expect(
      polymorphic,
      'no statement matches the polymorphic entityType/entityId target'
    ).toBeDefined();
    expect((polymorphic as RawCall).sql).toMatch(
      /dg\."entityType"\s*=\s*'ModelVersion'::"PaidAccessEntityType"/
    );

    for (const statement of statements) {
      expect(valueAfter(statement, /SET\s+"userId"\s*=\s*$/)).toBe(TARGET_USER_ID);
      // 🔴 Without this the statement retargets every donation goal on the site to the transferee,
      // and every other assertion here still passes.
      expectScopedToTransfer(statement);
    }
  });

  it('does not fail a COMMITTED transfer when an invalidation throws', async () => {
    mockBustPaidAccessCache.mockRejectedValue(new Error('redis down'));

    const result = await transferModelOwnership({
      modelIds: MODEL_IDS,
      targetUserId: TARGET_USER_ID,
      modUserId: MOD_USER_ID,
    });

    // The transaction already committed, and the pre-flight guard refuses a retry once the models
    // belong to the target — so a throw here strands the operator with a transfer that succeeded and
    // an error saying it did not. A stale cache expires on its own.
    expect(result.modelsUpdated).toBeDefined();
    expect(mockBustMvCache).toHaveBeenCalledTimes(1);
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
    const rawPositions = (table: string) =>
      transactionOps
        .map((op, i) => ((op as { __raw?: RawCall })?.__raw?.sql.includes(`"${table}"`) ? i : -1))
        .filter((i) => i >= 0);
    const postsPos = positionOf(
      (op) => !!(op as { __raw?: RawCall })?.__raw?.sql.includes('UPDATE "Post"')
    );
    const imagesPos = positionOf(
      (op) => !!(op as { __raw?: RawCall })?.__raw?.sql.includes('UPDATE "Image"')
    );
    expect(result.modelsUpdated).toBe(1000 + modelPos);
    expect(result.metricsUpdated).toBe(1000 + metricPos);
    expect(result.paidAccessUpdated).toBe(1000 + rawPositions('PaidAccess')[0]);
    // Both legs, summed — the `userId <> target` guard makes them disjoint, so a dual-written goal
    // is counted once.
    expect(result.donationGoalsUpdated).toBe(
      rawPositions('DonationGoal').reduce((sum, i) => sum + 1000 + i, 0)
    );
    expect(result.postsUpdated).toBe(1000 + postsPos);
    expect(result.imagesUpdated).toBe(1000 + imagesPos);
  });
});
