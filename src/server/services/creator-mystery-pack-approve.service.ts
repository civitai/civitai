import { Prisma } from '@prisma/client';
import {
  assertDraftFitsRows,
  boxChecklist,
  BoxRefusal,
  keptContentIds,
  planContentWrites,
  planTierWrites,
  tierIdsWithInserted,
  type BoxContentRow,
  type BoxTierRow,
  type DraftContent,
  type DraftTier,
} from '@civitai/shared/box-builder';
import { snapshotOfLiveBox } from '@civitai/shared/box-odds-snapshot';
import { CREATOR_BOX_TIERS } from '@civitai/shared/creator-box-rules';
import { cosmeticTeamOf, ITEM_DEFINITION_STATUS, ITEM_TYPE } from '@civitai/shared/mystery-box';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { ReviewCreatorShopItemInput } from '~/server/schema/creator-shop.schema';
import { lockBox } from '~/server/services/box-version-lock';
import {
  checkProposal,
  creatorIsRestricted,
  lockCreator,
  type MysteryPackProposal,
} from '~/server/services/creator-mystery-pack.service';
import {
  recordShopVerdict,
  SHOP_VERDICT_TRANSACTION,
} from '~/server/services/creator-shop-labels.service';
import { appendItemHistory } from '~/server/services/creator-shop.data';
import { createNotification } from '~/server/services/notification.service';
import {
  isPrismaLockTimeout,
  throwBadRequestError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import type { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

type Tx = Prisma.TransactionClient;
type ReviewAction = ReviewCreatorShopItemInput['action'];

const REJECTED_FINAL = 'This mystery pack was rejected, which is final.';
const EDIT_CHANGED =
  "This pack's edit changed since you opened it. Reload to review the one waiting now.";
const OWN_PACK = "You can't review your own mystery pack.";
const STALE =
  'This mystery pack changed after the edit was made, so the edit no longer applies. The creator has to edit it again.';

type ReviewedBox = {
  id: number;
  name: string;
  status: string;
  version: number;
  updatedAt: Date;
  listingId: number;
  listingStatus: CosmeticShopItemStatus;
  title: string;
  meta: CosmeticShopItemMeta | null;
};

async function readBox(tx: Tx, boxId: number) {
  const [box] = await tx.$queryRaw<ReviewedBox[]>`
    SELECT d.id, d.name, d.status, d.version, d."updatedAt", s.id AS "listingId",
      s.status::text AS "listingStatus", s.title, s.meta
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    WHERE d.id = ${boxId} AND d.type = ${ITEM_TYPE.box} AND d."sellerId" IS NOT NULL
    ORDER BY s.id
    LIMIT 1`;
  if (!box) throw throwNotFoundError('Mystery pack not found');
  return box;
}

export const pendingRevisionOf = async (tx: Tx, boxId: number) =>
  (
    await tx.$queryRaw<
      { id: number; baseVersion: number; proposal: MysteryPackProposal; createdAt: Date }[]
    >`
      SELECT id, "baseVersion", proposal, "createdAt" FROM "BoxRevision"
      WHERE "boxDefinitionId" = ${boxId} AND status = 'pending'`
  )[0];

const closeRevision = (
  tx: Tx,
  revisionId: number,
  {
    status,
    reviewerId,
    note,
    appliedVersion,
  }: {
    status: 'approved' | 'rejected' | 'stale';
    reviewerId: number;
    note?: string;
    appliedVersion?: number;
  }
) =>
  tx.$executeRaw`
    UPDATE "BoxRevision"
    SET status = ${status}, "reviewedById" = ${reviewerId}, "reviewedAt" = now(),
      note = ${note ?? null}, "appliedVersion" = ${appliedVersion ?? null}
    WHERE id = ${revisionId}`;

/**
 * A pack waiting for review goes back to its creator, who can then edit it again. Says whether it
 * did, so the creator is told.
 */
async function markStale(tx: Tx, revisionId: number, box: ReviewedBox, moderatorId: number) {
  await closeRevision(tx, revisionId, { status: 'stale', reviewerId: moderatorId });
  if (box.listingStatus !== 'PendingReview') return false;
  const meta = appendItemHistory(box.meta ?? { purchases: 0 }, {
    at: new Date().toISOString(),
    userId: moderatorId,
    kind: 'reviewed',
    status: 'RequestedChanges',
    action: 'request-changes',
    note: STALE,
  });
  await tx.$executeRaw`
    UPDATE "CosmeticShopItem"
    SET status = 'RequestedChanges', "rejectionReason" = ${STALE}, "reviewedById" = ${moderatorId},
      "reviewedAt" = now(), meta = ${JSON.stringify(meta)}::jsonb
    WHERE id = ${box.listingId}`;
  return true;
}

/** Defines each content's cosmetic as a reward if it isn't one yet, as the builder's define step does. */
async function defineRewards(tx: Tx, cosmeticIds: number[], userId: number) {
  await tx.$executeRaw`
    INSERT INTO "ItemDefinition" (type, name, "cosmeticId", status, "createdById", "updatedById")
    SELECT ${ITEM_TYPE.cosmetic}, c.name, c.id, ${ITEM_DEFINITION_STATUS.published}, ${userId}, ${userId}
    FROM "Cosmetic" c
    WHERE c.id = ANY(${cosmeticIds}::int[])
    ON CONFLICT ("cosmeticId") DO NOTHING`;
  const rows = await tx.$queryRaw<
    { id: number; type: string; cosmeticId: number; data: unknown }[]
  >`
    SELECT d.id, d.type, d."cosmeticId", c.data
    FROM "ItemDefinition" d
    JOIN "Cosmetic" c ON c.id = d."cosmeticId"
    WHERE d."cosmeticId" = ANY(${cosmeticIds}::int[])`;
  return new Map(
    rows.map((row) => [
      row.cosmeticId,
      { id: row.id, type: row.type, team: cosmeticTeamOf(row.data) ?? null },
    ])
  );
}

async function readRows(tx: Tx, boxId: number) {
  const [tiers, contents] = await Promise.all([
    tx.$queryRaw<BoxTierRow[]>`
      SELECT id, key, name, weight, color, "sortOrder" FROM "BoxTier"
      WHERE "boxDefinitionId" = ${boxId}`,
    tx.$queryRaw<BoxContentRow[]>`
      SELECT id, "rewardDefinitionId", "tierId", enabled FROM "BoxContent"
      WHERE "boxDefinitionId" = ${boxId}`,
  ]);
  return { tiers, contents };
}

/** The proposal as a builder draft over the box's rows: a kept tier or content keeps its id. */
function draftOf(
  proposal: MysteryPackProposal,
  weights: number[],
  rewardIdOf: (cosmeticId: number) => number,
  rows: Awaited<ReturnType<typeof readRows>>
) {
  const tierByKey = new Map(rows.tiers.map((tier) => [tier.key, tier]));
  const contentIdByReward = new Map(
    rows.contents.map((content) => [content.rewardDefinitionId, content.id])
  );
  const names = CREATOR_BOX_TIERS[proposal.tiers.length];
  const tiers: DraftTier[] = proposal.tiers.map((tier, t) => ({
    id: tierByKey.get(tier.key)?.id ?? null,
    key: tier.key,
    name: names[t].name,
    weight: weights[t],
    // A creator can't pick tier colours; one a moderator set is kept.
    color: tierByKey.get(tier.key)?.color ?? null,
  }));
  const contents: DraftContent[] = proposal.tiers.flatMap((tier) =>
    tier.cosmeticIds.map((cosmeticId) => {
      const rewardDefinitionId = rewardIdOf(cosmeticId);
      return {
        id: contentIdByReward.get(rewardDefinitionId) ?? null,
        rewardDefinitionId,
        tierKey: tier.key,
        enabled: true,
      };
    })
  );
  return { tiers, contents };
}

/** The builder's save on Prisma, in the builder's order: changed rows only, batched. */
async function writeTiersAndContents(
  tx: Tx,
  boxId: number,
  draft: ReturnType<typeof draftOf>,
  rows: Awaited<ReturnType<typeof readRows>>
) {
  assertDraftFitsRows(draft, rows.tiers, rows.contents);

  // Contents first: removed contents free the (box, reward) slot and let a removed tier go
  // (BoxContent.tierId is RESTRICT).
  const kept = keptContentIds(draft);
  await tx.$executeRaw`
    DELETE FROM "BoxContent"
    WHERE "boxDefinitionId" = ${boxId} AND NOT (id = ANY(${kept}::int[]))`;

  const plan = planTierWrites(boxId, draft, rows.tiers);
  const inserted = plan.newTiers.length
    ? await tx.$queryRaw<{ id: number; key: string }[]>`
        INSERT INTO "BoxTier" ("boxDefinitionId", key, name, weight, color, "sortOrder")
        VALUES ${Prisma.join(
          plan.newTiers.map(
            (tier) =>
              Prisma.sql`(${boxId}::int, ${tier.key}, ${tier.name}, ${tier.weight}::int, ${tier.color}, ${tier.sortOrder}::int)`
          )
        )}
        RETURNING id, key`
    : [];
  const tierIdByKey = tierIdsWithInserted(plan, inserted);
  if (plan.changedTiers.length)
    await tx.$executeRaw`
      UPDATE "BoxTier" AS t
      SET name = v.name, weight = v.weight, color = v.color, "sortOrder" = v."sortOrder"
      FROM (VALUES ${Prisma.join(
        plan.changedTiers.map(
          (tier) =>
            Prisma.sql`(${tier.id}::int, ${tier.name}::text, ${tier.weight}::int, ${tier.color}::text, ${tier.sortOrder}::int)`
        )
      )}) AS v(id, name, weight, color, "sortOrder")
      WHERE t.id = v.id AND t."boxDefinitionId" = ${boxId}`;

  const { newContents, changedContents } = planContentWrites(
    boxId,
    draft,
    rows.contents,
    tierIdByKey
  );
  if (newContents.length)
    await tx.$executeRaw`
      INSERT INTO "BoxContent" ("boxDefinitionId", "tierId", "rewardDefinitionId", enabled)
      VALUES ${Prisma.join(
        newContents.map(
          (content) =>
            Prisma.sql`(${boxId}::int, ${content.tierId}::int, ${content.rewardDefinitionId}::int, ${content.enabled})`
        )
      )}`;
  if (changedContents.length)
    await tx.$executeRaw`
      UPDATE "BoxContent" AS c
      SET "tierId" = v."tierId", enabled = v.enabled
      FROM (VALUES ${Prisma.join(
        changedContents.map(
          (content) =>
            Prisma.sql`(${content.id}::int, ${content.tierId}::int, ${content.enabled}::boolean)`
        )
      )}) AS v(id, "tierId", enabled)
      WHERE c.id = v.id AND c."boxDefinitionId" = ${boxId}`;

  await tx.$executeRaw`
    DELETE FROM "BoxTier"
    WHERE "boxDefinitionId" = ${boxId} AND NOT (id = ANY(${[...tierIdByKey.values()]}::int[]))`;
}

/** The written rows, for the checklist and the snapshot. */
async function readWritten(tx: Tx, boxId: number) {
  const [tiers, contents] = await Promise.all([
    tx.$queryRaw<(BoxTierRow & { sortOrder: number })[]>`
      SELECT id, key, name, weight, color, "sortOrder" FROM "BoxTier"
      WHERE "boxDefinitionId" = ${boxId}
      ORDER BY "sortOrder", id`,
    tx.$queryRaw<
      {
        id: number;
        rewardDefinitionId: number;
        tierId: number;
        enabled: boolean;
        type: string;
        cosmeticId: number | null;
        data: unknown;
      }[]
    >`
      SELECT bc.id, bc."rewardDefinitionId", bc."tierId", bc.enabled, d.type, d."cosmeticId", c.data
      FROM "BoxContent" bc
      JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
      LEFT JOIN "Cosmetic" c ON c.id = d."cosmeticId"
      WHERE bc."boxDefinitionId" = ${boxId}`,
  ]);
  return { tiers, contents };
}

/**
 * Applies the box's pending revision and publishes it: tiers, contents, a new version and its odds
 * snapshot, and the listing on sale at the proposal's price.
 *
 * Everything that doesn't need the box row runs first, under the creator's lock only. The box row is
 * locked last because every open of this box waits on it until commit.
 */
export async function applyBoxRevision({
  boxId,
  moderatorId,
  stickersEnabled,
  note,
  revisionId,
}: {
  boxId: number;
  moderatorId: number;
  stickersEnabled: boolean;
  note?: string;
  /** The edit the moderator reviewed; approval refuses any other. */
  revisionId: number;
}) {
  const [owner] = await dbWrite.$queryRaw<{ sellerId: number }[]>`
    SELECT "sellerId" FROM "ItemDefinition"
    WHERE id = ${boxId} AND type = ${ITEM_TYPE.box} AND "sellerId" IS NOT NULL`;
  if (!owner) throw throwNotFoundError('Mystery pack not found');

  let outcome;
  try {
    outcome = await dbWrite.$transaction(async (tx) => {
      // Same lock every pack write takes.
      await lockCreator(tx, owner.sellerId);
      const box = await readBox(tx, boxId);
      if (box.status === ITEM_DEFINITION_STATUS.archived || box.listingStatus === 'Archived')
        throw throwBadRequestError('This mystery pack is archived');
      if (box.listingStatus === 'Rejected') throw throwBadRequestError(REJECTED_FINAL);
      const revision = await pendingRevisionOf(tx, boxId);
      if (!revision) throw throwBadRequestError('This mystery pack has no edit waiting for review');
      if (revision.id !== revisionId) throw throwBadRequestError(EDIT_CHANGED);
      // Refused before anything is written, so the edit stays waiting.
      if (await creatorIsRestricted(tx, owner.sellerId))
        throw throwBadRequestError(
          "This pack's creator is muted, banned or deleted, so it can't be approved. The edit stays waiting."
        );
      if (box.version !== revision.baseVersion) {
        const sentBack = await markStale(tx, revision.id, box, moderatorId);
        return { stale: true as const, sentBack, title: box.title, listingId: box.listingId };
      }

      // Nothing guards an unreviewed pack's contents, so every check runs again.
      const { proposal, weights, values } = await checkProposal(tx, {
        creatorId: owner.sellerId,
        steepness: revision.proposal.steepness,
        tiers: revision.proposal.tiers.map((tier) => tier.cosmeticIds),
        price: revision.proposal.price,
        stickersEnabled,
      });
      const rewards = await defineRewards(
        tx,
        proposal.tiers.flatMap((tier) => tier.cosmeticIds),
        moderatorId
      );
      const rewardIdOf = (cosmeticId: number) => rewards.get(cosmeticId)!.id;
      let rows = await readRows(tx, boxId);
      let draft = draftOf(proposal, weights, rewardIdOf, rows);

      const locked = await lockBox(tx, boxId);
      if (locked.version !== revision.baseVersion) {
        const sentBack = await markStale(tx, revision.id, box, moderatorId);
        return { stale: true as const, sentBack, title: box.title, listingId: box.listingId };
      }
      if (locked.status === ITEM_DEFINITION_STATUS.archived)
        throw throwBadRequestError('This mystery pack is archived');
      // A version-keeping builder save moves only updatedAt, so compare it, not the version.
      if (locked.updatedAt.getTime() !== box.updatedAt.getTime()) {
        rows = await readRows(tx, boxId);
        draft = draftOf(proposal, weights, rewardIdOf, rows);
      }

      await writeTiersAndContents(tx, boxId, draft, rows);

      const written = await readWritten(tx, boxId);
      const problems = boxChecklist(
        {
          name: box.name,
          tiers: written.tiers,
          contents: written.contents.map((content) => ({
            id: content.id,
            rewardDefinitionId: content.rewardDefinitionId,
            tierKey: written.tiers.find((tier) => tier.id === content.tierId)?.key ?? '',
            enabled: content.enabled,
          })),
        },
        new Map(
          written.contents.map((content) => [
            content.rewardDefinitionId,
            { type: content.type, team: cosmeticTeamOf(content.data) ?? null },
          ])
        ),
        []
      );
      if (problems.length) throw new BoxRefusal(problems.join(' '));

      // Every approval is a new version, so each approved price has its own snapshot; a held box
      // opened meanwhile refreshes on its stale expected version.
      const [{ version }] = await tx.$queryRaw<{ version: number }[]>`
        UPDATE "ItemDefinition"
        SET version = version + 1, status = ${ITEM_DEFINITION_STATUS.published},
          "updatedById" = ${moderatorId}, "updatedAt" = now()
        WHERE id = ${boxId}
        RETURNING version`;
      // Must match what the draw reads: enabled cosmetic contents.
      const live = snapshotOfLiveBox(
        written.tiers,
        written.contents.flatMap((content) =>
          content.enabled && content.type === ITEM_TYPE.cosmetic && content.cosmeticId !== null
            ? [{ tierId: content.tierId, cosmeticId: content.cosmeticId }]
            : []
        )
      );
      const snapshot = {
        ...live,
        contents: live.contents.map((content) => ({
          ...content,
          value: values.get(content.cosmeticId)!,
        })),
        price: proposal.price,
      };
      await tx.$executeRaw`
        INSERT INTO "BoxOddsSnapshot" ("boxDefinitionId", version, snapshot, "createdById")
        VALUES (${boxId}, ${version}, ${JSON.stringify(snapshot)}::jsonb, ${moderatorId})`;

      const at = new Date().toISOString();
      const meta = appendItemHistory(
        { ...(box.meta ?? { purchases: 0 }), lastApprovedAmount: proposal.price },
        {
          at,
          userId: moderatorId,
          kind: 'reviewed',
          status: 'Published',
          action: 'approve',
          note,
        }
      );
      await tx.$executeRaw`
        UPDATE "CosmeticShopItem"
        SET status = 'Published', "unitAmount" = ${proposal.price}, "rejectionReason" = NULL,
          "reviewedById" = ${moderatorId}, "reviewedAt" = now(), meta = ${JSON.stringify(
        meta
      )}::jsonb
        WHERE id = ${box.listingId}`;
      await closeRevision(tx, revision.id, {
        status: 'approved',
        reviewerId: moderatorId,
        note,
        appliedVersion: version,
      });
      await recordShopVerdict(
        tx,
        box.listingId,
        {
          action: 'approve',
          moderatorId,
          at,
          note,
          statusBefore: box.listingStatus,
          statusAfter: 'Published',
        },
        revision.id
      );
      return { stale: false as const, version, listingId: box.listingId };
    }, SHOP_VERDICT_TRANSACTION);
  } catch (error) {
    if (error instanceof BoxRefusal) throw throwBadRequestError(error.message);
    if (isPrismaLockTimeout(error))
      throw throwRateLimitError(
        'This mystery pack is busy being opened. Try again in a moment.',
        error
      );
    throw error;
  }
  // Thrown after commit: throwing inside the transaction would roll back the stale mark.
  if (outcome.stale) {
    if (outcome.sentBack)
      await createNotification({
        type: VERDICT_NOTIFICATION['request-changes'],
        userId: owner.sellerId,
        category: NotificationCategory.System,
        key: `${VERDICT_NOTIFICATION['request-changes']}:${outcome.listingId}:${Date.now()}`,
        details: { title: outcome.title, reason: STALE },
      });
    throw throwBadRequestError(STALE);
  }
  return { version: outcome.version, listingId: outcome.listingId };
}

const VERDICT_NOTIFICATION: Record<ReviewAction, string> = {
  approve: 'creator-shop-item-approved',
  'request-changes': 'creator-shop-item-changes-requested',
  revert: 'creator-shop-item-reverted',
  reject: 'creator-shop-item-rejected',
};

/**
 * A moderator's verdict on a creator's mystery pack, by its listing. A pack never approved can be
 * rejected for good; on an approved pack, reject only turns the edit down, as request-changes does.
 */
export async function reviewMysteryPack({
  boxId,
  reviewerId,
  action,
  rejectionReason,
  stickersEnabled,
  revisionId,
}: {
  boxId: number;
  reviewerId: number;
  action: ReviewAction;
  rejectionReason?: string;
  stickersEnabled: boolean;
  /** The edit the moderator reviewed; required while one waits, so a verdict can't land on another. */
  revisionId?: number;
}) {
  const note = rejectionReason || undefined;
  let result: { listingId: number; title: string; sellerId: number; finalReject?: boolean };
  if (action === 'approve') {
    result = await approveMysteryPack({ boxId, reviewerId, stickersEnabled, note, revisionId });
  } else {
    result = await dbWrite.$transaction(async (tx) => {
      const [owner] = await tx.$queryRaw<{ sellerId: number; title: string }[]>`
        SELECT d."sellerId", s.title
        FROM "ItemDefinition" d
        JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
        WHERE d.id = ${boxId} AND d."sellerId" IS NOT NULL
        ORDER BY s.id
        LIMIT 1`;
      if (!owner) throw throwNotFoundError('Mystery pack not found');
      if (owner.sellerId === reviewerId) throw throwBadRequestError(OWN_PACK);
      await lockCreator(tx, owner.sellerId);
      const box = await readBox(tx, boxId);
      if (box.listingStatus === 'Rejected') throw throwBadRequestError(REJECTED_FINAL);
      const revision = await pendingRevisionOf(tx, boxId);
      const neverSold = box.status === ITEM_DEFINITION_STATUS.draft;

      let nextStatus: CosmeticShopItemStatus;
      if (action === 'revert') {
        if (box.listingStatus !== 'Published')
          throw throwBadRequestError('Only a mystery pack on sale can be reverted to review');
        // An edit waiting stays waiting; the pack is back in the queue either way.
        nextStatus = 'PendingReview';
      } else {
        if (!revision && box.listingStatus !== 'PendingReview')
          throw throwBadRequestError('This mystery pack has no edit waiting for review');
        if ((revision?.id ?? undefined) !== revisionId) throw throwBadRequestError(EDIT_CHANGED);
        if (revision)
          await closeRevision(tx, revision.id, { status: 'rejected', reviewerId, note });
        if (action === 'reject' && neverSold) {
          nextStatus = 'Rejected';
          await tx.$executeRaw`
            UPDATE "ItemDefinition"
            SET status = ${ITEM_DEFINITION_STATUS.archived}, "updatedById" = ${reviewerId}, "updatedAt" = now()
            WHERE id = ${boxId}`;
        } else {
          // A live pack's listing stays on sale; one waiting for review goes back to its creator.
          nextStatus =
            box.listingStatus === 'PendingReview' ? 'RequestedChanges' : box.listingStatus;
        }
      }

      const at = new Date().toISOString();
      const meta = appendItemHistory(box.meta ?? { purchases: 0 }, {
        at,
        userId: reviewerId,
        kind: 'reviewed',
        status: nextStatus,
        action,
        note,
      });
      await tx.$executeRaw`
        UPDATE "CosmeticShopItem"
        SET status = ${nextStatus}::"CosmeticShopItemStatus", "rejectionReason" = ${note ?? null},
          "reviewedById" = ${reviewerId}, "reviewedAt" = now(), meta = ${JSON.stringify(
        meta
      )}::jsonb
        WHERE id = ${box.listingId}`;
      await recordShopVerdict(
        tx,
        box.listingId,
        {
          action,
          moderatorId: reviewerId,
          at,
          note,
          statusBefore: box.listingStatus,
          statusAfter: nextStatus,
          finalReject: action === 'reject' ? nextStatus === 'Rejected' : undefined,
        },
        // A revert acts on the pack on sale and leaves a waiting edit unjudged.
        action === 'revert' ? null : revision?.id
      );
      return {
        listingId: box.listingId,
        title: owner.title,
        sellerId: owner.sellerId,
        finalReject: nextStatus === 'Rejected',
      };
    }, SHOP_VERDICT_TRANSACTION);
  }

  // A reject that only turned the edit down reads to the creator as changes requested.
  const type =
    VERDICT_NOTIFICATION[action === 'reject' && !result.finalReject ? 'request-changes' : action];
  await createNotification({
    type,
    userId: result.sellerId,
    category: NotificationCategory.System,
    // Every verdict on a pack can recur, approvals included: each edit is reviewed.
    key: `${type}:${result.listingId}:${Date.now()}`,
    details: { title: result.title, reason: note },
  });
  return result;
}

/** With an edit waiting, applies it; without one (a pack pulled back to review), puts it back on sale. */
async function approveMysteryPack({
  boxId,
  reviewerId,
  stickersEnabled,
  note,
  revisionId,
}: {
  boxId: number;
  reviewerId: number;
  stickersEnabled: boolean;
  note?: string;
  revisionId?: number;
}) {
  const [box] = await dbWrite.$queryRaw<
    { sellerId: number; title: string; status: string; listingStatus: string; pending: boolean }[]
  >`
    SELECT d."sellerId", s.title, d.status, s.status::text AS "listingStatus",
      EXISTS (
        SELECT 1 FROM "BoxRevision" r WHERE r."boxDefinitionId" = d.id AND r.status = 'pending'
      ) AS pending
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    WHERE d.id = ${boxId} AND d."sellerId" IS NOT NULL
    ORDER BY s.id
    LIMIT 1`;
  if (!box) throw throwNotFoundError('Mystery pack not found');
  if (box.sellerId === reviewerId) throw throwBadRequestError(OWN_PACK);
  if (box.listingStatus === 'Rejected') throw throwBadRequestError(REJECTED_FINAL);
  if (box.pending) {
    if (revisionId === undefined) throw throwBadRequestError(EDIT_CHANGED);
    const { listingId } = await applyBoxRevision({
      boxId,
      moderatorId: reviewerId,
      stickersEnabled,
      note,
      revisionId,
    });
    return { listingId, title: box.title, sellerId: box.sellerId };
  }

  // The edit the moderator reviewed is gone; re-publishing the live version isn't what they decided.
  if (revisionId !== undefined) throw throwBadRequestError(EDIT_CHANGED);
  return dbWrite.$transaction(async (tx) => {
    await lockCreator(tx, box.sellerId);
    const current = await readBox(tx, boxId);
    if (
      current.status !== ITEM_DEFINITION_STATUS.published ||
      current.listingStatus !== 'PendingReview'
    )
      throw throwBadRequestError('This mystery pack has no edit waiting for review');
    // Raced an edit submitted since the read above: that edit is what needs reviewing.
    if (await pendingRevisionOf(tx, boxId))
      throw throwBadRequestError('An edit to this mystery pack just arrived. Review it instead.');
    if (await creatorIsRestricted(tx, box.sellerId))
      throw throwBadRequestError(
        "This pack's creator is muted, banned or deleted, so it can't go back on sale."
      );
    const at = new Date().toISOString();
    const meta = appendItemHistory(current.meta ?? { purchases: 0 }, {
      at,
      userId: reviewerId,
      kind: 'reviewed',
      status: 'Published',
      action: 'approve',
      note,
    });
    await tx.$executeRaw`
      UPDATE "CosmeticShopItem"
      SET status = 'Published', "rejectionReason" = NULL, "reviewedById" = ${reviewerId},
        "reviewedAt" = now(), meta = ${JSON.stringify(meta)}::jsonb
      WHERE id = ${current.listingId}`;
    await recordShopVerdict(tx, current.listingId, {
      action: 'approve',
      moderatorId: reviewerId,
      at,
      note,
      statusBefore: current.listingStatus,
      statusAfter: 'Published',
    });
    return { listingId: current.listingId, title: box.title, sellerId: box.sellerId };
  }, SHOP_VERDICT_TRANSACTION);
}
