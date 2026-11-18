import { sql, type Kysely } from 'kysely';
import { withheldCosmetics } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import { rankIndex } from '../ranks';
import {
  cosmeticImageKey,
  frameFit,
  holdingBlocksPurchase,
  nameplateGradient,
  stickerUses,
  type FrameFit,
  type NameplateGradient,
} from './cosmetics';
import { hasActiveMembership } from './inventory';
import {
  isSellable,
  msUntilNextDay,
  stockFor,
  utcDay,
  type ShopItem,
} from '@civitai/shared/knights-shop';

/** Affordability is not a state: the player's gold is checked at the press. */
export type CardState = 'available' | 'owned' | 'member' | 'rank' | 'sold-out' | 'closed';

export type ShopCard = {
  id: number;
  kind: 'buzz_pack' | 'cosmetic' | 'membership';
  name: string;
  description: string;
  price: number;
  listPrice: number;
  deal: boolean;
  buzz: number | null;
  tier: string | null;
  days: number | null;
  minRank: string | null;
  state: CardState;
  cosmeticType: string | null;
  /** Null for anything but a limited sticker. */
  uses: number | null;
  imageKey: string | null;
  /** A nameplate's gradient, so the shop can paint the viewer's name in it. */
  nameplate: NameplateGradient | null;
  /** How an avatar frame sits around the avatar, so the try-on preview places it as the main site does. */
  frameFit: FrameFit | null;
  heldUses: number | null;
};

export type ShopView = {
  day: string;
  refreshesAt: string;
  cards: ShopCard[];
};

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
  const sellable: ShopItem[] = (
    await db.selectFrom('KnightsShopItem').selectAll().where('active', '=', true).execute()
  ).filter(isSellable);
  // Not approved yet: nobody can wear it, so it is neither offered nor drawn into the day's rotation or deals.
  const withheld = await withheldCosmetics(
    db,
    sellable.flatMap((item) => (item.cosmeticId === null ? [] : [item.cosmeticId]))
  );
  const items = sellable.filter(
    (item) => item.cosmeticId === null || !withheld.has(item.cosmeticId)
  );
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
        days: item.days,
        minRank: item.minRank,
        state,
        cosmeticType: cosmetic?.type ?? null,
        uses,
        imageKey: cosmeticImageKey(cosmetic?.data),
        nameplate: cosmetic?.type === 'NamePlate' ? nameplateGradient(cosmetic.data) : null,
        frameFit: cosmetic?.type === 'ProfileDecoration' ? frameFit(cosmetic.data) : null,
        heldUses:
          isSticker && held.length ? held.reduce((n, row) => n + (row.remaining ?? 0), 0) : null,
      },
    ];
  });

  return { day, refreshesAt: new Date(now.getTime() + msUntilNextDay(now)).toISOString(), cards };
}
