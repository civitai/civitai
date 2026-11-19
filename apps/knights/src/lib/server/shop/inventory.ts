import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { STREAK_BADGE_IDS } from '../daily/streak-badges';
import { RANK_BADGE_COSMETICS } from '../rank-badges';
import { cosmeticImageKey } from './cosmetics';

export type InventoryItem = {
  cosmeticId: number;
  name: string;
  type: string;
  equipped: boolean;
  /** Null: not a consumable, or an unlimited sticker. */
  uses: number | null;
  origin: 'shop' | 'rank' | 'streak';
  imageKey: string | null;
};

/** `tier` is null when the live subscription's product names none: the membership still blocks another month. */
export type MembershipStatus = { tier: string | null; endsAt: Date } | null;

const RANK_BADGE_IDS = Object.values(RANK_BADGE_COSMETICS);

/**
 * What a player owns that Knights put there: cosmetics bought in the shop (their `claimKey` is a purchase's
 * `externalKey`), the rank badges and the Watch-streak badges. Stickers add up across purchases and are used, never
 * equipped.
 */
export async function listInventory(db: Kysely<DB>, playerId: number): Promise<InventoryItem[]> {
  const streakBadgeIds = Object.values(STREAK_BADGE_IDS).filter((id) => id !== null);
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
        eb('uc.cosmeticId', 'in', [...RANK_BADGE_IDS, ...streakBadgeIds]),
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
      origin: row.fromShop ? 'shop' : streakBadgeIds.includes(row.id) ? 'streak' : 'rank',
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

const LIVE_MEMBERSHIP = ['canceled', 'incomplete_expired'];

/** The same test the main app's membership grant applies: a row that is not cancelled and has not run out blocks another month. */
const liveMembershipRows = (db: Kysely<DB>, playerId: number, now: Date) =>
  db
    .selectFrom('CustomerSubscription as cs')
    .innerJoin('Product as p', 'p.id', 'cs.productId')
    .where('cs.userId', '=', playerId)
    .where('cs.status', 'not in', LIVE_MEMBERSHIP)
    .where('cs.currentPeriodEnd', '>', now);

export async function membershipOf(
  db: Kysely<DB>,
  playerId: number,
  now: Date
): Promise<MembershipStatus> {
  const row = await liveMembershipRows(db, playerId, now)
    .select(['cs.currentPeriodEnd', sql<string | null>`p."metadata" ->> 'tier'`.as('tier')])
    .orderBy('cs.currentPeriodEnd', 'desc')
    .executeTakeFirst();
  return row ? { tier: row.tier, endsAt: row.currentPeriodEnd } : null;
}

/** The main app stays the authority; this only spares the player a round trip. */
export async function hasActiveMembership(
  db: Kysely<DB>,
  playerId: number,
  now: Date
): Promise<boolean> {
  return (await membershipOf(db, playerId, now)) !== null;
}

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
