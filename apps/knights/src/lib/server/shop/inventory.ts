import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { RANK_BADGE_COSMETICS } from '../rank-badges';
import { cosmeticImageKey } from './cosmetics';

export type InventoryItem = {
  cosmeticId: number;
  name: string;
  type: string;
  equipped: boolean;
  /** Sticker uses left across every purchase; null for anything that is not a consumable. */
  uses: number | null;
  /** Where it came from: bought in the shop, or a rank reward. */
  origin: 'shop' | 'rank';
  imageKey: string | null;
};

export type MembershipStatus = { tier: string; endsAt: Date; queuedDays: number } | null;

const RANK_BADGE_IDS = Object.values(RANK_BADGE_COSMETICS);

/**
 * What a player owns that Knights put there: cosmetics bought in the shop (their `claimKey` is a purchase's
 * `externalKey`) and the rank badges. Stickers add up across purchases and are used, never equipped.
 */
export async function listInventory(db: Kysely<DB>, playerId: number): Promise<InventoryItem[]> {
  const rows = await db
    .selectFrom('UserCosmetic as uc')
    .innerJoin('Cosmetic as c', 'c.id', 'uc.cosmeticId')
    .select([
      'c.id',
      'c.name',
      'c.type',
      'c.data',
      'uc.equippedAt',
      'uc.remaining',
      sql<boolean>`EXISTS (SELECT 1 FROM "KnightsShopPurchase" s WHERE s."externalKey" = uc."claimKey" AND s."playerId" = uc."userId")`.as(
        'fromShop'
      ),
    ])
    .where('uc.userId', '=', playerId)
    .where((eb) =>
      eb.or([
        eb(
          'uc.claimKey',
          'in',
          eb
            .selectFrom('KnightsShopPurchase')
            .select('externalKey')
            .where('playerId', '=', playerId)
            .where('kind', '=', 'cosmetic')
        ),
        eb('uc.cosmeticId', 'in', RANK_BADGE_IDS),
      ])
    )
    .execute();

  const byCosmetic = new Map<number, InventoryItem>();
  for (const row of rows) {
    const existing = byCosmetic.get(row.id);
    const sticker = row.type === 'Sticker';
    const item: InventoryItem = existing ?? {
      cosmeticId: row.id,
      name: row.name,
      type: row.type,
      equipped: false,
      uses: sticker ? 0 : null,
      origin: row.fromShop ? 'shop' : 'rank',
      imageKey: cosmeticImageKey(row.data),
    };
    item.equipped ||= row.equippedAt !== null;
    if (sticker) {
      // one unlimited holding makes the whole stack unlimited
      item.uses = item.uses === null || row.remaining === null ? null : item.uses + row.remaining;
    }
    if (row.fromShop) item.origin = 'shop';
    byCosmetic.set(row.id, item);
  }
  return [...byCosmetic.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
  );
}

/** The player's running referral-queue membership, which is where shop months land; null when none is active. */
export async function membershipOf(
  db: Kysely<DB>,
  playerId: number,
  now: Date
): Promise<MembershipStatus> {
  const row = await db
    .selectFrom('CustomerSubscription as cs')
    .innerJoin('Product as p', 'p.id', 'cs.productId')
    .select([
      'cs.currentPeriodEnd',
      'cs.metadata',
      sql<string | null>`p."metadata" ->> 'tier'`.as('tier'),
    ])
    .where('cs.userId', '=', playerId)
    .where('cs.buzzType', '=', 'referral')
    .where('cs.status', '=', 'active')
    .where('cs.currentPeriodEnd', '>', now)
    .executeTakeFirst();
  if (!row?.tier) return null;
  const queue = (row.metadata as { referralQueue?: { durationDays?: number }[] } | null)
    ?.referralQueue;
  const queuedDays = Array.isArray(queue)
    ? queue.reduce(
        (n, entry) => n + (typeof entry.durationDays === 'number' ? entry.durationDays : 0),
        0
      )
    : 0;
  return { tier: row.tier, endsAt: row.currentPeriodEnd, queuedDays };
}

/** The last purchases, for the shop's "Recent" list. */
export async function recentPurchases(db: Kysely<DB>, playerId: number, limit = 8) {
  return db
    .selectFrom('KnightsShopPurchase as s')
    .innerJoin('KnightsShopItem as i', 'i.id', 's.itemId')
    .select(['s.id', 's.gold', 's.status', 's.createdAt', 'i.name', 'i.kind'])
    .where('s.playerId', '=', playerId)
    .orderBy('s.id', 'desc')
    .limit(limit)
    .execute();
}
