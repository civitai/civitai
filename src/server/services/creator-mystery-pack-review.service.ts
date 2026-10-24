import {
  boxOddsSnapshotSchema,
  diffBoxSnapshots,
  type BoxDiffSide,
} from '@civitai/shared/box-odds-snapshot';
import { CREATOR_BOX_TIERS, creatorBoxPriceBounds } from '@civitai/shared/creator-box-rules';
import { ITEM_TYPE } from '@civitai/shared/mystery-box';
import { dbWrite } from '~/server/db/client';
import {
  COSMETIC_PRICE_FLOOR_MIN,
  SHELF_SALES_VALUE_THRESHOLD,
} from '~/server/schema/creator-shop.schema';
import { pendingRevisionOf } from '~/server/services/creator-mystery-pack-approve.service';
import { evaluateProposal } from '~/server/services/creator-mystery-pack.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import type { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * The review pane's read: the edit waiting, checked as approval would check it, and the live version
 * it would replace. Reads the primary, because the verdict names the revision this returns.
 */
export async function getMysteryPackReview({
  listingId,
  stickersEnabled,
}: {
  listingId: number;
  stickersEnabled: boolean;
}) {
  const [box] = await dbWrite.$queryRaw<
    {
      boxId: number;
      version: number;
      sellerId: number;
      listingStatus: CosmeticShopItemStatus;
      price: number;
    }[]
  >`
    SELECT d.id AS "boxId", d.version, d."sellerId", s.status::text AS "listingStatus",
      s."unitAmount" AS price
    FROM "CosmeticShopItem" s
    JOIN "ItemDefinition" d ON d.id = s."itemDefinitionId"
    WHERE s.id = ${listingId} AND d.type = ${ITEM_TYPE.box} AND d."sellerId" IS NOT NULL`;
  if (!box) throw throwNotFoundError('Mystery pack not found');

  const [revision, [liveRow]] = await Promise.all([
    pendingRevisionOf(dbWrite, box.boxId),
    dbWrite.$queryRaw<{ version: number; snapshot: unknown }[]>`
      SELECT version, snapshot FROM "BoxOddsSnapshot"
      WHERE "boxDefinitionId" = ${box.boxId}
      ORDER BY version DESC
      LIMIT 1`,
  ]);
  // At the listing's price, not the approval's: a price cut applies without a new version.
  const live = liveRow ? { ...liveOf(liveRow.version, liveRow.snapshot), price: box.price } : null;

  let proposed = null;
  if (revision) {
    const { steepness, tiers, price } = revision.proposal;
    const evaluated = await evaluateProposal(dbWrite, {
      creatorId: box.sellerId,
      steepness,
      tiers: tiers.map((tier) => tier.cosmeticIds),
      price,
      stickersEnabled,
    });
    const byId = new Map(evaluated.contents.map((content) => [content.cosmeticId, content]));
    const names = CREATOR_BOX_TIERS[tiers.length];
    proposed = {
      steepness,
      price,
      tiers: tiers.map((tier, t) => ({
        key: tier.key,
        name: names?.[t]?.name ?? tier.key,
        weight: evaluated.layout.ok ? evaluated.layout.weights[t] : null,
        count: tier.cosmeticIds.length,
      })),
      contents: tiers.flatMap((tier) =>
        tier.cosmeticIds.map((cosmeticId) => {
          const content = byId.get(cosmeticId);
          return {
            tier: tier.key,
            cosmeticId,
            listed: content?.listed ?? null,
            unitAmount: content?.unitAmount ?? null,
            value: content?.value ?? null,
            problem: content ? content.problem : "This item doesn't exist",
          };
        })
      ),
      layoutProblem: evaluated.layout.ok ? null : evaluated.layout.reason,
      bounds: evaluated.bounds,
      priceProblem: evaluated.priceProblem,
    };
  }

  const shownIds = [
    ...new Set([
      ...(proposed?.contents ?? []).map((c) => c.cosmeticId),
      ...(live?.contents ?? []).map((c) => c.cosmeticId),
    ]),
  ];
  const highValueIds = [
    ...new Set(
      [...(proposed?.contents ?? []), ...(live?.contents ?? [])]
        .filter((c) => (c.value ?? 0) > SHELF_SALES_VALUE_THRESHOLD)
        .map((c) => c.cosmeticId)
    ),
  ];
  const [cosmetics, sales] = await Promise.all([
    shownIds.length
      ? dbWrite.$queryRaw<{ id: number; name: string; type: CosmeticType; data: unknown }[]>`
          SELECT id, name, type::text AS type, data FROM "Cosmetic" WHERE id = ANY(${shownIds}::int[])`
      : [],
    highValueIds.length
      ? dbWrite.$queryRaw<{ cosmeticId: number; sales: number }[]>`
          SELECT s."cosmeticId", count(p."buzzTransactionId")::int AS sales
          FROM "CosmeticShopItem" s
          LEFT JOIN "UserCosmeticShopPurchases" p ON p."shopItemId" = s.id AND NOT p.refunded
          WHERE s."cosmeticId" = ANY(${highValueIds}::int[]) AND s."addedById" = ${box.sellerId}
          GROUP BY s."cosmeticId"`
      : [],
  ]);
  const salesById = new Map(sales.map((row) => [row.cosmeticId, row.sales]));

  const proposedSide: BoxDiffSide | null = proposed && {
    tiers: proposed.tiers,
    contents: proposed.contents,
    price: proposed.price,
  };
  return {
    boxId: box.boxId,
    version: box.version,
    listingStatus: box.listingStatus,
    price: box.price,
    revision: revision
      ? { id: revision.id, baseVersion: revision.baseVersion, createdAt: revision.createdAt }
      : null,
    proposed,
    live,
    diff: live && proposedSide ? diffBoxSnapshots(live, proposedSide) : null,
    cosmetics,
    shelfSales: highValueIds.map((cosmeticId) => ({
      cosmeticId,
      sales: salesById.get(cosmeticId) ?? 0,
    })),
  };
}

/** The live version as approved, with the price bounds its approval-time values give. */
function liveOf(version: number, raw: unknown) {
  const snapshot = boxOddsSnapshotSchema.parse(raw);
  const tierValues = snapshot.tiers.map((tier) => ({
    weight: tier.weight,
    values: snapshot.contents.filter((c) => c.tier === tier.key).map((c) => c.value),
  }));
  const valued = tierValues.every(
    (tier) => tier.values.length && tier.values.every((v) => v !== undefined)
  );
  return {
    version,
    ...snapshot,
    bounds: valued
      ? creatorBoxPriceBounds(
          tierValues.map((tier) => ({ weight: tier.weight, values: tier.values as number[] })),
          COSMETIC_PRICE_FLOOR_MIN
        )
      : null,
  };
}

export type MysteryPackReview = Awaited<ReturnType<typeof getMysteryPackReview>>;
