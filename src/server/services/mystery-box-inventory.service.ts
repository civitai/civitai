import { dbRead } from '~/server/db/client';
import { BOX_OPENING_REWARD_STATUS } from '@civitai/shared/mystery-box';
import { getEventBoxViewer, isEventShopItemData } from '~/server/events/event-shop-item';
import {
  countHeldItemsByDefinition,
  ITEM_TYPE,
  listHeldItems,
} from '~/server/services/item.service';
import type { MysteryBoxView } from '~/server/services/mystery-box.service';
import {
  BOX_DEFINITION_SELECT,
  buildMysteryBoxView,
  getBoxTiers,
  mysteryBoxesHiddenIn,
  SHOWN_BOX_STATUSES,
} from '~/server/services/mystery-box.service';

type Viewer = {
  userId: number;
  isModerator?: boolean;
  mysteryBoxEnabled: boolean | undefined;
  countryCode: string | null | undefined;
};

/**
 * The held box kinds the viewer may see, with counts and the team each is shown for. An event box
 * must pass its event's gate (`getEventBoxViewer`, read only); a box with no event has no team, as
 * when it is opened.
 */
async function readVisibleHeldKinds({
  userId,
  isModerator,
  mysteryBoxEnabled,
  countryCode,
}: Viewer) {
  if (!mysteryBoxEnabled || (await mysteryBoxesHiddenIn(countryCode))) return [];
  const counts = await countHeldItemsByDefinition(dbRead, {
    userId,
    definition: { type: ITEM_TYPE.box, status: { in: SHOWN_BOX_STATUSES } },
  });
  if (!counts.size) return [];

  const boxes = await dbRead.itemDefinition.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: BOX_DEFINITION_SELECT,
    orderBy: { id: 'asc' },
  });
  const events = [
    ...new Set(boxes.flatMap(({ params }) => (isEventShopItemData(params) ? [params.event] : []))),
  ];
  const viewers = new Map(
    await Promise.all(
      events.map(
        async (event) =>
          [event, await getEventBoxViewer(event, { id: userId, isModerator })] as const
      )
    )
  );

  return boxes.flatMap((box) => {
    const held = counts.get(box.id) ?? 0;
    if (!isEventShopItemData(box.params)) return [{ box, held, event: null, team: undefined }];
    const viewer = viewers.get(box.params.event);
    return viewer
      ? [{ box, held, event: box.params.event as string | null, team: viewer.team }]
      : [];
  });
}

export type HeldMysteryBox = MysteryBoxView & {
  /** The event the box belongs to, or null for a box with no event. */
  event: string | null;
  /** Each held box of this kind: the Inventory lists them one by one. */
  heldItems: { id: string; acquiredAt: Date }[];
};

/**
 * The viewer's unopened boxes, one view per kind, built as the event page builds them so the odds
 * shown are the draw's.
 */
export async function getHeldMysteryBoxes(viewer: Viewer): Promise<HeldMysteryBox[]> {
  const kinds = await readVisibleHeldKinds(viewer);
  if (!kinds.length) return [];

  const boxIds = kinds.map(({ box }) => box.id);
  const [items, tiers] = await Promise.all([
    listHeldItems(dbRead, { userId: viewer.userId, itemDefinitionIds: boxIds }),
    getBoxTiers(boxIds),
  ]);
  const itemsByBox = new Map<number, typeof items>();
  for (const item of items) {
    const ofBox = itemsByBox.get(item.itemDefinitionId);
    if (ofBox) ofBox.push(item);
    else itemsByBox.set(item.itemDefinitionId, [item]);
  }

  return Promise.all(
    kinds.flatMap(({ box, event, team }) => {
      const held = itemsByBox.get(box.id);
      // Opened since the count was read.
      if (!held) return [];
      return [
        buildMysteryBoxView(box, {
          userId: viewer.userId,
          team,
          tiers,
          listing: null,
          heldBoxItemIds: held.map((item) => item.id.toString()),
        }).then((view) => ({
          ...view,
          event,
          heldItems: held.map((item) => ({ id: item.id.toString(), acquiredAt: item.createdAt })),
        })),
      ];
    })
  );
}

/** How many unopened boxes the viewer has that the Inventory would list. */
export async function countHeldMysteryBoxes(viewer: Viewer) {
  return (await readVisibleHeldKinds(viewer)).reduce((total, { held }) => total + held, 0);
}

export type MysteryBoxOpeningEntry = {
  boxItemId: string;
  openedAt: Date;
  box: { id: number; name: string } | null;
  tier: { id: number; name: string; color: string | null; sortOrder: number } | null;
  reward: { name: string | null; url: string | null; cosmeticType: string | null } | null;
};

/**
 * The viewer's own opens, newest first: what each gave, its rarity and from which box. Hidden as the
 * boxes are (flag off, blocked country); the rewards themselves stay theirs either way.
 */
export async function getMysteryBoxOpenings({
  userId,
  mysteryBoxEnabled,
  countryCode,
  limit,
  cursor,
}: Viewer & { limit: number; cursor?: string }): Promise<{
  items: MysteryBoxOpeningEntry[];
  nextCursor: string | undefined;
}> {
  if (!mysteryBoxEnabled || (await mysteryBoxesHiddenIn(countryCode)))
    return { items: [], nextCursor: undefined };

  const rows = await dbRead.boxOpening.findMany({
    // A refunded open's reward was taken back.
    where: { userId, rewardStatus: BOX_OPENING_REWARD_STATUS.granted },
    orderBy: [{ createdAt: 'desc' }, { boxItemId: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { boxItemId: BigInt(cursor) }, skip: 1 } : {}),
    select: {
      boxItemId: true,
      boxDefinitionId: true,
      tierId: true,
      rewardDefinitionId: true,
      createdAt: true,
    },
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].boxItemId.toString() : undefined;
  if (!page.length) return { items: [], nextCursor };

  const [boxes, tiers, rewards] = await Promise.all([
    dbRead.itemDefinition.findMany({
      where: { id: { in: [...new Set(page.map((row) => row.boxDefinitionId))] } },
      select: { id: true, name: true },
    }),
    dbRead.boxTier.findMany({
      where: { id: { in: [...new Set(page.map((row) => row.tierId))] } },
      select: { id: true, name: true, color: true, sortOrder: true },
    }),
    dbRead.itemDefinition.findMany({
      where: { id: { in: [...new Set(page.map((row) => row.rewardDefinitionId))] } },
      select: { id: true, cosmetic: { select: { name: true, data: true, type: true } } },
    }),
  ]);

  return {
    items: page.map((row) => {
      const cosmetic = rewards.find((r) => r.id === row.rewardDefinitionId)?.cosmetic;
      const url = (cosmetic?.data as { url?: unknown } | null)?.url;
      return {
        boxItemId: row.boxItemId.toString(),
        openedAt: row.createdAt,
        box: boxes.find((b) => b.id === row.boxDefinitionId) ?? null,
        tier: tiers.find((t) => t.id === row.tierId) ?? null,
        reward: cosmetic
          ? {
              name: cosmetic.name,
              url: typeof url === 'string' ? url : null,
              cosmeticType: cosmetic.type,
            }
          : null,
      };
    }),
    nextCursor,
  };
}
