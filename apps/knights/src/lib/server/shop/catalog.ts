import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { rankIndex } from '../ranks';
import { cosmeticImageKey, holdingBlocksPurchase, stickerUses } from './cosmetics';
import { hasActiveMembership } from './inventory';
import { isSellable, msUntilNextDay, stockFor, utcDay, type ShopItem } from './rotation';

/** Why a card cannot be bought right now; `available` means it can (affordability is the player's gold, checked at the press). */
export type CardState = 'available' | 'owned' | 'member' | 'rank' | 'sold-out' | 'closed';

export type ShopCard = {
  id: string;
  kind: 'buzz_pack' | 'cosmetic' | 'membership';
  name: string;
  description: string;
  /** What the player pays today (the deal price on a deal). */
  price: number;
  listPrice: number;
  deal: boolean;
  buzz: number | null;
  tier: string | null;
  months: number | null;
  minRank: string | null;
  state: CardState;
  cosmeticType: string | null;
  /** Uses a sticker purchase adds; null for everything else and for an unlimited sticker. */
  uses: number | null;
  imageKey: string | null;
  /** Sticker only: the player already holds it, so more of it adds uses. */
  heldUses: number | null;
};

export type ShopView = {
  day: string;
  refreshesAt: string;
  cards: ShopCard[];
};

/** The shop as one player sees it today: the day's stock and deals, each card with what stops the player buying it. */
export async function loadShop(
  db: Kysely<DB>,
  {
    playerId,
    rank,
    now,
    buzzPacksOpen,
  }: { playerId: number; rank: string; now: Date; buzzPacksOpen: boolean }
): Promise<ShopView> {
  const day = utcDay(now);
  const items: ShopItem[] = (
    await db.selectFrom('KnightsShopItem').selectAll().where('active', '=', true).execute()
  ).filter(isSellable);
  const { stock } = stockFor(items, day);

  const cosmeticIds = stock.flatMap(({ item }) => (item.cosmeticId ? [item.cosmeticId] : []));
  const sellsMembership = stock.some(({ item }) => item.kind === 'membership');
  const [cosmetics, owned, dealsTaken, hasMembership] = await Promise.all([
    cosmeticIds.length
      ? db
          .selectFrom('Cosmetic')
          .select(['id', 'type', 'data'])
          .where('id', 'in', cosmeticIds)
          .execute()
      : [],
    cosmeticIds.length
      ? db
          .selectFrom('UserCosmetic')
          .select(['cosmeticId', 'remaining'])
          .where('userId', '=', playerId)
          .where('cosmeticId', 'in', cosmeticIds)
          .execute()
      : [],
    db
      .selectFrom('KnightsShopPurchase')
      .select('itemId')
      .where('playerId', '=', playerId)
      .where(sql<boolean>`"dealDay" = ${day}::date`)
      .where('status', '<>', 'failed')
      .execute(),
    sellsMembership ? hasActiveMembership(db, playerId, now) : false,
  ]);
  const taken = new Set(dealsTaken.map((row) => row.itemId));

  const cards = stock.flatMap(({ item, price, deal }): ShopCard[] => {
    const cosmetic = cosmetics.find((row) => row.id === item.cosmeticId);
    // An item whose cosmetic row is gone cannot be granted, so it is not shown.
    if (item.kind === 'cosmetic' && !cosmetic) return [];
    const held = owned.filter((row) => row.cosmeticId === item.cosmeticId);
    const isSticker = cosmetic?.type === 'Sticker';
    const uses = isSticker ? stickerUses(cosmetic?.data) : null;

    let state: CardState = 'available';
    if (item.kind === 'buzz_pack' && !buzzPacksOpen) state = 'closed';
    else if (item.minRank && rankIndex(rank) < rankIndex(item.minRank)) state = 'rank';
    else if (deal && taken.has(item.id)) state = 'sold-out';
    else if (cosmetic && holdingBlocksPurchase(cosmetic.type, held)) state = 'owned';
    else if (item.kind === 'membership' && hasMembership) state = 'member';
    return [
      {
        id: item.id,
        kind: item.kind as ShopCard['kind'],
        name: item.name,
        description: item.description,
        price,
        listPrice: item.price,
        deal,
        buzz: item.buzz,
        tier: item.tier,
        months: item.months,
        minRank: item.minRank,
        state,
        cosmeticType: cosmetic?.type ?? null,
        uses,
        imageKey: cosmeticImageKey(cosmetic?.data),
        heldUses:
          isSticker && held.length ? held.reduce((n, row) => n + (row.remaining ?? 0), 0) : null,
      },
    ];
  });

  return { day, refreshesAt: new Date(now.getTime() + msUntilNextDay(now)).toISOString(), cards };
}
