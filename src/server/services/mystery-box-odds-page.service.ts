import type { BoxOddsSnapshotData } from '@civitai/shared/box-odds-snapshot';
import {
  boxOddsSnapshotSchema,
  snapshotOfLiveBox,
  snapshotsMatch,
} from '@civitai/shared/box-odds-snapshot';
import { dbRead } from '~/server/db/client';
import type { EventViewer } from '~/server/events/event-access';
import { getEventBoxCatalogAccess, isEventShopItemData } from '~/server/events/event-shop-item';
import { logToAxiom } from '~/server/logging/client';
import { createFallbackDedup } from '~/server/logging/devalue-fallback-log';
import { countHeldItems, ITEM_DEFINITION_STATUS, ITEM_TYPE } from '~/server/services/item.service';
import type { BoxDisplayEntry } from '~/server/services/mystery-box.service';
import {
  BOX_TIER_ORDER,
  BOX_TIER_SELECT,
  getBoxCatalogForDisplay,
  mysteryBoxesHiddenIn,
  readBoxListings,
} from '~/server/services/mystery-box.service';
import { CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * A box's public odds page. Odds and contents come from the live tiers and the contents of the
 * current version (cached per version), the rows the draw reads, so the page cannot show odds the
 * draw does not use. The history comes from
 * `BoxOddsSnapshot` (one row per version, written outside this service); a current version whose
 * snapshot is missing or differs from the live box is logged so the history can be repaired.
 */

export type BoxOddsHistoryEntry = { version: number; createdAt: Date; changes: string[] };

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One version's changes from the one before, in words; the first is the publish. */
export function describeSnapshotChange(
  previous: BoxOddsSnapshotData | undefined,
  next: BoxOddsSnapshotData,
  noun: string
): string[] {
  const weights = next.tiers.map((tier) => tier.weight).join(' / ');
  const names = next.tiers.map((tier) => tier.name).join(' / ');
  if (!previous)
    return [`Published: ${plural(next.contents.length, noun)}, weights ${weights} (${names}).`];

  const changes: string[] = [];
  const before = new Map(previous.tiers.map((tier) => [tier.key, tier]));
  const after = new Map(next.tiers.map((tier) => [tier.key, tier]));
  for (const tier of next.tiers) {
    const old = before.get(tier.key);
    if (!old) changes.push(`Added the ${tier.name} rarity, weight ${tier.weight}.`);
    else {
      if (old.name !== tier.name) changes.push(`Renamed ${old.name} to ${tier.name}.`);
      if (old.weight !== tier.weight)
        changes.push(`${tier.name} weight ${old.weight} → ${tier.weight}.`);
    }
  }
  for (const tier of previous.tiers)
    if (!after.has(tier.key)) changes.push(`Removed the ${tier.name} rarity.`);

  const tierName = (key: string) => after.get(key)?.name ?? before.get(key)?.name ?? key;
  const was = new Map(previous.contents.map((content) => [content.cosmeticId, content.tier]));
  const now = new Map(next.contents.map((content) => [content.cosmeticId, content.tier]));
  const counts = new Map<string, number>();
  const count = (line: string) => counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const [cosmeticId, tier] of now) {
    const oldTier = was.get(cosmeticId);
    if (oldTier === undefined) count(`added to ${tierName(tier)}`);
    else if (oldTier !== tier) count(`moved from ${tierName(oldTier)} to ${tierName(tier)}`);
  }
  for (const [cosmeticId, tier] of was)
    if (!now.has(cosmeticId)) count(`removed from ${tierName(tier)}`);
  for (const [line, n] of counts) changes.push(`${plural(n, noun)} ${line}.`);

  return changes.length ? changes : ['No change to the odds or contents.'];
}

/** "hat" when everything in the box is a hat (an event decoration), else "item". */
function rewardNoun(contents: BoxDisplayEntry[]) {
  const allHats =
    contents.length > 0 &&
    contents.every(
      (c) => c.cosmeticType === CosmeticType.ContentDecoration && c.event !== undefined
    );
  return allHats ? 'hat' : 'item';
}

export type MysteryBoxOddsPage = NonNullable<Awaited<ReturnType<typeof getMysteryBoxOddsPage>>>;

const oddsPageErrorLog = createFallbackDedup({ windowMs: 60_000, maxSize: 1000 });
function logOddsPageError(message: string, fields: { boxDefinitionId: number; version: number }) {
  if (!oddsPageErrorLog.shouldLog(`${fields.boxDefinitionId}:${fields.version}:${message}`)) return;
  logToAxiom({ type: 'error', name: 'mystery-box-odds-page', message, ...fields }).catch();
}

/**
 * A published (or archived) box's public odds page, or null when boxes are off, hidden in the
 * visitor's country, or the box's event is closed to them. A box shows once it has gone on sale (a
 * published listing whose window has opened, or a purchase from any listing); before that, only to
 * moderators and to a viewer who holds or has opened one.
 */
export async function getMysteryBoxOddsPage({
  boxDefinitionId,
  viewer,
  mysteryBoxEnabled,
  countryCode,
}: {
  boxDefinitionId: number;
  viewer: EventViewer;
  mysteryBoxEnabled: boolean | undefined;
  countryCode: string | null | undefined;
}) {
  if (!mysteryBoxEnabled || (await mysteryBoxesHiddenIn(countryCode))) return null;

  const box = await dbRead.itemDefinition.findUnique({
    where: { id: boxDefinitionId },
    select: {
      id: true,
      type: true,
      name: true,
      description: true,
      version: true,
      status: true,
      params: true,
    },
  });
  if (
    !box ||
    box.type !== ITEM_TYPE.box ||
    (box.status !== ITEM_DEFINITION_STATUS.published &&
      box.status !== ITEM_DEFINITION_STATUS.archived)
  )
    return null;

  const params = box.params ?? {};
  const event = isEventShopItemData(params)
    ? await getEventBoxCatalogAccess(params.event, viewer)
    : undefined;
  if (event === null) return null;

  const now = new Date();
  const { listings, onSale: listingOnSale } = await readBoxListings([box.id]);
  const started = listings.some((l) => !l.availableFrom || l.availableFrom <= now);
  // A grant skips the sale, so holding proves none: a holder sees an unsold box's page only for a
  // box of their own.
  if (
    !started &&
    !viewer?.isModerator &&
    !(await boxEverSold(box.id)) &&
    !(viewer?.id && (await viewerHasHeld(box.id, viewer.id)))
  )
    return null;

  const [tiers, contents, snapshots] = await Promise.all([
    dbRead.boxTier.findMany({
      where: { boxDefinitionId: box.id },
      orderBy: BOX_TIER_ORDER,
      select: BOX_TIER_SELECT,
    }),
    getBoxCatalogForDisplay(box),
    dbRead.boxOddsSnapshot.findMany({
      where: { boxDefinitionId: box.id },
      orderBy: { version: 'asc' },
      select: { version: true, snapshot: true, createdAt: true },
    }),
  ]);
  const onSale =
    box.status === ITEM_DEFINITION_STATUS.published ? listingOnSale(box.id) : undefined;

  const noun = rewardNoun(contents);
  const history: BoxOddsHistoryEntry[] = [];
  let previous: BoxOddsSnapshotData | undefined;
  let current: BoxOddsSnapshotData | undefined;
  for (const row of snapshots) {
    const parsed = boxOddsSnapshotSchema.safeParse(row.snapshot);
    if (!parsed.success) {
      logOddsPageError('unreadable odds snapshot', {
        boxDefinitionId: box.id,
        version: row.version,
      });
      continue;
    }
    history.push({
      version: row.version,
      createdAt: row.createdAt,
      changes: describeSnapshotChange(previous, parsed.data, noun),
    });
    previous = parsed.data;
    if (row.version === box.version) current = parsed.data;
  }
  const historyComplete = !!current && snapshotsMatch(current, snapshotOfLiveBox(tiers, contents));
  if (!historyComplete)
    logOddsPageError(
      current
        ? 'odds snapshot differs from the live box'
        : 'no odds snapshot for the current version',
      { boxDefinitionId: box.id, version: box.version }
    );

  // The event's teams in its order, then any team the event doesn't list, so no team's contents
  // are ever shown pooled with another's.
  const contentTeams = [...new Set(contents.flatMap((c) => (c.team ? [c.team] : [])))];
  const eventTeams = event?.teams ?? [];
  const teams = [
    ...eventTeams.filter((team) => contentTeams.includes(team)),
    ...contentTeams.filter((team) => !eventTeams.includes(team)),
  ];
  return {
    boxDefinitionId: box.id,
    name: box.name,
    description: box.description,
    version: box.version,
    archived: box.status === ITEM_DEFINITION_STATUS.archived,
    noun,
    event: event ? { title: event.title } : null,
    teams,
    price: onSale?.unitAmount ?? null,
    tiers,
    contents: contents.map(({ contentId, tierId, cosmeticId, name, url, fit, team }) => ({
      contentId,
      tierId,
      cosmeticId,
      name,
      url,
      fit,
      team: team ?? null,
    })),
    /** Newest first. */
    history: history.reverse(),
    /** False when the current version's snapshot is missing or differs from the live box. */
    historyComplete,
  };
}

/**
 * Whether any listing of this box, of any status, has a purchase: `readBoxListings` sees only
 * Published ones, but a sold box stays sold. A grant must never write a purchase row.
 */
async function boxEverSold(boxDefinitionId: number) {
  const listings = await dbRead.cosmeticShopItem.findMany({
    where: { itemDefinitionId: boxDefinitionId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (!listings.length) return false;
  const purchase = await dbRead.userCosmeticShopPurchases.findFirst({
    where: { shopItemId: { in: listings.map((listing) => listing.id) } },
    select: { buzzTransactionId: true },
  });
  return !!purchase;
}

async function viewerHasHeld(boxDefinitionId: number, userId: number) {
  const [held, opened] = await Promise.all([
    countHeldItems(dbRead, { itemDefinitionId: boxDefinitionId, userId }),
    dbRead.boxOpening.findFirst({
      where: { boxDefinitionId, userId },
      select: { boxItemId: true },
    }),
  ]);
  return held > 0 || !!opened;
}
