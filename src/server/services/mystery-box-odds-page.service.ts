import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import type { EventViewer } from '~/server/events/event-access';
import { getEventBoxCatalogAccess, isEventShopItemData } from '~/server/events/event-shop-item';
import { logToAxiom } from '~/server/logging/client';
import { ITEM_DEFINITION_STATUS, ITEM_TYPE } from '~/server/services/item.service';
import type { BoxCatalogEntry } from '~/server/services/mystery-box.service';
import {
  boxContentDisplay,
  getBoxCatalog,
  mysteryBoxesHiddenIn,
} from '~/server/services/mystery-box.service';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * The public odds page of a mystery box: its base odds (nothing owned), everything it holds, and how
 * its tiers and contents changed version by version.
 *
 * The odds and contents come from the live tiers and contents, the rows the draw reads, so the page
 * cannot show odds the draw does not use. The history comes from `BoxOddsSnapshot`, written on every
 * publish or edit; a current version whose snapshot is missing or differs from the live box is
 * logged, so the history can be repaired.
 */

const boxOddsSnapshotSchema = z.object({
  tiers: z.array(z.object({ key: z.string(), name: z.string(), weight: z.number().int() })),
  contents: z.array(z.object({ tier: z.string(), cosmeticId: z.number().int() })),
});

export type BoxOddsSnapshotData = z.infer<typeof boxOddsSnapshotSchema>;

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

/** The live box in snapshot form, to compare with the snapshot of its current version. */
export function snapshotOfLiveBox(
  tiers: { id: number; key: string; name: string; weight: number; sortOrder: number }[],
  contents: Pick<BoxCatalogEntry, 'tierId' | 'cosmeticId'>[]
): BoxOddsSnapshotData {
  const ordered = [...tiers].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const keyOf = new Map(ordered.map((tier) => [tier.id, tier.key]));
  const rank = new Map(ordered.map((tier, i) => [tier.key, i]));
  return {
    tiers: ordered.map(({ key, name, weight }) => ({ key, name, weight })),
    contents: contents
      .map((content) => ({ tier: keyOf.get(content.tierId) ?? '', cosmeticId: content.cosmeticId }))
      .sort((a, b) => rank.get(a.tier)! - rank.get(b.tier)! || a.cosmeticId - b.cosmeticId),
  };
}

/** Same tiers and weights in the same order, and the same cosmetics in the same tiers. */
export function snapshotsMatch(a: BoxOddsSnapshotData, b: BoxOddsSnapshotData) {
  const tiersOf = (s: BoxOddsSnapshotData) => s.tiers.map((t) => `${t.key}:${t.name}:${t.weight}`);
  const contentsOf = (s: BoxOddsSnapshotData) =>
    s.contents.map((c) => `${c.tier}:${c.cosmeticId}`).sort();
  return (
    tiersOf(a).join('|') === tiersOf(b).join('|') &&
    contentsOf(a).join('|') === contentsOf(b).join('|')
  );
}

/** "hat" when everything in the box is a hat (an event decoration), else "item". */
function rewardNoun(contents: BoxCatalogEntry[]) {
  const allHats =
    contents.length > 0 &&
    contents.every(
      (c) =>
        c.cosmeticType === CosmeticType.ContentDecoration && isEventShopItemData(c.cosmeticData)
    );
  return allHats ? 'hat' : 'item';
}

export type MysteryBoxOddsPage = NonNullable<Awaited<ReturnType<typeof getMysteryBoxOddsPage>>>;

/**
 * A published (or archived) box's public odds page, or null when boxes are off, hidden in the
 * visitor's country, or the box's event is closed to them.
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

  // An event's box is read only by those the event is open to, as on the event page.
  const params = box.params ?? {};
  const event = isEventShopItemData(params)
    ? await getEventBoxCatalogAccess(params.event, viewer)
    : undefined;
  if (event === null) return null;

  const [tiers, contents, snapshots, listing] = await Promise.all([
    dbRead.boxTier.findMany({
      where: { boxDefinitionId: box.id },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, key: true, name: true, color: true, weight: true, sortOrder: true },
    }),
    getBoxCatalog(dbRead, box.id),
    dbRead.boxOddsSnapshot.findMany({
      where: { boxDefinitionId: box.id },
      orderBy: { version: 'asc' },
      select: { version: true, snapshot: true, createdAt: true },
    }),
    dbRead.cosmeticShopItem.findFirst({
      where: { itemDefinitionId: box.id, status: CosmeticShopItemStatus.Published },
      orderBy: { id: 'asc' },
      select: { unitAmount: true },
    }),
  ]);

  const noun = rewardNoun(contents);
  const history: BoxOddsHistoryEntry[] = [];
  let previous: BoxOddsSnapshotData | undefined;
  let current: BoxOddsSnapshotData | undefined;
  for (const row of snapshots) {
    const parsed = boxOddsSnapshotSchema.safeParse(row.snapshot);
    if (!parsed.success) {
      logToAxiom({
        type: 'error',
        name: 'mystery-box-odds-page',
        message: 'unreadable odds snapshot',
        boxDefinitionId: box.id,
        version: row.version,
      }).catch();
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
  if (!current || !snapshotsMatch(current, snapshotOfLiveBox(tiers, contents)))
    logToAxiom({
      type: 'error',
      name: 'mystery-box-odds-page',
      message: current
        ? 'odds snapshot differs from the live box'
        : 'no odds snapshot for the current version',
      boxDefinitionId: box.id,
      version: box.version,
    }).catch();

  const teams = [...new Set(contents.flatMap((c) => (c.team ? [c.team] : [])))];
  return {
    boxDefinitionId: box.id,
    name: box.name,
    description: box.description,
    version: box.version,
    archived: box.status === ITEM_DEFINITION_STATUS.archived,
    noun,
    event: event ? { title: event.title } : null,
    /** The event's teams that the box holds anything for, in the event's order. */
    teams: event ? event.teams.filter((team) => teams.includes(team)) : [],
    price: listing?.unitAmount ?? null,
    tiers,
    contents: contents.map((entry) => ({ ...boxContentDisplay(entry), team: entry.team ?? null })),
    /** Newest first. */
    history: history.reverse(),
  };
}
