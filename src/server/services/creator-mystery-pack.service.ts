import { Prisma } from '@prisma/client';
import {
  CREATOR_BOX_TIERS,
  creatorBoxContentProblem,
  creatorBoxContentValue,
  creatorBoxPriceBounds,
  creatorBoxPriceProblem,
  creatorBoxWeights,
  type CreatorBoxCandidate,
  type CreatorBoxSteepness,
} from '@civitai/shared/creator-box-rules';
import { ITEM_DEFINITION_STATUS, ITEM_TYPE } from '@civitai/shared/mystery-box';
import { dbWrite } from '~/server/db/client';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type {
  ReviseMysteryPackInput,
  SubmitMysteryPackInput,
  WithdrawMysteryPackRevisionInput,
} from '~/server/schema/creator-shop.schema';
import {
  COSMETIC_PRICE_FLOOR_MIN,
  cosmeticPriceFloor,
  creatorCosmeticTypes,
} from '~/server/schema/creator-shop.schema';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { assertQuotedFee, getCreatorShopFees } from '~/server/services/creator-shop-fees.service';
import { buildRightsAffirmation } from '~/server/services/creator-shop-pack.service';
import { appendItemHistory, REJECTED_IS_FINAL } from '~/server/services/creator-shop.data';
import {
  getMysteryBoxBlockedRegions,
  isMysteryBoxBlockedIn,
} from '~/server/services/mystery-box.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/** `BoxRevision.proposal`: what review approves and the approve step applies. */
export type MysteryPackProposal = {
  steepness: CreatorBoxSteepness;
  tiers: { key: string; cosmeticIds: number[] }[];
  price: number;
};

export const MAX_LIVE_MYSTERY_PACKS = 5;
const TAKEDOWN_COOLDOWN_DAYS = 90;
/** `pg_advisory_xact_lock(class, creatorId)`: one creator's mystery pack writes, one at a time. */
const MYSTERY_PACK_LOCK_CLASS = 0x434d0001;

type Tx = Prisma.TransactionClient;

const lockCreator = (tx: Tx, userId: number) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(${MYSTERY_PACK_LOCK_CLASS}::int, ${userId}::int)`;

/**
 * Refuses a creator who may not build mystery packs: muted, banned or deleted, one of their items
 * taken down in the last 90 days, or in a region where mystery boxes are blocked. Read from the
 * primary, not the session, which can be stale.
 */
async function assertCreatorMayBuild({
  userId,
  countryCode,
}: {
  userId: number;
  countryCode: string | null;
}) {
  const [user] = await dbWrite.$queryRaw<
    { muted: boolean; bannedAt: Date | null; deletedAt: Date | null }[]
  >`SELECT muted, "bannedAt", "deletedAt" FROM "User" WHERE id = ${userId}`;
  if (!user || user.muted || user.bannedAt || user.deletedAt)
    throw throwAuthorizationError("You can't build mystery packs right now");

  // `takedown.at` is an ISO string, which sorts as the time it names.
  const cutoff = new Date(Date.now() - TAKEDOWN_COOLDOWN_DAYS * 86_400_000).toISOString();
  const [{ takenDown }] = await dbWrite.$queryRaw<{ takenDown: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "CosmeticShopItem"
      WHERE "addedById" = ${userId}
        AND status = 'Archived'
        AND meta->'takedown'->>'at' > ${cutoff}
    ) AS "takenDown"`;
  if (takenDown)
    throw throwAuthorizationError(
      `You can't build mystery packs for ${TAKEDOWN_COOLDOWN_DAYS} days after one of your items is taken down`
    );

  if (isMysteryBoxBlockedIn(countryCode, await getMysteryBoxBlockedRegions()))
    throw throwBadRequestError('Mystery packs are not available in your region');
}

type ContentRow = {
  cosmeticId: number;
  name: string;
  type: CosmeticType;
  createdById: number | null;
  data: unknown;
  addedById: number | null;
  status: CosmeticShopItemStatus | null;
  archivedAt: Date | null;
  availableQuantity: number | null;
  availableFrom: Date | null;
  availableTo: Date | null;
  listed: boolean | null;
  unitAmount: number | null;
};

/**
 * The proposal as review will see it, once every content, the tier layout and the price pass the
 * creator box rules. Each content is judged by the creator's OWN listing of it (`addedById`), never
 * by another seller's: a reseller's pricier listing must not raise its value.
 */
async function checkProposal({
  creatorId,
  steepness,
  tiers,
  price,
  stickersEnabled,
}: {
  creatorId: number;
  steepness: CreatorBoxSteepness;
  tiers: number[][];
  price: number;
  stickersEnabled: boolean;
}): Promise<MysteryPackProposal> {
  const ids = tiers.flat();
  const rows = await dbWrite.$queryRaw<ContentRow[]>`
    SELECT c.id AS "cosmeticId", c.name, c.type::text AS type, c."createdById", c.data,
      l."addedById", l.status::text AS status, l."archivedAt", l."availableQuantity",
      l."availableFrom", l."availableTo", l.listed, l."unitAmount"
    FROM "Cosmetic" c
    LEFT JOIN LATERAL (
      SELECT s."addedById", s.status, s."archivedAt", s."availableQuantity", s."availableFrom",
        s."availableTo", s.listed, s."unitAmount"
      FROM "CosmeticShopItem" s
      WHERE s."cosmeticId" = c.id AND s."addedById" = ${creatorId}
      ORDER BY (s.status = 'Published' AND s."archivedAt" IS NULL) DESC, s.id DESC
      LIMIT 1
    ) l ON true
    WHERE c.id = ANY(${ids}::int[])`;
  const byId = new Map(rows.map((row) => [row.cosmeticId, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw throwBadRequestError(`These items don't exist: ${missing.join(', ')}`);

  const now = new Date();
  for (const row of rows) {
    const candidate: CreatorBoxCandidate = {
      cosmeticId: row.cosmeticId,
      type: row.type,
      createdById: row.createdById,
      data: row.data,
      listing:
        row.status === null
          ? null
          : {
              addedById: row.addedById,
              status: row.status,
              archivedAt: row.archivedAt,
              availableQuantity: row.availableQuantity,
              availableFrom: row.availableFrom,
              availableTo: row.availableTo,
            },
    };
    const problem = creatorBoxContentProblem(candidate, {
      creatorId,
      types: creatorCosmeticTypes,
      stickersEnabled,
      now,
    });
    if (problem) throw throwBadRequestError(`${row.name}: ${problem}`);
  }

  const layout = creatorBoxWeights(
    tiers.map((tier) => tier.length),
    steepness
  );
  if (!layout.ok) throw throwBadRequestError(layout.reason);

  const bounds = creatorBoxPriceBounds(
    tiers.map((tier, t) => ({
      weight: layout.weights[t],
      values: tier.map((id) => {
        const row = byId.get(id)!;
        return creatorBoxContentValue(
          { listed: row.listed!, unitAmount: row.unitAmount! },
          cosmeticPriceFloor(row.type)
        );
      }),
    })),
    COSMETIC_PRICE_FLOOR_MIN
  );
  const priceProblem = creatorBoxPriceProblem(price, bounds);
  if (priceProblem) throw throwBadRequestError(priceProblem);

  const names = CREATOR_BOX_TIERS[tiers.length];
  return {
    steepness,
    tiers: tiers.map((cosmeticIds, t) => ({ key: names[t].key, cosmeticIds })),
    price,
  };
}

/** Live: waiting for review or on sale. Archived, rejected and sent-back packs don't count. */
async function assertUnderLiveLimit(client: Tx, userId: number) {
  const [{ live }] = await client.$queryRaw<{ live: number }[]>`
    SELECT count(*)::int AS live
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    WHERE d."sellerId" = ${userId} AND d.type = ${ITEM_TYPE.box}
      AND s.status IN ('PendingReview', 'Published')`;
  if (live >= MAX_LIVE_MYSTERY_PACKS)
    throw throwBadRequestError(
      `You can have at most ${MAX_LIVE_MYSTERY_PACKS} mystery packs on sale or in review`
    );
}

/**
 * Charges the submission fee, then writes the box (a draft with no tiers or contents yet), its
 * unlisted listing in review, and the proposal as a pending revision. Approval writes the tiers and
 * contents, so nothing unreviewed is ever a box row a draw could read.
 */
export async function submitMysteryPack({
  userId,
  countryCode,
  stickersEnabled,
  name,
  description,
  imageUrl,
  rightsAffirmed,
  buzzType,
  quotedFee,
  steepness,
  tiers,
  price,
}: SubmitMysteryPackInput & {
  userId: number;
  countryCode: string | null;
  stickersEnabled: boolean;
}) {
  await throwOnBlockedUserContent([name, description], { surface: 'creatorShop' });
  if (imageUrl && !rightsAffirmed)
    throw throwBadRequestError('You must confirm you have the rights to sell this artwork');
  await assertCreatorMayBuild({ userId, countryCode });
  const proposal = await checkProposal({
    creatorId: userId,
    steepness,
    tiers,
    price,
    stickersEnabled,
  });
  // Asked again under the lock below; asked here too so a creator at the limit isn't charged.
  await assertUnderLiveLimit(dbWrite, userId);

  const submissionFee = (await getCreatorShopFees()).mysteryPack;
  assertQuotedFee(quotedFee, submissionFee);
  const feeTx = await createBuzzTransaction({
    fromAccountId: userId,
    fromAccountType: buzzType as BuzzSpendType,
    toAccountId: 0,
    amount: submissionFee,
    type: TransactionType.Purchase,
    description: `Creator Shop mystery pack submission fee - ${name}`,
    externalTransactionId: `creator-shop-mystery-pack-submit-${userId}-${Date.now()}`,
  });
  const feeTxId = feeTx.transactionId;
  if (!feeTxId) throw throwBadRequestError('Unable to charge the submission fee');

  try {
    return await dbWrite.$transaction(async (tx) => {
      await lockCreator(tx, userId);
      await assertUnderLiveLimit(tx, userId);

      const [box] = await tx.$queryRaw<{ id: number; version: number }[]>`
        INSERT INTO "ItemDefinition"
          (type, name, description, "imageUrl", status, params, "createdById", "updatedById", "sellerId")
        VALUES (${ITEM_TYPE.box}, ${name}, ${description ?? null}, ${imageUrl ?? null},
          ${ITEM_DEFINITION_STATUS.draft}, ${JSON.stringify({ emptyRule: 'keep' })}::jsonb,
          ${userId}, ${userId}, ${userId})
        RETURNING id, version`;
      const meta = appendItemHistory(
        {
          purchases: 0,
          submissionTxId: feeTxId,
          submissionFee,
          ...(imageUrl ? { rightsAffirmation: buildRightsAffirmation(userId) } : {}),
        },
        { at: new Date().toISOString(), userId, kind: 'submitted', status: 'PendingReview' }
      );
      // Unlisted: a box listing is sold only through the box's own surface (a CHECK holds it).
      const [listing] = await tx.$queryRaw<{ id: number }[]>`
        INSERT INTO "CosmeticShopItem"
          ("cosmeticId", "itemDefinitionId", "unitAmount", title, description, "addedById", status, listed, meta)
        VALUES (NULL, ${box.id}, ${price}, ${name}, ${description ?? null}, ${userId},
          'PendingReview', false, ${JSON.stringify(meta)}::jsonb)
        RETURNING id`;
      await tx.$executeRaw`
        INSERT INTO "BoxRevision" ("boxDefinitionId", "baseVersion", proposal, "submittedById")
        VALUES (${box.id}, ${box.version}, ${JSON.stringify(proposal)}::jsonb, ${userId})`;
      return { boxId: box.id, shopItemId: listing.id };
    });
  } catch (error) {
    await refundTransaction(feeTxId, 'Creator Shop mystery pack submission failed');
    throw error;
  }
}

/** The creator's own box and its listing. Someone else's box reads as not found. */
async function getOwnBox(tx: Tx, boxId: number, userId: number) {
  const [box] = await tx.$queryRaw<
    {
      id: number;
      version: number;
      status: string;
      listingId: number;
      listingStatus: CosmeticShopItemStatus;
      meta: CosmeticShopItemMeta | null;
    }[]
  >`
    SELECT d.id, d.version, d.status, s.id AS "listingId", s.status::text AS "listingStatus", s.meta
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    WHERE d.id = ${boxId} AND d.type = ${ITEM_TYPE.box} AND d."sellerId" = ${userId}
    ORDER BY s.id
    LIMIT 1`;
  if (!box) throw throwNotFoundError('Mystery pack not found');
  return box;
}

const addHistory = (
  tx: Tx,
  box: { listingId: number; meta: CosmeticShopItemMeta | null },
  entry: Parameters<typeof appendItemHistory>[1],
  status?: 'PendingReview' | 'Archived'
) =>
  tx.$executeRaw`
    UPDATE "CosmeticShopItem"
    SET meta = ${JSON.stringify(appendItemHistory(box.meta ?? { purchases: 0 }, entry))}::jsonb
      ${
        status === 'PendingReview'
          ? Prisma.sql`, status = 'PendingReview'`
          : status === 'Archived'
          ? Prisma.sql`, status = 'Archived', "archivedAt" = now()`
          : Prisma.empty
      }
    WHERE id = ${box.listingId}`;

/**
 * Sends an edit of a live (or sent-back) mystery pack to review. The live version keeps selling;
 * approval applies the edit as the box's next version, if the box is still at `baseVersion`.
 */
export async function reviseMysteryPack({
  userId,
  countryCode,
  stickersEnabled,
  boxId,
  steepness,
  tiers,
  price,
}: ReviseMysteryPackInput & {
  userId: number;
  countryCode: string | null;
  stickersEnabled: boolean;
}) {
  await assertCreatorMayBuild({ userId, countryCode });
  const proposal = await checkProposal({
    creatorId: userId,
    steepness,
    tiers,
    price,
    stickersEnabled,
  });

  return dbWrite.$transaction(async (tx) => {
    await lockCreator(tx, userId);
    const box = await getOwnBox(tx, boxId, userId);
    if (box.listingStatus === 'Rejected') throw throwBadRequestError(REJECTED_IS_FINAL);
    if (box.listingStatus !== 'Published' && box.listingStatus !== 'RequestedChanges')
      throw throwBadRequestError("This mystery pack can't be edited right now");
    const [{ pending }] = await tx.$queryRaw<{ pending: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "BoxRevision" WHERE "boxDefinitionId" = ${boxId} AND status = 'pending'
      ) AS pending`;
    if (pending)
      throw throwBadRequestError(
        'This mystery pack already has an edit waiting for review. Withdraw it first.'
      );

    const [revision] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "BoxRevision" ("boxDefinitionId", "baseVersion", proposal, "submittedById")
      VALUES (${boxId}, ${box.version}, ${JSON.stringify(proposal)}::jsonb, ${userId})
      RETURNING id`;
    // A pack sent back before it ever sold goes back to the queue; a live one stays on sale.
    const backToReview = box.listingStatus === 'RequestedChanges';
    await addHistory(
      tx,
      box,
      {
        at: new Date().toISOString(),
        userId,
        kind: 'edited',
        status: backToReview ? 'PendingReview' : box.listingStatus,
        note: 'Mystery pack edit sent for review',
      },
      backToReview ? 'PendingReview' : undefined
    );
    return { boxId, revisionId: revision.id };
  });
}

/**
 * Withdraws the pack's edit waiting for review. A pack that never went on sale is withdrawn with it:
 * the box and its listing are archived, and the submission fee is kept, as for a rejection.
 */
export async function withdrawMysteryPackRevision({
  userId,
  boxId,
}: WithdrawMysteryPackRevisionInput & { userId: number }) {
  return dbWrite.$transaction(async (tx) => {
    await lockCreator(tx, userId);
    const box = await getOwnBox(tx, boxId, userId);
    const withdrawn = await tx.$executeRaw`
      UPDATE "BoxRevision" SET status = 'withdrawn'
      WHERE "boxDefinitionId" = ${boxId} AND status = 'pending'`;
    if (!withdrawn) throw throwBadRequestError('This mystery pack has no edit waiting for review');

    const neverSold = box.status === ITEM_DEFINITION_STATUS.draft;
    if (neverSold)
      await tx.$executeRaw`
        UPDATE "ItemDefinition"
        SET status = ${ITEM_DEFINITION_STATUS.archived}, "updatedById" = ${userId}, "updatedAt" = now()
        WHERE id = ${boxId}`;
    await addHistory(
      tx,
      box,
      {
        at: new Date().toISOString(),
        userId,
        kind: 'edited',
        status: neverSold ? 'Archived' : box.listingStatus,
        note: neverSold ? 'Mystery pack withdrawn' : 'Mystery pack edit withdrawn',
      },
      neverSold ? 'Archived' : undefined
    );
    return { boxId, archived: neverSold };
  });
}

/**
 * Refuses a creator's change that would take this cosmetic out of a mystery pack on sale without
 * review (archiving its listing, capping it, or sending it back to review). Delisting is allowed:
 * the item stays in the pack as a box-only item.
 */
export async function assertNotInLiveMysteryPack(cosmeticId: number) {
  const [box] = await dbWrite.$queryRaw<{ name: string }[]>`
    SELECT d.name
    FROM "ItemDefinition" r
    JOIN "BoxContent" bc ON bc."rewardDefinitionId" = r.id AND bc.enabled
    JOIN "ItemDefinition" d ON d.id = bc."boxDefinitionId"
    WHERE r."cosmeticId" = ${cosmeticId}
      AND d.status = ${ITEM_DEFINITION_STATUS.published}
      AND d."sellerId" IS NOT NULL
    LIMIT 1`;
  if (box)
    throw throwBadRequestError(
      `This item is in the mystery pack "${box.name}". Remove it from the pack first.`
    );
}
