export const ROTATION_SIZE = 4;
export const DEALS_PER_DAY = 2;
export const DEAL_PERCENT = 20;

export const SHOP_TIERS = ['bronze', 'silver', 'gold'] as const;

export type ShopItem = {
  id: number;
  kind: string;
  name: string;
  description: string;
  price: number;
  buzz: number | null;
  cosmeticId: number | null;
  tier: string | null;
  months: number | null;
  minRank: string | null;
  active: boolean;
  rotating: boolean;
  sortOrder: number;
};

/** The main app sells a membership one month at a time, so an item that says otherwise is not on sale. */
export const isSellable = (item: Pick<ShopItem, 'kind' | 'months'>) =>
  item.kind !== 'membership' || item.months === 1;

export type StockEntry = { item: ShopItem; price: number; deal: boolean };

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export const msUntilNextDay = (now: Date) => {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
};

/** FNV-1a, so a day's picks depend only on the day and the item ids, never on row order or the process. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const byHash = (salt: string) => (a: ShopItem, b: ShopItem) =>
  hash(`${salt}:${String(a.id)}`) - hash(`${salt}:${String(b.id)}`) || a.id - b.id;

export const dealPrice = (price: number) =>
  Math.max(1, Math.floor((price * (100 - DEAL_PERCENT)) / 100));

/** Pure: the same catalog and day give the same stock and deals. */
export function stockFor(
  items: ShopItem[],
  day: string,
  { dealsPerDay = DEALS_PER_DAY }: { dealsPerDay?: number } = {}
): { stock: StockEntry[]; deals: { item: ShopItem; price: number }[] } {
  const active = items.filter((item) => item.active);
  const fixed = active.filter((item) => !item.rotating);
  const rotated = active
    .filter((item) => item.rotating)
    .sort(byHash(`${day}:stock`))
    .slice(0, ROTATION_SIZE);
  const inStock = [...fixed, ...rotated].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const dealIds = new Set(
    [...inStock]
      .sort(byHash(`${day}:deal`))
      .slice(0, dealsPerDay)
      .map((item) => item.id)
  );
  const stock = inStock.map((item) => {
    const deal = dealIds.has(item.id);
    return { item, price: deal ? dealPrice(item.price) : item.price, deal };
  });
  return {
    stock,
    deals: stock.filter((entry) => entry.deal).map(({ item, price }) => ({ item, price })),
  };
}
