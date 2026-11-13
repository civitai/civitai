import { randomUUID } from 'crypto';
import { clickhouse } from '~/server/clickhouse/client';
import type { Tracker } from '~/server/clickhouse/client';
import type { EntityChangeRow } from '~/server/common/entity-change.constants';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { CIVITAI_SHOP_ATTRIBUTION } from '~/server/schema/cosmetic-shop.schema';

// Section saves replace CosmeticShopSectionItem rows outright, so this audit trail is the only
// record of what was featured once an item leaves a section.
const FEATURED_FIELD = 'shopSection';

export function diffSectionItems(before: number[], after: number[]) {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: after.filter((id) => !was.has(id)),
    removed: before.filter((id) => !now.has(id)),
  };
}

export async function logSectionPlacements({
  tracker,
  sectionId,
  added = [],
  removed = [],
  reason = '',
}: {
  tracker?: Tracker;
  sectionId: number;
  added?: number[];
  removed?: number[];
  reason?: string;
}) {
  if (!tracker || (!added.length && !removed.length)) return;
  // The section write has already landed; a failed audit write must not fail it.
  try {
    await writePlacementRows({ tracker, sectionId, added, removed, reason });
  } catch (error) {
    logToAxiom({ type: 'error', name: 'shop-featured-log', message: (error as Error).message });
  }
}

async function writePlacementRows({
  tracker,
  sectionId,
  added,
  removed,
  reason,
}: {
  tracker: Tracker;
  sectionId: number;
  added: number[];
  removed: number[];
  reason: string;
}) {
  const items = await dbRead.cosmeticShopItem.findMany({
    where: { id: { in: [...added, ...removed] } },
    select: { id: true, cosmetic: { select: { createdById: true } } },
  });
  const ownerById = new Map(items.map((i) => [i.id, i.cosmetic?.createdById]));
  const batchId = randomUUID();
  const section = JSON.stringify(sectionId);
  const row = (shopItemId: number, oldValue: string, newValue: string): EntityChangeRow => ({
    entityType: 'CosmeticShopItem',
    entityId: shopItemId,
    ownerId: ownerById.get(shopItemId) ?? CIVITAI_SHOP_ATTRIBUTION,
    field: FEATURED_FIELD,
    oldValue,
    newValue,
    truncated: 0,
    actorRole: 'moderator',
    reason,
    batchId,
  });

  await tracker.entityChanges([
    ...added.map((id) => row(id, '', section)),
    ...removed.map((id) => row(id, section, '')),
  ]);
}

export type ShopItemFeaturedHistory = {
  /** Epoch ms of the last time a moderator put the item in a section; logging began Nov 2026. */
  lastFeaturedAt: number | null;
  currentSections: { id: number; title: string }[];
};

export async function getShopItemsFeaturedHistory({ ids }: { ids: number[] }) {
  const result: Record<number, ShopItemFeaturedHistory> = {};
  if (!ids.length) return result;
  for (const id of ids) result[id] = { lastFeaturedAt: null, currentSections: [] };

  const [placements, logged] = await Promise.all([
    dbRead.cosmeticShopSectionItem.findMany({
      where: { shopItemId: { in: ids } },
      select: { shopItemId: true, shopSection: { select: { id: true, title: true } } },
    }),
    clickhouse
      ? // ids are zod-validated integers; $query does not escape strings.
        clickhouse.$query<{ entityId: number; at: number }>(`
          SELECT entityId, toUnixTimestamp64Milli(max(createdAt)) AS at
          FROM entityChangeEvents
          WHERE entityType = 'CosmeticShopItem'
            AND entityId IN (${ids.map(Number).join(',')})
            AND field = '${FEATURED_FIELD}'
            AND newValue != ''
          GROUP BY entityId
        `)
      : [],
  ]);

  for (const p of placements) result[p.shopItemId]?.currentSections.push(p.shopSection);
  for (const l of logged) {
    const entry = result[Number(l.entityId)];
    if (entry) entry.lastFeaturedAt = Number(l.at);
  }
  return result;
}
