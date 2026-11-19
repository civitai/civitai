import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as Caches from '~/server/redis/caches';
import type * as PaidAccessService from '~/server/services/paid-access.service';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as ModeratorService from '~/server/services/moderator.service';

/**
 * A moderator's revoke of one buyer's early access, with grants, gift links and claims held in
 * PGlite, and the real unpublish refund and gift claim run against what it leaves. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  buzz: {
    refundMultiAccountTransaction: vi.fn(),
    getUserBuzzAccountByAccountTypes: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    createBuzzTransaction: vi.fn(),
    createMultiAccountBuzzTransaction: vi.fn(),
  },
  bustMvCache: vi.fn(),
  trackModActivity: vi.fn(),
  accessCacheFetch: vi.fn(),
  lookupModelVersionAccess: vi.fn(),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  modelVersionAccessCache: { fetch: mocks.accessCacheFetch },
  lookupModelVersionAccess: mocks.lookupModelVersionAccess,
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccessService>()),
  getPaidAccess: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/buzz.service', () => mocks.buzz);
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustMvCache: mocks.bustMvCache,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: mocks.trackModActivity,
}));

const { moderatorRevokeEarlyAccess } = await import(
  '~/server/services/model-version-access-revoke.service'
);
const { getModelVersionEarlyAccessRefundRequirement, refundModelEarlyAccessPurchases } =
  await import('~/server/services/model-early-access-refund.service');
const { redeemGiftLink, revokeGiftRedemption } = await import(
  '~/server/services/model-version-gift.service'
);
const { grantModelVersionAccess } = await import('~/server/services/model-version-access.service');
const { hasEntityAccess } = await import('~/server/services/common.service');

const VERSION_ID = 501;
const OTHER_VERSION_ID = 502;
const MODEL_ID = 9;
const BUYER_A = 77;
const BUYER_B = 78;
const MODERATOR = 1;
const GIFT_LINK = 40;
const PURCHASED_AT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "EntityAccess" (
      "accessToId" int NOT NULL,
      "accessToType" text NOT NULL,
      "accessorId" int NOT NULL,
      "accessorType" text NOT NULL,
      permissions int NOT NULL,
      meta jsonb,
      "addedById" int,
      "addedAt" timestamp(3) NOT NULL DEFAULT now(),
      PRIMARY KEY ("accessToId", "accessToType", "accessorId", "accessorType")
    );
    CREATE TABLE "ModelVersionGiftLink" (
      id int PRIMARY KEY,
      "modelVersionId" int NOT NULL,
      "revokedAt" timestamp(3),
      "expiresAt" timestamp(3),
      "maxRedemptions" int,
      "redemptionCount" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "ModelVersionGiftRedemption" (
      "giftLinkId" int NOT NULL,
      "userId" int NOT NULL,
      "claimedAt" timestamp(3) NOT NULL DEFAULT now(),
      "revokedAt" timestamp(3),
      "revokedById" int,
      PRIMARY KEY ("giftLinkId", "userId")
    );
  `);
});

afterAll(async () => {
  await db.close();
});

/** Prisma's findMany over EntityAccess, for the unpublish refund's read. */
const findManyOnPglite = async () =>
  (await db.query(`SELECT * FROM "EntityAccess" ORDER BY "accessorId"`)).rows;

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`TRUNCATE "EntityAccess", "ModelVersionGiftLink", "ModelVersionGiftRedemption"`);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.entityAccess.findMany.mockImplementation(findManyOnPglite as never);
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({ modelId: MODEL_ID } as never);
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
    { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
  ] as never);
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({ name: 'Model', userId: 1 } as never);
  mocks.buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
    { accountType: 'yellow', amount: 500 },
  ]);
  mocks.buzz.getUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: 10_000 });
  const privateVersion = { entityId: VERSION_ID, userId: 5, availability: 'Private' };
  mocks.accessCacheFetch.mockResolvedValue({});
  mocks.lookupModelVersionAccess.mockResolvedValue({ [VERSION_ID]: privateVersion });
  dbMock.dbRead.$queryRaw.mockResolvedValue([privateVersion] as never);
});

const buy = (versionId: number, userId: number) =>
  db.query(
    `INSERT INTO "EntityAccess" ("accessToId", "accessToType", "accessorId", "accessorType", permissions, meta)
     VALUES ($1, 'ModelVersion', $2, 'User', 3, $3::jsonb)`,
    [
      versionId,
      userId,
      JSON.stringify({
        'download-buzzTransactionId': `tx-${versionId}-${userId}`,
        'download-purchasedAt': PURCHASED_AT,
      }),
    ]
  );

const grantOf = async (versionId: number, userId: number, accessToType = 'ModelVersion') =>
  (
    await db.query<{ permissions: number; meta: Record<string, unknown> }>(
      `SELECT permissions, meta FROM "EntityAccess"
        WHERE "accessToId" = $1 AND "accessorId" = $2 AND "accessToType" = $3`,
      [versionId, userId, accessToType]
    )
  ).rows[0];

const revoke = (userId = BUYER_A) =>
  moderatorRevokeEarlyAccess({
    moderatorId: MODERATOR,
    userId,
    modelVersionId: VERSION_ID,
    reason: 'bought the wrong version',
  });

const hasAccess = async (userId: number) =>
  (await hasEntityAccess({ entityType: 'ModelVersion', entityIds: [VERSION_ID], userId }))[0]
    .hasAccess;

const refundedBuyers = async () =>
  (await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID })).purchases.map(
    (p) => p.buyerId
  );

describe('moderatorRevokeEarlyAccess', () => {
  it("takes that buyer's access on that version and keeps the purchase on record", async () => {
    await buy(VERSION_ID, BUYER_A);
    await buy(VERSION_ID, BUYER_B);
    await buy(OTHER_VERSION_ID, BUYER_A);
    await db.query(
      `INSERT INTO "EntityAccess" VALUES ($1, 'Model', $2, 'User', 3, '{}'::jsonb, NULL, now())`,
      [VERSION_ID, BUYER_A]
    );

    await expect(revoke()).resolves.toEqual({ revoked: true, permissions: 3 });

    const revoked = await grantOf(VERSION_ID, BUYER_A);
    expect(revoked.permissions).toBe(0);
    expect(revoked.meta).toEqual({
      revocations: [
        {
          'download-buzzTransactionId': `tx-${VERSION_ID}-${BUYER_A}`,
          'download-purchasedAt': PURCHASED_AT,
          revokedAt: expect.any(String),
          revokedById: MODERATOR,
          refundedExternally: true,
        },
      ],
    });
    expect((await grantOf(VERSION_ID, BUYER_B)).permissions).toBe(3);
    expect((await grantOf(OTHER_VERSION_ID, BUYER_A)).permissions).toBe(3);
    expect((await grantOf(VERSION_ID, BUYER_A, 'Model')).permissions).toBe(3);
    expect(mocks.bustMvCache).toHaveBeenCalledWith(VERSION_ID, MODEL_ID, BUYER_A);
    expect(mocks.trackModActivity).toHaveBeenCalledWith(MODERATOR, {
      entityType: 'modelVersion',
      activity: 'revokeEarlyAccess',
      entityId: VERSION_ID,
    });
  });

  it('moves no Buzz', async () => {
    await buy(VERSION_ID, BUYER_A);

    await revoke();

    expect((await grantOf(VERSION_ID, BUYER_A)).permissions, 'the revoke did not run').toBe(0);
    for (const fn of Object.values(mocks.buzz)) expect(fn).not.toHaveBeenCalled();
  });

  it('leaves the revoked buyer out of a later unpublish refund, and refunds the other buyer', async () => {
    await buy(VERSION_ID, BUYER_A);
    await buy(VERSION_ID, BUYER_B);
    expect(await refundedBuyers(), 'both purchases start refundable').toEqual([BUYER_A, BUYER_B]);

    await revoke();
    const requirement = await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });
    await refundModelEarlyAccessPurchases({ modelId: MODEL_ID, requirement, scope: 'version' });

    expect(requirement.purchases.map((p) => p.buyerId)).toEqual([BUYER_B]);
    expect(mocks.buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.buzz.refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: `tx-${VERSION_ID}-${BUYER_B}` })
    );
  });

  it('makes a later purchase refundable again, from its own date', async () => {
    await buy(VERSION_ID, BUYER_A);
    await revoke();

    await grantModelVersionAccess({
      userId: BUYER_A,
      modelVersionId: VERSION_ID,
      permissions: 1,
      meta: {
        // A different purchase type: a same-type purchase reuses the revoked one's ledger prefix.
        'generation-buzzTransactionId': `tx-gen-${VERSION_ID}-${BUYER_A}`,
        'generation-purchasedAt': new Date().toISOString(),
      },
      addedById: BUYER_A,
    });

    const requirement = await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });
    expect(requirement.purchases).toEqual([
      expect.objectContaining({
        buyerId: BUYER_A,
        buzzTransactionIds: [`tx-gen-${VERSION_ID}-${BUYER_A}`],
      }),
    ]);
  });

  it('keeps every revoke on record when a re-purchased grant is revoked again', async () => {
    await buy(VERSION_ID, BUYER_A);
    await revoke();
    await grantModelVersionAccess({
      userId: BUYER_A,
      modelVersionId: VERSION_ID,
      permissions: 3,
      meta: { 'download-buzzTransactionId': 'tx-second', 'download-purchasedAt': 'second' },
      addedById: BUYER_A,
    });

    await expect(revoke()).resolves.toEqual({ revoked: true, permissions: 3 });

    const { meta } = await grantOf(VERSION_ID, BUYER_A);
    expect(Object.keys(meta)).toEqual(['revocations']);
    expect(meta.revocations).toEqual([
      expect.objectContaining({ 'download-buzzTransactionId': `tx-${VERSION_ID}-${BUYER_A}` }),
      expect.objectContaining({ 'download-buzzTransactionId': 'tx-second' }),
    ]);
  });

  it('stops a gift claim re-granting through the same link; another claimer is unaffected', async () => {
    await db.query(`INSERT INTO "ModelVersionGiftLink" (id, "modelVersionId") VALUES ($1, $2)`, [
      GIFT_LINK,
      VERSION_ID,
    ]);
    const claim = (userId: number) =>
      redeemGiftLink(dbMock.dbWrite as never, {
        giftLinkId: GIFT_LINK,
        userId,
        modelVersionId: VERSION_ID,
        permissions: 1,
        addedById: 2,
      });
    expect(await claim(BUYER_A)).toBe('granted');
    expect(await claim(BUYER_B)).toBe('granted');

    await revoke(BUYER_A);

    expect(await claim(BUYER_A)).toBe('unavailable');
    expect((await grantOf(VERSION_ID, BUYER_A)).permissions).toBe(0);
    expect(await claim(BUYER_B), 'a repeat claim by a claimer not revoked still works').toBe(
      'granted'
    );
    expect((await grantOf(VERSION_ID, BUYER_B)).permissions).toBe(1);
  });

  it("leaves the buyer's gift claim on another version's link granted", async () => {
    const OTHER_LINK = GIFT_LINK + 1;
    await db.query(
      `INSERT INTO "ModelVersionGiftLink" (id, "modelVersionId") VALUES ($1, $2), ($3, $4)`,
      [GIFT_LINK, VERSION_ID, OTHER_LINK, OTHER_VERSION_ID]
    );
    for (const [giftLinkId, modelVersionId] of [
      [GIFT_LINK, VERSION_ID],
      [OTHER_LINK, OTHER_VERSION_ID],
    ]) {
      await redeemGiftLink(dbMock.dbWrite as never, {
        giftLinkId,
        userId: BUYER_A,
        modelVersionId,
        permissions: 1,
        addedById: 2,
      });
    }

    await revoke(BUYER_A);

    const claims = (
      await db.query<{ giftLinkId: number; revokedAt: Date | null }>(
        `SELECT "giftLinkId", "revokedAt" FROM "ModelVersionGiftRedemption" ORDER BY "giftLinkId"`
      )
    ).rows;
    expect(claims).toEqual([
      { giftLinkId: GIFT_LINK, revokedAt: expect.any(Date) },
      { giftLinkId: OTHER_LINK, revokedAt: null },
    ]);
    expect((await grantOf(OTHER_VERSION_ID, BUYER_A)).permissions).toBe(1);
  });

  it('revokes a grant from before permissions were recorded', async () => {
    await db.query(
      `INSERT INTO "EntityAccess" ("accessToId", "accessToType", "accessorId", "accessorType", permissions)
       VALUES ($1, 'ModelVersion', $2, 'User', 0)`,
      [VERSION_ID, BUYER_A]
    );
    expect(await hasAccess(BUYER_A)).toBe(true);

    await expect(revoke()).resolves.toEqual({ revoked: true, permissions: 0 });

    expect(await hasAccess(BUYER_A)).toBe(false);
    expect(mocks.bustMvCache).toHaveBeenCalled();
  });

  it('keeps the purchase record when a later gift claim on the row is removed', async () => {
    await buy(VERSION_ID, BUYER_A);
    await revoke();
    await db.query(`INSERT INTO "ModelVersionGiftLink" (id, "modelVersionId") VALUES ($1, $2)`, [
      GIFT_LINK,
      VERSION_ID,
    ]);
    await redeemGiftLink(dbMock.dbWrite as never, {
      giftLinkId: GIFT_LINK,
      userId: BUYER_A,
      modelVersionId: VERSION_ID,
      permissions: 1,
      addedById: 2,
    });

    await revokeGiftRedemption(dbMock.dbWrite as never, {
      giftLinkId: GIFT_LINK,
      claimerId: BUYER_A,
      modelVersionId: VERSION_ID,
      revokedById: 2,
      visibleSince: new Date(0),
    });

    const row = await grantOf(VERSION_ID, BUYER_A);
    expect(row?.permissions).toBe(0);
    expect(row?.meta).toMatchObject({
      revocations: [{ 'download-buzzTransactionId': `tx-${VERSION_ID}-${BUYER_A}` }],
    });
  });

  it('is a no-op on a grant never there, or already revoked', async () => {
    await buy(VERSION_ID, BUYER_B);
    await expect(revoke()).resolves.toEqual({ revoked: false });

    await buy(VERSION_ID, BUYER_A);
    await revoke();
    const once = await grantOf(VERSION_ID, BUYER_A);
    vi.clearAllMocks();

    await expect(revoke()).resolves.toEqual({ revoked: false });
    expect(await grantOf(VERSION_ID, BUYER_A)).toEqual(once);
    expect(mocks.trackModActivity).not.toHaveBeenCalled();
    expect(mocks.bustMvCache).not.toHaveBeenCalled();
  });

  it('still busts and records the revoke when one step after it fails', async () => {
    await buy(VERSION_ID, BUYER_A);
    mocks.bustMvCache.mockRejectedValueOnce(new Error('redis down'));
    await expect(revoke()).resolves.toEqual({ revoked: true, permissions: 3 });
    expect(mocks.trackModActivity).toHaveBeenCalled();

    vi.clearAllMocks();
    await buy(VERSION_ID, BUYER_B);
    mocks.trackModActivity.mockRejectedValueOnce(new Error('db down'));
    await expect(revoke(BUYER_B)).resolves.toEqual({ revoked: true, permissions: 3 });
    expect(mocks.bustMvCache).toHaveBeenCalledWith(VERSION_ID, MODEL_ID, BUYER_B);
  });
});
