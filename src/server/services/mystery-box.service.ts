import type { Prisma } from '@prisma/client';
import { computeBoxOdds, drawFromOdds } from '@civitai/shared/box-odds';
import { randomInt } from 'crypto';
import { dbRead, dbWrite } from '~/server/db/client';
import { syncEventRosterMember } from '~/server/events/points/roster-sync';
import type { EventViewer } from '~/server/events/event-access';
import {
  assertEventShopItemPurchasable,
  getEventBoxCatalogAccess,
  getEventBuyerTeam,
  getEventBoxViewer,
  isEventShopItemData,
} from '~/server/events/event-shop-item';
import { logToAxiom } from '~/server/logging/client';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import {
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import {
  countHeldItems,
  findHeldItemById,
  findHeldItemBySource,
  grantItem,
  ITEM_DEFINITION_STATUS,
  ITEM_TYPE,
  listHeldItems,
} from '~/server/services/item.service';
import { getSoldCounts } from '~/server/services/cosmetic-shop-sold-count';
import { ITEM_HOLDER_BUSY_MESSAGE, lockItemHolder } from '~/server/services/item-holder-lock';
import {
  assertConfirmedPrice,
  beginShopPurchase,
  chargeForShopPurchase,
  chargeRetryOptions,
  claimShopPurchaseUnderLock,
  countPendingShopPurchaseClaims,
  findShopPurchaseClaim,
  markClaimPaid,
  purchaseStateUnknown,
  refundCallOptions,
  refundClaimedCharge,
  runPurchaseChecks,
  shopPurchaseTransactionId,
} from '~/server/services/shop-purchase-charge';
import {
  isPrismaLockTimeout,
  isPrismaUniqueViolation,
  throwBadRequestError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import { createKeyedTtlMemo, createTtlMemo } from '~/server/utils/ttl-memoize';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  BOX_OPENING_REWARD_STATUS,
  boxOpenClaimKey,
  cosmeticTeamOf,
  isForTeam,
} from '@civitai/shared/mystery-box';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import { stickerUsesFromCosmeticData } from '~/shared/utils/sticker-token';

/**
 * Countries where mystery boxes are not shown or sold: a `KeyValue` row holding a JSON array of
 * ISO country codes. Ops edit it with no deploy; absent means none.
 */
export const MYSTERY_BOX_BLOCKED_REGIONS_KEY = 'mysteryBox:blockedRegions';

/**
 * The blocked country codes, upper-cased. Throws on a value that is not an array of strings: the
 * list is a legal control, so a malformed one refuses boxes everywhere rather than nowhere.
 */
export async function getMysteryBoxBlockedRegions(): Promise<string[]> {
  const row = await dbRead.keyValue.findUnique({
    where: { key: MYSTERY_BOX_BLOCKED_REGIONS_KEY },
    select: { value: true },
  });
  if (!row) return [];
  const value = row.value;
  if (!Array.isArray(value) || !value.every((code) => typeof code === 'string')) {
    logToAxiom({
      type: 'error',
      name: 'mystery-box',
      message: `${MYSTERY_BOX_BLOCKED_REGIONS_KEY} is not an array of country codes`,
      value,
    });
    throw throwBadRequestError('Mystery boxes are not available right now');
  }
  return value.map((code) => code.trim().toUpperCase());
}

/**
 * A visitor with no known country is blocked whenever any country is. Known means an ISO 3166
 * alpha-2 code: the CDN also sends non-country placeholders (XX for unknown, T1 for Tor).
 */
export function isMysteryBoxBlockedIn(countryCode: string | null | undefined, blocked: string[]) {
  if (!blocked.length) return false;
  const code = countryCode?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'XX') return true;
  return blocked.includes(code);
}

// For showing boxes only. Purchase and open read the list uncached, so a change refuses at once
// even where a pod still shows a box. A list that can't be read is cached as null too, so a bad row
// costs one read a minute, not one per menu-badge fetch.
const blockedRegionsForDisplay = createTtlMemo(
  () => getMysteryBoxBlockedRegions().catch(() => null),
  60_000,
  () => Date.now()
);

/** Whether to show mystery boxes in this country. A list that can't be read hides them. */
export async function mysteryBoxesHiddenIn(countryCode: string | null | undefined) {
  const blocked = await blockedRegionsForDisplay();
  return !blocked || isMysteryBoxBlockedIn(countryCode, blocked);
}

export type BoxPoolEntry = {
  contentId: number;
  tierId: number;
  rewardDefinitionId: number;
  cosmeticId: number;
  cosmeticName: string | null;
  cosmeticData: unknown;
  cosmeticType: CosmeticType | null;
};

export type BoxContentForUser = BoxPoolEntry & {
  /** Still in this user's pool: not owned from any source, and not drawn from this box before. */
  left: boolean;
};

export type BoxCatalogEntry = BoxPoolEntry & {
  /** The team the cosmetic was made for (`data.team`); it goes only to that team's members. */
  team: string | undefined;
};

/**
 * A box's enabled contents for every team, with the team each cosmetic is for. v1 boxes hold
 * cosmetics only; any other reward kind is left out here and refused at purchase
 * (`assertBoxSellable`).
 */
export async function getBoxCatalog(
  client: Prisma.TransactionClient,
  boxDefinitionId: number
): Promise<BoxCatalogEntry[]> {
  const contents = await client.boxContent.findMany({
    where: { boxDefinitionId, enabled: true },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      tierId: true,
      rewardDefinitionId: true,
      reward: {
        select: {
          type: true,
          cosmeticId: true,
          cosmetic: { select: { name: true, data: true, type: true } },
        },
      },
    },
  });

  return contents.flatMap((content) => {
    const { cosmeticId, cosmetic, type } = content.reward;
    if (type !== ITEM_TYPE.cosmetic || cosmeticId == null) return [];
    return [
      {
        contentId: content.id,
        tierId: content.tierId,
        rewardDefinitionId: content.rewardDefinitionId,
        cosmeticId,
        cosmeticName: cosmetic?.name ?? null,
        cosmeticData: cosmetic?.data ?? null,
        cosmeticType: cosmetic?.type ?? null,
        team: cosmeticTeamOf(cosmetic?.data),
      },
    ];
  });
}

/**
 * Marks each entry whether it is still `left` for the user. Owned from any source, or already drawn
 * from this box (a reward removed from them since stays drawn: `BoxOpening` allows each once), is
 * not left.
 */
async function markLeftForUser<T extends { cosmeticId: number; rewardDefinitionId: number }>(
  client: Prisma.TransactionClient,
  { boxDefinitionId, userId }: { boxDefinitionId: number; userId: number },
  entries: T[]
): Promise<(T & { left: boolean })[]> {
  if (!entries.length) return [];

  const owned = await client.userCosmetic.findMany({
    where: { userId, cosmeticId: { in: entries.map((entry) => entry.cosmeticId) } },
    select: { cosmeticId: true },
  });
  const drawn = await client.boxOpening.findMany({
    where: { userId, boxDefinitionId, rewardType: ITEM_TYPE.cosmetic },
    select: { rewardDefinitionId: true },
  });
  const ownedIds = new Set(owned.map((row) => row.cosmeticId));
  const drawnIds = new Set(drawn.map((row) => row.rewardDefinitionId));
  return entries.map((entry) => ({
    ...entry,
    left: !ownedIds.has(entry.cosmeticId) && !drawnIds.has(entry.rewardDefinitionId),
  }));
}

/**
 * Everything this box holds for this user, read live: its enabled contents for their `team`, each
 * marked whether it is still `left` for them.
 */
export async function getBoxContentsForUser(
  client: Prisma.TransactionClient,
  { boxDefinitionId, userId, team }: { boxDefinitionId: number; userId: number; team?: string }
): Promise<BoxContentForUser[]> {
  const forTeam = (await getBoxCatalog(client, boxDefinitionId)).flatMap(
    ({ team: cosmeticTeam, ...entry }) => (isForTeam(cosmeticTeam, team) ? [entry] : [])
  );
  return markLeftForUser(client, { boxDefinitionId, userId }, forTeam);
}

/**
 * What this box can still give this user (`getBoxContentsForUser`, left only). Read inside a
 * transaction holding `lockItemHolder` for the user when the answer decides a grant or a claim.
 */
export async function getBoxPoolForUser(
  client: Prisma.TransactionClient,
  params: { boxDefinitionId: number; userId: number; team?: string }
): Promise<BoxPoolEntry[]> {
  const contents = await getBoxContentsForUser(client, params);
  return contents.filter((entry) => entry.left).map(({ left: _left, ...entry }) => entry);
}

/**
 * Refuses a box with any enabled reward that is not a cosmetic. Buzz rewards in a sold box need
 * counsel first, and a box inside a box has no open path.
 */
async function assertBoxSellable(client: Prisma.TransactionClient, boxDefinitionId: number) {
  const other = await client.boxContent.count({
    where: { boxDefinitionId, enabled: true, reward: { type: { not: ITEM_TYPE.cosmetic } } },
  });
  if (other > 0) throw throwBadRequestError('This box is not available');
}

type BoxParams = { event?: unknown; art?: unknown };

type BoxArt = { closed?: string; open?: string };

/**
 * Why a box listing can't be sold now (stock, then its sale window), or null when it can. `sold` is
 * read only for a listing with a quantity.
 */
export function boxSaleRefusal(
  listing: {
    availableQuantity: number | null;
    availableFrom: Date | null;
    availableTo: Date | null;
  },
  sold: number,
  now: Date
) {
  if (listing.availableQuantity !== null && sold >= listing.availableQuantity)
    return 'This box is out of stock';
  if (listing.availableFrom && listing.availableFrom > now) return 'This box is not available yet';
  if (listing.availableTo && listing.availableTo < now) return 'This box is no longer available';
  return null;
}

export const BOX_TIER_SELECT = {
  id: true,
  key: true,
  name: true,
  color: true,
  weight: true,
  sortOrder: true,
} satisfies Prisma.BoxTierSelect;
/** Draw order; `tierSummaries` and the odds chain depend on it. */
export const BOX_TIER_ORDER = [
  { sortOrder: 'asc' },
  { id: 'asc' },
] satisfies Prisma.BoxTierOrderByWithRelationInput[];

/** The box art for a team, from `params.art[team]` ({ closed, open } image urls). */
function boxArtFor(params: BoxParams, team: string | undefined): BoxArt | null {
  const art = (params.art as Record<string, unknown> | undefined)?.[team ?? ''];
  if (!art || typeof art !== 'object') return null;
  const { closed, open } = art as Record<string, unknown>;
  return {
    closed: typeof closed === 'string' ? closed : undefined,
    open: typeof open === 'string' ? open : undefined,
  };
}

function boxContentDisplay(entry: BoxPoolEntry) {
  const data = (entry.cosmeticData ?? {}) as {
    url?: unknown;
    fit?: { bounds?: unknown; canvas?: unknown } | null;
  };
  return {
    contentId: entry.contentId,
    tierId: entry.tierId,
    cosmeticId: entry.cosmeticId,
    name: entry.cosmeticName,
    url: typeof data.url === 'string' ? data.url : null,
    // A preview sizes the art by these two; the outline and brim are for wearing it.
    fit: data.fit ? { bounds: data.fit.bounds, canvas: data.fit.canvas } : null,
  };
}

/**
 * A box content as the display reads show it. It carries no `cosmeticData`, so it can't stand in for
 * the live catalog a grant reads.
 */
export type BoxDisplayEntry = ReturnType<typeof boxContentDisplay> & {
  rewardDefinitionId: number;
  cosmeticType: CosmeticType | null;
  team: string | undefined;
  /** The event the cosmetic belongs to (`data.event`), if any. */
  event: string | undefined;
};

// Keyed by version, which every change to a box's tiers or contents, or to a content cosmetic's team,
// must bump in the same transaction, so the change shows at once. Anything changed without a bump
// shows within the TTL: until then the odds shown can differ from the draw's.
const BOX_CATALOG_DISPLAY_TTL_MS = 60_000;
const displayCatalogs = createKeyedTtlMemo(
  async (key): Promise<BoxDisplayEntry[]> =>
    (await getBoxCatalog(dbRead, Number(key.split(':')[0]))).map((entry) =>
      Object.freeze({
        ...boxContentDisplay(entry),
        rewardDefinitionId: entry.rewardDefinitionId,
        cosmeticType: entry.cosmeticType,
        team: entry.team,
        event: isEventShopItemData(entry.cosmeticData) ? entry.cosmeticData.event : undefined,
      })
    ),
  BOX_CATALOG_DISPLAY_TTL_MS,
  () => Date.now(),
  { freeze: true }
);
const servedVersions = new Map<number, number>();

/**
 * A box's enabled contents for every team, for showing only (the event page, Inventory, the odds
 * page), cached per box version. Purchase and open read `getBoxCatalog` live, under the lock.
 */
export function getBoxCatalogForDisplay(box: { id: number; version: number }) {
  // One version per box: the memo keeps a slot per key, so drop the one a bump replaced.
  const served = servedVersions.get(box.id);
  if (served !== undefined && served !== box.version) displayCatalogs.clear(`${box.id}:${served}`);
  servedVersions.set(box.id, box.version);
  return displayCatalogs(`${box.id}:${box.version}`);
}

export const clearBoxCatalogDisplayCache = () => {
  displayCatalogs.clear();
  servedVersions.clear();
};

export type MysteryBoxView = {
  boxDefinitionId: number;
  name: string;
  description: string | null;
  /** The version a purchase or an open must name (`expectedVersion`). */
  version: number;
  /** The team whose contents are shown; undefined for an event without teams. */
  team: string | undefined;
  art: BoxArt | null;
  /**
   * The listing selling it, when one is on sale and the event is playable for the viewer. A box no
   * longer sold can still be opened.
   */
  listing: {
    shopItemId: number;
    title: string;
    unitAmount: number;
    availableTo: Date | null;
  } | null;
  tiers: {
    id: number;
    key: string;
    name: string;
    color: string | null;
    weight: number;
    sortOrder: number;
  }[];
  /** Everything the box holds for the viewer's team; odds are `computeBoxOdds` over the `left` ones. */
  contents: {
    contentId: number;
    tierId: number;
    cosmeticId: number;
    name: string | null;
    url: string | null;
    fit: unknown;
    left: boolean;
  }[];
  /** The viewer's unopened boxes of it, as `Item.id` strings. */
  heldBoxItemIds: string[];
};

// Archived boxes too: one still held still opens.
export const SHOWN_BOX_STATUSES = [
  ITEM_DEFINITION_STATUS.published,
  ITEM_DEFINITION_STATUS.archived,
];

export const BOX_DEFINITION_SELECT = {
  id: true,
  name: true,
  description: true,
  version: true,
  status: true,
  params: true,
} as const;

type BoxDefinitionRow = {
  id: number;
  name: string;
  description: string | null;
  version: number;
  status: string;
  params: Prisma.JsonValue;
};

type BoxTierRow = MysteryBoxView['tiers'][number] & { boxDefinitionId: number };

export function getBoxTiers(boxIds: number[]): Promise<BoxTierRow[]> {
  return dbRead.boxTier.findMany({
    where: { boxDefinitionId: { in: boxIds } },
    orderBy: BOX_TIER_ORDER,
    select: { boxDefinitionId: true, ...BOX_TIER_SELECT },
  });
}

/** One box as a viewer sees it: its tiers, and what it holds for `team` with what is left for them. */
export async function buildMysteryBoxView(
  box: BoxDefinitionRow,
  {
    userId,
    team,
    tiers,
    listing,
    heldBoxItemIds,
  }: {
    userId: number;
    team: string | undefined;
    tiers: BoxTierRow[];
    listing: MysteryBoxView['listing'];
    heldBoxItemIds: string[];
  }
): Promise<MysteryBoxView> {
  const catalog = await getBoxCatalogForDisplay(box);
  const contents = await markLeftForUser(
    dbRead,
    { boxDefinitionId: box.id, userId },
    catalog.filter((entry) => isForTeam(entry.team, team))
  );
  return {
    boxDefinitionId: box.id,
    name: box.name,
    description: box.description,
    version: box.version,
    team,
    art: boxArtFor((box.params ?? {}) as BoxParams, team),
    listing,
    tiers: tiers
      .filter((tier) => tier.boxDefinitionId === box.id)
      .map(({ boxDefinitionId: _box, ...tier }) => tier),
    contents: contents.map(({ contentId, tierId, cosmeticId, name, url, fit, left }) => ({
      contentId,
      tierId,
      cosmeticId,
      name,
      url,
      fit,
      left,
    })),
    heldBoxItemIds,
  };
}

/**
 * The published listings of these boxes, and which of a box's is on sale now (stock, then its sale
 * window).
 */
export async function readBoxListings(boxIds: number[]) {
  const listings = await dbRead.cosmeticShopItem.findMany({
    where: { itemDefinitionId: { in: boxIds }, status: CosmeticShopItemStatus.Published },
    select: {
      id: true,
      itemDefinitionId: true,
      title: true,
      unitAmount: true,
      availableQuantity: true,
      availableFrom: true,
      availableTo: true,
    },
    orderBy: { id: 'asc' },
  });
  // Only a listing with a quantity needs its sold count, read for those ids alone.
  const sold = await getSoldCounts(
    listings.filter((l) => l.availableQuantity !== null).map((l) => l.id)
  );
  const now = new Date();
  const onSale = (boxId: number) =>
    listings.find(
      (l) => l.itemDefinitionId === boxId && !boxSaleRefusal(l, sold.get(l.id) ?? 0, now)
    );
  return { listings, onSale };
}

/** An event's boxes in these statuses, in id order. */
function readEventBoxes(event: string, statuses: string[]) {
  return dbRead.itemDefinition.findMany({
    where: {
      type: ITEM_TYPE.box,
      status: { in: statuses },
      params: { path: ['event'], equals: event },
    },
    select: BOX_DEFINITION_SELECT,
    orderBy: { id: 'asc' },
  });
}

export type MysteryBoxCatalogEntry = {
  boxDefinitionId: number;
  name: string;
  description: string | null;
  /** The price of the listing on sale now. */
  unitAmount: number;
  tiers: MysteryBoxView['tiers'];
  /** Every enabled content with the team it is for; each team draws only from its own. */
  contents: { contentId: number; tierId: number; team: string | null }[];
  /** The event's teams, including any with nothing of its own in the box. */
  teams: string[];
};

/**
 * An event's mystery boxes on sale now, for a viewer not on a team (signed out, or not joined): the
 * box and its contents by tier, for base odds. It reads no team, so it places no one and shows no
 * pool of anyone's; the odds page's gates apply (flag, country, the event open to them), and the
 * event must be playable, as it must for a team member to be offered the box.
 */
export async function getMysteryBoxCatalogForEvent({
  event,
  viewer,
  mysteryBoxEnabled,
  countryCode,
}: {
  event: string;
  viewer: EventViewer;
  mysteryBoxEnabled: boolean | undefined;
  countryCode: string | null | undefined;
}): Promise<MysteryBoxCatalogEntry[]> {
  if (!mysteryBoxEnabled || (await mysteryBoxesHiddenIn(countryCode))) return [];
  const access = await getEventBoxCatalogAccess(event, viewer);
  if (!access?.playable) return [];

  const boxes = await readEventBoxes(event, [ITEM_DEFINITION_STATUS.published]);
  if (!boxes.length) return [];
  const boxIds = boxes.map((box) => box.id);
  const [{ onSale }, tiers] = await Promise.all([readBoxListings(boxIds), getBoxTiers(boxIds)]);

  const views = await Promise.all(
    boxes.map(async (box): Promise<MysteryBoxCatalogEntry | null> => {
      const listing = onSale(box.id);
      if (!listing) return null;
      const catalog = await getBoxCatalogForDisplay(box);
      return {
        boxDefinitionId: box.id,
        name: box.name,
        description: box.description,
        unitAmount: listing.unitAmount,
        tiers: tiers
          .filter((tier) => tier.boxDefinitionId === box.id)
          .map(({ boxDefinitionId: _box, ...tier }) => tier),
        contents: catalog.map(({ contentId, tierId, team }) => ({
          contentId,
          tierId,
          team: team ?? null,
        })),
        teams: [...access.teams],
      };
    })
  );
  return views.filter((view): view is MysteryBoxCatalogEntry => view !== null);
}

/**
 * An event's mystery boxes as the viewer sees them: each box on sale, or that they hold, with its
 * tiers and what it holds for their team. Nothing when boxes are off, hidden in their country, or
 * the event is closed to them; once it ends, only the boxes they hold.
 */
export async function getMysteryBoxesForEvent({
  userId,
  isModerator,
  event,
  mysteryBoxEnabled,
  countryCode,
}: {
  userId: number;
  isModerator?: boolean;
  event: string;
  mysteryBoxEnabled: boolean | undefined;
  countryCode: string | null | undefined;
}): Promise<MysteryBoxView[]> {
  if (!mysteryBoxEnabled || (await mysteryBoxesHiddenIn(countryCode))) return [];
  // The event's own gate first: a box's contents are not shown before the event is open to them.
  const viewer = await getEventBoxViewer(event, { id: userId, isModerator });
  if (!viewer) return [];
  const { team, playable } = viewer;

  const boxes = await readEventBoxes(event, SHOWN_BOX_STATUSES);
  if (!boxes.length) return [];
  const boxIds = boxes.map((box) => box.id);

  const [{ onSale }, held, tiers] = await Promise.all([
    readBoxListings(boxIds),
    listHeldItems(dbRead, { userId, itemDefinitionIds: boxIds }),
    getBoxTiers(boxIds),
  ]);

  const views = await Promise.all(
    boxes.map(async (box): Promise<MysteryBoxView | null> => {
      const listing =
        playable && box.status === ITEM_DEFINITION_STATUS.published ? onSale(box.id) : undefined;
      const heldBoxItemIds = held
        .filter((item) => item.itemDefinitionId === box.id)
        .map((item) => item.id.toString());
      if (!listing && !heldBoxItemIds.length) return null;

      return buildMysteryBoxView(box, {
        userId,
        team,
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
      });
    })
  );
  return views.filter((view): view is MysteryBoxView => view !== null);
}

// How long a purchase still settling counts against what is left for its buyer, from its last
// attempt. A purchase settles in seconds; one idle longer is stuck and stops reserving. If its key is
// pressed again it resumes, and a charged one is granted without this check, so a box can then be
// sold past what is left (kept, as an empty box, until contents arrive or a moderator refunds it).
const PENDING_CLAIM_RESERVES_MS = 15 * 60 * 1000;

export type MysteryBoxShopItem = {
  id: number;
  itemDefinitionId: number;
  status: CosmeticShopItemStatus;
  availableQuantity: number | null;
  availableFrom: Date | null;
  availableTo: Date | null;
  unitAmount: number;
  title: string;
  meta: CosmeticShopItemMeta;
  _count: { purchases: number };
};

export type MysteryBoxPurchaseResult = {
  kind: 'box';
  /** The held box's `Item.id`, as a string: it is a BIGINT. */
  boxItemId: string;
  boxDefinitionId: number;
};

/**
 * Buys one mystery box: the shop's claim-first purchase, granting a held box `Item` keyed on the
 * claim. Opening it is separate and moves no money.
 *
 * Every refusal comes before the claim. The availability check (the box still has something left
 * for the buyer beyond the boxes they hold and the purchases they have pending) runs under the
 * buyer's item-holder lock, and the claim is written before that lock is released, so two tabs
 * cannot both buy the last thing left for them.
 */
export async function purchaseMysteryBox({
  userId,
  isModerator,
  shopItem,
  idempotencyKey,
  expectedUnitAmount,
  expectedVersion,
  payWith = 'default',
  buzzType,
  mysteryBoxEnabled,
  countryCode,
}: {
  userId: number;
  isModerator?: boolean;
  shopItem: MysteryBoxShopItem;
  idempotencyKey: string | undefined;
  expectedUnitAmount: number | undefined;
  expectedVersion: number | undefined;
  payWith?: 'default' | 'blue-first';
  buzzType: BuzzSpendType;
  mysteryBoxEnabled: boolean | undefined;
  countryCode: string | null | undefined;
}): Promise<MysteryBoxPurchaseResult> {
  const shopItemId = shopItem.id;
  const boxDefinitionId = shopItem.itemDefinitionId;

  // A retry of a purchase that completed answers with the box it granted, so a buy-and-open whose
  // response was lost can still open it. An opened box is gone, and the claim answers below.
  if (idempotencyKey) {
    const sourceKey = shopPurchaseTransactionId('box', userId, shopItemId, idempotencyKey);
    const held = await findHeldItemBySource(dbWrite, { sourceKey, userId });
    if (held)
      return { kind: 'box', boxItemId: held.id.toString(), boxDefinitionId: held.itemDefinitionId };
  }

  const box = await dbWrite.itemDefinition.findUnique({
    where: { id: boxDefinitionId },
    select: { id: true, type: true, status: true, version: true, params: true, sellerId: true },
  });

  const start = await beginShopPurchase({
    kind: 'box',
    userId,
    shopItemId,
    idempotencyKey,
    amount: shopItem.unitAmount,
  });
  const { transactionId, existingClaim, pendingClaim, chargedBefore } = start;
  const claimContext = (amount: number) => ({ shopItemId, userId, transactionId, amount });

  // Whether this box may be sold to this buyer at all. Asked again on a retry: a kill switch or a
  // region block still wins, as state unknown.
  const event = await runPurchaseChecks(pendingClaim, async () => {
    if (!mysteryBoxEnabled) throw throwBadRequestError('This box is not available');
    // Box listings are unlisted by design, so `listed` is not asked.
    if (shopItem.status !== CosmeticShopItemStatus.Published)
      throw throwBadRequestError('This box is not available');
    if (!box || box.type !== ITEM_TYPE.box || box.status !== ITEM_DEFINITION_STATUS.published)
      throw throwBadRequestError('This box is not available');
    // A creator's pack isn't sold until its sale pays the creator; approving one doesn't open it.
    if (box.sellerId != null) throw throwBadRequestError('This box is not available');

    if (isMysteryBoxBlockedIn(countryCode, await getMysteryBoxBlockedRegions()))
      throw throwBadRequestError('Mystery boxes are not available in your region');

    // Paid Buzz only, event box or not.
    if (payWith !== 'default')
      throw throwBadRequestError("This box can't be bought with Blue Buzz");

    const params = (box.params ?? {}) as BoxParams;
    if (!isEventShopItemData(params)) return undefined;
    await assertEventShopItemPurchasable({
      userId,
      isModerator,
      // The event only: a box is sold to every team, and draws from the buyer's.
      data: { event: params.event },
      payWith,
      resumingClaim: chargedBefore,
    });
    return params.event;
  });
  // Narrowed by the checks above.
  if (!box) throw throwBadRequestError('This box is not available');

  // Today's stock, sale window, price and box version. A claim that was charged passed them when it
  // was made; any other request is held to them.
  await runPurchaseChecks(pendingClaim, async () => {
    if (chargedBefore) return;
    const refusal = boxSaleRefusal(shopItem, shopItem._count.purchases, new Date());
    if (refusal) throw throwBadRequestError(refusal);

    assertConfirmedPrice({
      existingClaim,
      expectedAmount: expectedUnitAmount,
      amountDue: shopItem.unitAmount,
    });

    // The buyer was shown this version's contents and odds.
    if (expectedVersion !== box.version)
      throw throwBadRequestError("This box's contents changed. Check them and try again.");
  });

  const team = event
    ? await runPurchaseChecks(pendingClaim, () => getEventBuyerTeam(event, userId))
    : undefined;

  const claim = await dbWrite
    .$transaction(async (tx) => {
      await lockItemHolder(tx, userId);
      // A request with the same key that claimed while this one was on its way here: its purchase
      // was checked when it claimed, and resuming it answers 'already completed' once it is paid.
      const sameKeyClaim = existingClaim ? null : await findShopPurchaseClaim(transactionId, tx);
      if (!chargedBefore && !sameKeyClaim)
        await runPurchaseChecks(pendingClaim, async () => {
          await assertBoxSellable(tx, box.id);
          const left = (await getBoxPoolForUser(tx, { boxDefinitionId: box.id, userId, team }))
            .length;
          const held = await countHeldItems(tx, { itemDefinitionId: box.id, userId });
          const listings = await tx.cosmeticShopItem.findMany({
            where: { itemDefinitionId: box.id },
            select: { id: true },
          });
          const pending = await countPendingShopPurchaseClaims(tx, {
            userId,
            shopItemIds: listings.map((listing) => listing.id),
            exceptTransactionId: transactionId,
            since: new Date(Date.now() - PENDING_CLAIM_RESERVES_MS),
          });
          if (left <= held + pending)
            throw throwBadRequestError(
              held + pending > 0
                ? 'Your unopened boxes already cover everything left in this box'
                : "You've collected everything in this box"
            );
        });
      // Committed with the checks above, before the lock is released: a competing purchase waiting on
      // the lock then counts it as pending.
      return claimShopPurchaseUnderLock(
        tx,
        claimContext(shopItem.unitAmount),
        existingClaim ?? sameKeyClaim,
        expectedUnitAmount
      );
    })
    .catch((error) => {
      // Rolled back before the charge, so trying again is safe.
      if (isPrismaLockTimeout(error)) throw throwRateLimitError(ITEM_HOLDER_BUSY_MESSAGE, error);
      throw error;
    });

  const unitAmount = claim.amount;
  const chargeContext = { shopItemId, userId, transactionId, amount: unitAmount };
  const transaction = await chargeForShopPurchase(
    () =>
      createMultiAccountBuzzTransaction(
        {
          fromAccountId: userId,
          fromAccountTypes: [buzzType],
          toAccountId: 0, // bank
          amount: unitAmount,
          type: TransactionType.Purchase,
          description: `Mystery box purchase - ${shopItem.title}`,
          externalTransactionIdPrefix: transactionId,
        },
        chargeRetryOptions
      ),
    chargeContext,
    claim
  );
  if (!transaction.transactionCount) throw new Error('There was an error creating the transaction');

  try {
    const item = await dbWrite.$transaction(async (tx) => {
      // The lock comes first here, unlike the shelf grant: the availability check counts this claim
      // as pending until the box exists, so the claim turning paid and the box appearing must be
      // seen together by anyone holding the lock. A concurrent grant of the same claim waits on the
      // lock instead of the claim row, and still finds it settled.
      await lockItemHolder(tx, userId);
      await markClaimPaid(tx, transactionId);
      // `cosmeticId` NULL and no components: what was bought is the held box below.
      await tx.userCosmeticShopPurchases.create({
        data: {
          userId,
          cosmeticId: null,
          shopItemId,
          unitAmount,
          buzzTransactionId: transactionId,
          refunded: false,
        },
      });
      return grantItem(tx, { itemDefinitionId: box.id, userId, sourceKey: transactionId });
    });
    return { kind: 'box', boxItemId: item.id.toString(), boxDefinitionId: item.itemDefinitionId };
  } catch (error) {
    // With a client key, a unique violation here means a request with the same key recorded this
    // purchase first; the prefix is shared with it, so it is not refunded from here.
    if (idempotencyKey && isPrismaUniqueViolation(error))
      throw purchaseStateUnknown({ ...chargeContext, error }, 'same key already recorded');

    await refundClaimedCharge(
      () =>
        refundMultiAccountTransaction(
          {
            externalTransactionIdPrefix: transactionId,
            description: `Failed to purchase mystery box - ${shopItem.title}`,
            details: { claim: transactionId },
          },
          refundCallOptions
        ),
      { ...chargeContext, error }
    );
    throw throwBadRequestError('Failed to purchase box');
  }
}

export type MysteryBoxOpenResult = {
  /** The opened box's `Item.id`, as a string: it is a BIGINT. */
  boxItemId: string;
  boxDefinitionId: number;
  boxVersion: number;
  tierId: number;
  contentId: number;
  rewardDefinitionId: number;
  rewardType: string;
  cosmeticId: number | null;
  /** The odds this draw ran under, from the opening's own record. */
  odds: { tierWeight: number; eligibleWeight: number; tierPoolSize: number };
  /** True when this answers an open that already happened (a retry or a double-click). */
  replayed: boolean;
};

type BoxOpeningRow = {
  boxItemId: bigint;
  boxDefinitionId: number;
  boxVersion: number;
  userId: number;
  tierId: number;
  contentId: number;
  rewardDefinitionId: number;
  rewardType: string;
  tierWeight: number;
  eligibleWeight: number;
  tierPoolSize: number;
};

const openingResult = (
  opening: BoxOpeningRow,
  cosmeticId: number | null,
  replayed: boolean
): MysteryBoxOpenResult => ({
  boxItemId: opening.boxItemId.toString(),
  boxDefinitionId: opening.boxDefinitionId,
  boxVersion: opening.boxVersion,
  tierId: opening.tierId,
  contentId: opening.contentId,
  rewardDefinitionId: opening.rewardDefinitionId,
  rewardType: opening.rewardType,
  cosmeticId,
  odds: {
    tierWeight: opening.tierWeight,
    eligibleWeight: opening.eligibleWeight,
    tierPoolSize: opening.tierPoolSize,
  },
  replayed,
});

const NOT_YOUR_BOX = 'This box is not yours to open';

/** The open that already happened for this box, answered again; refuses another user's. */
async function replayOpening(client: Prisma.TransactionClient, boxItemId: bigint, userId: number) {
  const opening = await client.boxOpening.findUnique({ where: { boxItemId } });
  if (!opening || opening.userId !== userId) throw throwBadRequestError(NOT_YOUR_BOX);
  // Its reward was taken back: answering the reveal again would show a hat they no longer hold.
  if (opening.rewardStatus !== BOX_OPENING_REWARD_STATUS.granted)
    throw throwBadRequestError('This box was refunded');
  const reward = await client.itemDefinition.findUnique({
    where: { id: opening.rewardDefinitionId },
    select: { cosmeticId: true },
  });
  return openingResult(opening, reward?.cosmeticId ?? null, true);
}

/**
 * Opens one held mystery box: draws one reward from what the box still has for the holder, grants
 * it, records the draw and removes the box, all in one transaction. No money moves.
 *
 * Under the holder's item-holder lock, so the pool read, the draw and the grant see every other
 * grant to this user (a shelf purchase, another box) either wholly before or wholly after. A box that
 * has nothing left for its holder is kept, not opened.
 */
export async function openMysteryBox({
  userId,
  boxItemId: boxItemIdInput,
  expectedVersion,
  mysteryBoxEnabled,
  countryCode,
}: {
  userId: number;
  boxItemId: string;
  expectedVersion: number;
  mysteryBoxEnabled: boolean | undefined;
  countryCode: string | null | undefined;
}): Promise<MysteryBoxOpenResult> {
  if (!mysteryBoxEnabled) throw throwBadRequestError('Mystery boxes are not available right now');
  if (isMysteryBoxBlockedIn(countryCode, await getMysteryBoxBlockedRegions()))
    throw throwBadRequestError('Mystery boxes are not available in your region');

  const boxItemId = BigInt(boxItemIdInput);

  // The box's event decides the pool's team. Read before the transaction: the team lookup is not
  // on the transaction's connection, and nothing may wait on a second connection under the lock.
  const held = await findHeldItemById(dbWrite, { id: boxItemId, userId });
  if (!held) return replayOpening(dbWrite, boxItemId, userId);
  const params = (held.itemDefinition.params ?? {}) as BoxParams;
  const team = isEventShopItemData(params)
    ? await getEventBuyerTeam(params.event, userId)
    : undefined;

  const opened = await dbWrite
    .$transaction(async (tx) => {
      // First, before any other row: every path granting to this user takes the same lock first.
      await lockItemHolder(tx, userId);

      const [item] = await tx.$queryRaw<
        { id: bigint; itemDefinitionId: number; sourceKey: string }[]
      >`
        SELECT "id", "itemDefinitionId", "sourceKey" FROM "Item"
        WHERE "id" = ${boxItemId} AND "holderType" = 'user' AND "holderId" = ${userId}
        FOR UPDATE
      `;
      // Opened by a request that held the lock before this one.
      if (!item)
        return { kind: 'replay' as const, result: await replayOpening(tx, boxItemId, userId) };

      // FOR SHARE holds the version until commit: a builder save locks this row FOR NO KEY UPDATE
      // and waits for opens in flight, so this open cannot pass the check at one version and draw
      // from the next one's tiers and contents. After the Item lock, never before it.
      const [box] = await tx.$queryRaw<
        { id: number; type: string; version: number; sellerId: number | null }[]
      >`
        SELECT "id", "type", "version", "sellerId" FROM "ItemDefinition"
        WHERE "id" = ${item.itemDefinitionId}
        FOR SHARE
      `;
      if (!box || box.type !== ITEM_TYPE.box)
        throw throwBadRequestError('This box cannot be opened');
      // Not sold or granted yet; whatever path reached one, it doesn't open before it pays its creator.
      if (box.sellerId != null) throw throwBadRequestError('This box cannot be opened');
      // The holder was shown this version's contents and odds.
      if (expectedVersion !== box.version)
        throw throwBadRequestError("This box's contents changed. Check them and try again.");

      const pool = await getBoxPoolForUser(tx, { boxDefinitionId: box.id, userId, team });
      if (!pool.length)
        throw throwBadRequestError(
          "You've collected everything in this box. It stays with you until new contents arrive."
        );
      const tiers = await tx.boxTier.findMany({
        where: { boxDefinitionId: box.id },
        select: { id: true, weight: true, sortOrder: true },
      });
      const draw = drawFromOdds(computeBoxOdds(tiers, pool), randomInt);
      const reward = pool.find((entry) => entry.contentId === draw.contentId);
      if (!reward) throw new Error(`box ${box.id} drew content ${draw.contentId} outside its pool`);

      await tx.userCosmetic.create({
        data: {
          userId,
          cosmeticId: reward.cosmeticId,
          claimKey: boxOpenClaimKey(item.id),
          remaining: stickerUsesFromCosmeticData(reward.cosmeticData),
        },
      });
      const opening = await tx.boxOpening.create({
        data: {
          boxItemId: item.id,
          boxDefinitionId: box.id,
          boxVersion: box.version,
          userId,
          boxSourceKey: item.sourceKey,
          tierId: draw.tierId,
          contentId: draw.contentId,
          rewardDefinitionId: reward.rewardDefinitionId,
          rewardType: ITEM_TYPE.cosmetic,
          tierWeight: draw.tierWeight,
          eligibleWeight: draw.eligibleWeight,
          tierRoll: draw.tierRoll,
          tierPoolSize: draw.tierPoolSize,
          itemRoll: draw.itemRoll,
          rewardStatus: BOX_OPENING_REWARD_STATUS.granted,
        },
      });
      await tx.item.delete({ where: { id: item.id } });

      return {
        kind: 'opened' as const,
        result: openingResult(opening, reward.cosmeticId, false),
        draw,
        sourceKey: item.sourceKey,
        cosmeticEvent: (reward.cosmeticData as { event?: unknown } | null)?.event,
        grantedSticker: reward.cosmeticType === CosmeticType.Sticker,
      };
    })
    .catch((error) => {
      // The backstop unique index on what a user has drawn from a box: the lock should make this
      // unreachable. Nothing committed, so the box is still held.
      if (isPrismaUniqueViolation(error))
        throw throwBadRequestError('This box could not be opened. Please try again.');
      // Also lands here: the box row's FOR SHARE waiting on a builder save, under the timeout
      // lockItemHolder left set.
      if (isPrismaLockTimeout(error)) throw throwRateLimitError(ITEM_HOLDER_BUSY_MESSAGE, error);
      throw error;
    });

  if (opened.kind === 'replay') return opened.result;

  const { result, draw, sourceKey, cosmeticEvent, grantedSticker } = opened;
  logToAxiom({
    type: 'info',
    name: 'mystery-box-open',
    userId,
    boxItemId: result.boxItemId,
    boxSourceKey: sourceKey,
    boxDefinitionId: result.boxDefinitionId,
    boxVersion: result.boxVersion,
    rewardDefinitionId: result.rewardDefinitionId,
    cosmeticId: result.cosmeticId,
    ...draw,
  }).catch();

  // The box is already opened: a cache miss here must not read as a failed open.
  if (grantedSticker) await refreshOwnedStickerCache([userId]).catch(() => undefined);
  // An event hat counts on its owner's team roster, if they are listed.
  if (typeof cosmeticEvent === 'string')
    void syncEventRosterMember(userId, { event: cosmeticEvent, onlyIfListed: true });

  return result;
}
