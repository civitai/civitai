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
  LowerMysteryPackPriceInput,
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
import { assertClientImageUrlsUsable } from '~/server/services/image-url-ownership';

/** The shape of `BoxRevision.proposal`. */
export type MysteryPackProposal = {
  steepness: CreatorBoxSteepness;
  tiers: { key: string; cosmeticIds: number[] }[];
  price: number;
};

export const MAX_LIVE_MYSTERY_PACKS = 5;
const TAKEDOWN_COOLDOWN_DAYS = 90;
/** Serialises one creator's pack writes, so the live-limit and one-pending-edit checks can't race. */
const MYSTERY_PACK_LOCK_CLASS = 0x434d0001;

type Tx = Prisma.TransactionClient;

export const lockCreator = (tx: Tx, userId: number) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(${MYSTERY_PACK_LOCK_CLASS}::int, ${userId}::int)`;

/** Reads the primary, not the session: a mute or ban the session hasn't seen must still count. */
export async function creatorIsRestricted(client: Tx, userId: number) {
  const [user] = await client.$queryRaw<
    { muted: boolean; bannedAt: Date | null; deletedAt: Date | null }[]
  >`SELECT muted, "bannedAt", "deletedAt" FROM "User" WHERE id = ${userId}`;
  return !user || user.muted || !!user.bannedAt || !!user.deletedAt;
}

export const hasPendingRevision = async (client: Tx, boxId: number) =>
  (
    await client.$queryRaw<{ pending: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "BoxRevision" WHERE "boxDefinitionId" = ${boxId} AND status = 'pending'
      ) AS pending`
  )[0].pending;

async function assertCreatorMayBuild({
  userId,
  countryCode,
}: {
  userId: number;
  countryCode: string | null;
}) {
  if (await creatorIsRestricted(dbWrite, userId))
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

export type EvaluatedContent = ContentRow & {
  /** Null while the content has a problem: only a valid listing has a value. */
  value: number | null;
  problem: string | null;
};

type ProposalInput = {
  creatorId: number;
  steepness: CreatorBoxSteepness;
  tiers: number[][];
  price: number;
  stickersEnabled: boolean;
};

/**
 * Every check `checkProposal` makes, reported rather than thrown, so the review pane can show why an
 * approval would fail. Values and checks each content by the creator's own listing of it
 * (`addedById`) only. Bounds are null unless the layout and every content are valid.
 */
export async function evaluateProposal(
  client: Tx,
  { creatorId, steepness, tiers, price, stickersEnabled }: ProposalInput
) {
  const ids = tiers.flat();
  const rows = await client.$queryRaw<ContentRow[]>`
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

  const now = new Date();
  const contents: EvaluatedContent[] = rows.map((row) => {
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
    const value = problem
      ? null
      : creatorBoxContentValue(
          { listed: row.listed!, unitAmount: row.unitAmount! },
          cosmeticPriceFloor(row.type)
        );
    return { ...row, value, problem };
  });

  const layout = creatorBoxWeights(
    tiers.map((tier) => tier.length),
    steepness
  );
  const values = new Map(contents.map((content) => [content.cosmeticId, content.value]));
  const allValued = !missing.length && contents.every((content) => content.value !== null);
  const bounds =
    layout.ok && allValued
      ? creatorBoxPriceBounds(
          tiers.map((tier, t) => ({
            weight: layout.weights[t],
            values: tier.map((id) => values.get(id)!),
          })),
          COSMETIC_PRICE_FLOOR_MIN
        )
      : null;
  return {
    missing,
    contents,
    layout,
    bounds,
    priceProblem: bounds ? creatorBoxPriceProblem(price, bounds) : null,
  };
}

/** `evaluateProposal`, refusing the first problem it finds. */
export async function checkProposal(
  client: Tx,
  input: ProposalInput
): Promise<{ proposal: MysteryPackProposal; weights: number[]; values: Map<number, number> }> {
  const { missing, contents, layout, priceProblem } = await evaluateProposal(client, input);
  if (missing.length) throw throwBadRequestError(`These items don't exist: ${missing.join(', ')}`);
  for (const content of contents) {
    // Named only when it's the creator's own: an id alone mustn't reveal another cosmetic's name.
    const label =
      content.createdById === input.creatorId ? content.name : `Item #${content.cosmeticId}`;
    if (content.problem) throw throwBadRequestError(`${label}: ${content.problem}`);
  }
  if (!layout.ok) throw throwBadRequestError(layout.reason);
  if (priceProblem) throw throwBadRequestError(priceProblem);

  const names = CREATOR_BOX_TIERS[input.tiers.length];
  return {
    proposal: {
      steepness: input.steepness,
      tiers: input.tiers.map((cosmeticIds, t) => ({ key: names[t].key, cosmeticIds })),
      price: input.price,
    },
    weights: layout.weights,
    values: new Map(contents.map((content) => [content.cosmeticId, content.value!])),
  };
}

/**
 * Sent-back, rejected and archived packs don't count as live; nor does a box a moderator archived,
 * whose listing they may have left Published.
 */
async function assertUnderLiveLimit(client: Tx, userId: number) {
  const [{ live }] = await client.$queryRaw<{ live: number }[]>`
    SELECT count(*)::int AS live
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    WHERE d."sellerId" = ${userId} AND d.type = ${ITEM_TYPE.box}
      AND d.status <> ${ITEM_DEFINITION_STATUS.archived}
      AND s.status IN ('PendingReview', 'Published')`;
  if (live >= MAX_LIVE_MYSTERY_PACKS)
    throw throwBadRequestError(
      `You can have at most ${MAX_LIVE_MYSTERY_PACKS} mystery packs on sale or in review`
    );
}

/** Writes an empty draft box with the proposal held in `BoxRevision`, so a draw never reads unreviewed contents. */
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
  if (imageUrl) await assertClientImageUrlsUsable({ urls: [imageUrl], userId, shopRow: {} });
  await assertCreatorMayBuild({ userId, countryCode });
  const { proposal } = await checkProposal(dbWrite, {
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

/** Someone else's box reads as not found. */
async function getOwnBox(tx: Tx, boxId: number, userId: number) {
  const [box] = await tx.$queryRaw<
    {
      id: number;
      version: number;
      status: string;
      listingId: number;
      listingStatus: CosmeticShopItemStatus;
      unitAmount: number;
      meta: CosmeticShopItemMeta | null;
    }[]
  >`
    SELECT d.id, d.version, d.status, s.id AS "listingId", s.status::text AS "listingStatus",
      s."unitAmount", s.meta
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
          ? Prisma.sql`, status = 'PendingReview', "rejectionReason" = NULL, "reviewedById" = NULL, "reviewedAt" = NULL`
          : status === 'Archived'
          ? Prisma.sql`, status = 'Archived', "archivedAt" = now()`
          : Prisma.empty
      }
    WHERE id = ${box.listingId}`;

/** The live version keeps selling while the edit waits in `BoxRevision`. */
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
  const { proposal } = await checkProposal(dbWrite, {
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
    if (await hasPendingRevision(tx, boxId))
      throw throwBadRequestError(
        'This mystery pack already has an edit waiting for review. Withdraw it first.'
      );
    // Back in the queue, a sent-back pack counts as live again.
    const backToReview = box.listingStatus === 'RequestedChanges';
    if (backToReview) await assertUnderLiveLimit(tx, userId);

    const [revision] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "BoxRevision" ("boxDefinitionId", "baseVersion", proposal, "submittedById")
      VALUES (${boxId}, ${box.version}, ${JSON.stringify(proposal)}::jsonb, ${userId})
      RETURNING id`;
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
 * A pack that never went on sale is archived with its edit, or on its own once sent back; the
 * submission fee is kept.
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
    const neverSold = box.status === ITEM_DEFINITION_STATUS.draft;
    const sentBack = neverSold && box.listingStatus === 'RequestedChanges';
    if (!withdrawn && !sentBack)
      throw throwBadRequestError('This mystery pack has no edit waiting for review');

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
 * A cut needs no review: the approved price was within the bounds, so a lower one above the floor is
 * too. Refused while an edit waits, whose approval would set its own price.
 */
export async function lowerMysteryPackPrice({
  userId,
  boxId,
  price,
}: LowerMysteryPackPriceInput & { userId: number }) {
  return dbWrite.$transaction(async (tx) => {
    await lockCreator(tx, userId);
    const box = await getOwnBox(tx, boxId, userId);
    if (box.listingStatus !== 'Published')
      throw throwBadRequestError('Only a mystery pack on sale can be repriced');
    if (await hasPendingRevision(tx, boxId))
      throw throwBadRequestError(
        'This mystery pack has an edit waiting for review. Set the price in that edit instead.'
      );
    if (price >= box.unitAmount)
      throw throwBadRequestError(
        `The new price must be below ${box.unitAmount}. Raising it is an edit, which goes to review.`
      );
    if (price < COSMETIC_PRICE_FLOOR_MIN)
      throw throwBadRequestError(`The price is at least ${COSMETIC_PRICE_FLOOR_MIN}`);

    const meta = appendItemHistory(box.meta ?? { purchases: 0 }, {
      at: new Date().toISOString(),
      userId,
      kind: 'edited',
      status: box.listingStatus,
      note: 'Mystery pack price lowered',
      changes: [{ field: 'price', from: box.unitAmount, to: price }],
    });
    await tx.$executeRaw`
      UPDATE "CosmeticShopItem"
      SET "unitAmount" = ${price}, meta = ${JSON.stringify(meta)}::jsonb
      WHERE id = ${box.listingId}`;
    return { boxId, price };
  });
}

/** Refuses when the cosmetic is an enabled content of this seller's published mystery pack. */
export async function assertNotInLiveMysteryPack({
  cosmeticId,
  sellerId,
}: {
  cosmeticId: number;
  sellerId: number;
}) {
  const [box] = await dbWrite.$queryRaw<{ name: string }[]>`
    SELECT d.name
    FROM "ItemDefinition" r
    JOIN "BoxContent" bc ON bc."rewardDefinitionId" = r.id AND bc.enabled
    JOIN "ItemDefinition" d ON d.id = bc."boxDefinitionId"
    WHERE r."cosmeticId" = ${cosmeticId}
      AND d.status = ${ITEM_DEFINITION_STATUS.published}
      AND d."sellerId" = ${sellerId}
    LIMIT 1`;
  if (box)
    throw throwBadRequestError(
      `This item is in the mystery pack "${box.name}". Remove it from the pack first.`
    );
}
