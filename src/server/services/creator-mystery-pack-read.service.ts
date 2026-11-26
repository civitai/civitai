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
import {
  BOX_DEFINITION_SELECT,
  buildBoxViews,
  buildCatalogEntries,
  mysteryBoxesHiddenIn,
  SHOWN_BOX_STATUSES,
  type BoxSeller,
  type MysteryBoxCatalogEntry,
  type MysteryBoxView,
} from '~/server/services/mystery-box.service';

const CANDIDATE_LIMIT = 500;
const CATALOG_LIMIT = 40;

export type MysteryPackCandidate = Pick<
  EvaluatedContent,
  'cosmeticId' | 'name' | 'type' | 'data' | 'value' | 'problem'
>;

/**
 * The creator's newest cosmetics, each judged by the predicate submit, revise and approve use;
 * `value` is null while it has a problem.
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
  boxStatus: string;
  listing: { id: number; status: string; unitAmount: number } | null;
  pending: RevisionRow | null;
  /** What the editor opens with: the pending edit, else the last approved version. */
  proposal: MysteryPackProposal | null;
  /** The reviewer's note on the latest rejected edit, shown until a newer edit replaces it. */
  rejection: string | null;
};

/** Creator or moderator only (drafts aren't public). Reads the primary: it follows a write. */
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
        take: 25,
        select: { id: true, status: true, baseVersion: true, proposal: true, note: true },
      },
    },
    orderBy: { id: 'desc' },
  });
  return boxes.map((box) => {
    const revisions = box.revisions as unknown as RevisionRow[];
    const pending = revisions.find((r) => r.status === 'pending') ?? null;
    const approved = revisions.find((r) => r.status === 'approved') ?? null;
    const base = (pending ?? approved)?.proposal;
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
      // A lowered price lives on the listing, so an edit of the tiers must start from it.
      proposal: base
        ? { ...base, price: pending ? base.price : listing?.unitAmount ?? base.price }
        : null,
      rejection: newest?.status === 'rejected' ? newest.note : null,
    };
  });
}

export type CreatorMysteryPackEntry = MysteryBoxCatalogEntry & { seller: BoxSeller };

/** Banned or deleted sellers' boxes are excluded. */
function readSellerBoxes(statuses: string[], sellerId?: number) {
  return dbRead.itemDefinition.findMany({
    where: {
      type: ITEM_TYPE.box,
      status: { in: statuses },
      sellerId: sellerId ?? { not: null },
      seller: { bannedAt: null, deletedAt: null },
    },
    select: { ...BOX_DEFINITION_SELECT, seller: { select: { id: true, username: true } } },
    orderBy: { id: 'desc' },
    take: CATALOG_LIMIT,
  });
}

async function readLivePacks(sellerId?: number): Promise<CreatorMysteryPackEntry[]> {
  const boxes = await readSellerBoxes([ITEM_DEFINITION_STATUS.published], sellerId);
  if (!boxes.length) return [];
  const entries = await buildCatalogEntries(boxes, { teams: [], withPack: false });
  return entries.flatMap((entry) => {
    const seller = boxes.find((box) => box.id === entry.boxDefinitionId)?.seller;
    return seller ? [{ ...entry, seller }] : [];
  });
}

// The community list is the same for every viewer: share one read, in flight or recent, so a
// cold pod or a version bump doesn't send each concurrent /shop view to the catalog query.
// Per process on purpose: sharing the in-flight read is the point, which fetchThroughCache (Redis) and createTtlMemo don't do.
const COMMUNITY_TTL_MS = 30_000;
let community: { at: number; packs: Promise<CreatorMysteryPackEntry[]> } | undefined;
const communityPacks = () => {
  if (!community || Date.now() - community.at > COMMUNITY_TTL_MS) {
    const packs = readLivePacks();
    const entry = { at: Date.now(), packs };
    community = entry;
    packs.catch(() => {
      if (community === entry) community = undefined;
    });
  }
  return community.packs;
};
export const clearCommunityPacksCache = () => {
  community = undefined;
};

/**
 * Live packs on sale for one seller, or for every seller. Empty without the flags or in a hidden
 * region.
 */
export async function getCreatorMysteryPacks({
  sellerId,
  enabled,
  countryCode,
}: {
  sellerId?: number;
  enabled: boolean;
  countryCode: string | null | undefined;
}): Promise<CreatorMysteryPackEntry[]> {
  if (!enabled || (await mysteryBoxesHiddenIn(countryCode))) return [];
  return sellerId === undefined ? communityPacks() : readLivePacks(sellerId);
}

/**
 * One creator's packs as a signed-in viewer sees them: each on sale, or that they hold, with what is
 * left for them and their unopened boxes. A pack has no team, so there is one pool.
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
  const boxes = await readSellerBoxes(SHOWN_BOX_STATUSES, sellerId);
  if (!boxes.length) return [];
  const views = await buildBoxViews(boxes, {
    userId,
    team: undefined,
    playable: true,
    withPack: false,
  });
  return views.map((view) => {
    const seller = boxes.find((box) => box.id === view.boxDefinitionId)?.seller;
    return seller ? { ...view, seller } : view;
  });
}
