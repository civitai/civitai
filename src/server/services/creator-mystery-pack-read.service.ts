import { Prisma } from '@prisma/client';
import { ITEM_DEFINITION_STATUS, ITEM_TYPE } from '@civitai/shared/mystery-box';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  evaluateContentRow,
  readContentRows,
  type EvaluatedContent,
  type MysteryPackProposal,
} from '~/server/services/creator-mystery-pack.service';
import { listHeldItems } from '~/server/services/item.service';
import {
  buildMysteryBoxView,
  getBoxCatalogForDisplay,
  getBoxTiers,
  mysteryBoxesHiddenIn,
  readBoxListings,
  SHOWN_BOX_STATUSES,
  type MysteryBoxCatalogEntry,
  type MysteryBoxView,
} from '~/server/services/mystery-box.service';

/** The picker shows at most this many of a creator's cosmetics. */
const CANDIDATE_LIMIT = 500;
const CATALOG_LIMIT = 40;

export type MysteryPackCandidate = Pick<
  EvaluatedContent,
  'cosmeticId' | 'name' | 'type' | 'data' | 'value' | 'problem'
>;

/**
 * Every cosmetic the creator made, each judged by the predicate submit, revise and approve use, so
 * the picker can grey out what a review would refuse and say why. `value` is null while it has a
 * problem.
 */
export async function getMysteryPackCandidates({
  creatorId,
  stickersEnabled,
}: {
  creatorId: number;
  stickersEnabled: boolean;
}): Promise<MysteryPackCandidate[]> {
  const rows = await readContentRows(
    dbWrite,
    creatorId,
    Prisma.sql`c."createdById" = ${creatorId} ORDER BY c.id DESC LIMIT ${CANDIDATE_LIMIT}`
  );
  const now = new Date();
  return rows.map((row) => {
    const { cosmeticId, name, type, data, value, problem } = evaluateContentRow(row, {
      creatorId,
      stickersEnabled,
      now,
    });
    return { cosmeticId, name, type, data, value, problem };
  });
}

type RevisionRow = {
  id: number;
  status: string;
  baseVersion: number;
  proposal: MysteryPackProposal;
  note: string | null;
};

export type MyMysteryPack = {
  boxId: number;
  name: string;
  description: string | null;
  version: number;
  /** The box's own status: draft (never approved), published or archived. */
  boxStatus: string;
  listing: { id: number; status: string; unitAmount: number } | null;
  /** The edit waiting for review, if any. */
  pending: RevisionRow | null;
  /** What the editor opens with: the pending edit, else the last approved version. */
  proposal: MysteryPackProposal | null;
  /** The reviewer's note on the latest rejected edit, shown until a newer edit replaces it. */
  rejection: string | null;
};

/**
 * The creator's own packs with the state their manage view shows. Only the creator or a moderator
 * may read them: a draft or pending pack is not public. Primary DB: it follows a write.
 */
export async function getMyMysteryPacks({
  ownerId,
  viewer,
}: {
  ownerId: number;
  viewer: { id: number; isModerator?: boolean };
}): Promise<MyMysteryPack[]> {
  if (viewer.id !== ownerId && !viewer.isModerator)
    throw throwAuthorizationError("You can't view another creator's mystery packs");
  const userId = ownerId;
  const boxes = await dbWrite.itemDefinition.findMany({
    where: { sellerId: userId, type: ITEM_TYPE.box },
    select: {
      id: true,
      name: true,
      description: true,
      version: true,
      status: true,
      shopItems: { select: { id: true, status: true, unitAmount: true }, orderBy: { id: 'desc' } },
      revisions: {
        where: { status: { in: ['pending', 'approved', 'rejected'] } },
        orderBy: { id: 'desc' },
        take: 10,
        select: { id: true, status: true, baseVersion: true, proposal: true, note: true },
      },
    },
    orderBy: { id: 'desc' },
  });
  return boxes.map((box) => {
    const revisions = box.revisions as unknown as RevisionRow[];
    const pending = revisions.find((r) => r.status === 'pending') ?? null;
    const approved = revisions.find((r) => r.status === 'approved') ?? null;
    const newest = revisions[0];
    const listing = box.shopItems[0] ?? null;
    return {
      boxId: box.id,
      name: box.name,
      description: box.description,
      version: box.version,
      boxStatus: box.status,
      listing,
      pending,
      proposal: (pending ?? approved)?.proposal ?? null,
      rejection: newest?.status === 'rejected' ? newest.note : null,
    };
  });
}

export type CreatorMysteryPackEntry = MysteryBoxCatalogEntry & {
  seller: { id: number; username: string | null };
};

/**
 * Live creator packs on sale, for a creator's storefront (`sellerId`) or the community shop. Nothing
 * unless the viewer has the flags and isn't in a hidden region; a banned or deleted seller's packs
 * don't show. Contents are by tier only: a pack has no teams, so base odds are the box's own.
 */
export async function getCreatorMysteryPacks({
  sellerId,
  enabled,
  countryCode,
}: {
  sellerId?: number;
  /** `creatorMysteryPacksEnabled(features)` for the viewer. */
  enabled: boolean;
  countryCode: string | null | undefined;
}): Promise<CreatorMysteryPackEntry[]> {
  if (!enabled || (await mysteryBoxesHiddenIn(countryCode))) return [];

  const boxes = await dbRead.itemDefinition.findMany({
    where: {
      type: ITEM_TYPE.box,
      status: ITEM_DEFINITION_STATUS.published,
      sellerId: sellerId ?? { not: null },
      seller: { bannedAt: null, deletedAt: null },
    },
    select: {
      id: true,
      name: true,
      description: true,
      version: true,
      status: true,
      params: true,
      seller: { select: { id: true, username: true } },
    },
    orderBy: { id: 'desc' },
    take: CATALOG_LIMIT,
  });
  if (!boxes.length) return [];
  const boxIds = boxes.map((box) => box.id);
  const [{ onSale }, tiers] = await Promise.all([readBoxListings(boxIds), getBoxTiers(boxIds)]);

  const entries = await Promise.all(
    boxes.map(async (box): Promise<CreatorMysteryPackEntry | null> => {
      const listing = onSale(box.id);
      if (!listing || !box.seller) return null;
      const catalog = await getBoxCatalogForDisplay(box);
      return {
        boxDefinitionId: box.id,
        name: box.name,
        description: box.description,
        unitAmount: listing.unitAmount,
        pack: null,
        tiers: tiers
          .filter((tier) => tier.boxDefinitionId === box.id)
          .map(({ boxDefinitionId: _box, ...tier }) => tier),
        contents: catalog.map(({ contentId, tierId }) => ({ contentId, tierId, team: null })),
        teams: [],
        seller: box.seller,
      };
    })
  );
  return entries.filter((entry): entry is CreatorMysteryPackEntry => entry !== null);
}

/**
 * One creator's packs as a signed-in viewer sees them: each on sale, or that they hold, with what is
 * left for them and their unopened boxes. A pack has no team, so there is one pool for everyone.
 * Nothing without the creator pack flag or in a hidden region; the odds page's own gates otherwise.
 */
export async function getMysteryPackViewsForSeller({
  sellerId,
  userId,
  enabled,
  countryCode,
}: {
  sellerId: number;
  userId: number;
  enabled: boolean;
  countryCode: string | null | undefined;
}): Promise<MysteryBoxView[]> {
  if (!enabled || (await mysteryBoxesHiddenIn(countryCode))) return [];
  const boxes = await dbRead.itemDefinition.findMany({
    where: {
      type: ITEM_TYPE.box,
      status: { in: SHOWN_BOX_STATUSES },
      sellerId,
      seller: { bannedAt: null, deletedAt: null },
    },
    select: {
      id: true,
      name: true,
      description: true,
      version: true,
      status: true,
      params: true,
      seller: { select: { id: true, username: true } },
    },
    orderBy: { id: 'desc' },
    take: CATALOG_LIMIT,
  });
  if (!boxes.length) return [];
  const boxIds = boxes.map((box) => box.id);
  const [{ onSale }, held, tiers] = await Promise.all([
    readBoxListings(boxIds),
    listHeldItems(dbRead, { userId, itemDefinitionIds: boxIds }),
    getBoxTiers(boxIds),
  ]);
  const views = await Promise.all(
    boxes.map(async (box) => {
      const listing = box.status === ITEM_DEFINITION_STATUS.published ? onSale(box.id) : undefined;
      const heldBoxItemIds = held
        .filter((item) => item.itemDefinitionId === box.id)
        .map((item) => item.id.toString());
      if (!listing && !heldBoxItemIds.length) return null;
      const view = await buildMysteryBoxView(box, {
        userId,
        team: undefined,
        tiers,
        heldBoxItemIds,
        listing: listing
          ? {
              shopItemId: listing.id,
              title: listing.title,
              unitAmount: listing.unitAmount,
              availableTo: listing.availableTo,
            }
          : null,
        packListing: null,
      });
      return box.seller ? { ...view, seller: box.seller } : view;
    })
  );
  return views.filter((view): view is MysteryBoxView => view !== null);
}
