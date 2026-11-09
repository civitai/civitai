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
  days: number | null;
  minRank: string | null;
  active: boolean;
  rotating: boolean;
  sortOrder: number;
};

/** The length of a shop membership; the main app is asked for this many days. */
export const MEMBERSHIP_DAYS = 7;

/** The shop sells a membership one week at a time, so an item that says otherwise is not on sale. */
export const isSellable = (item: Pick<ShopItem, 'kind' | 'days'>) =>
  item.kind !== 'membership' || item.days === MEMBERSHIP_DAYS;

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

/**
 * Creator cosmetics the main app withholds: nobody may wear them until a moderator approves the creator's
 * listing, so the shop must not sell them. Mirrors `getWithheldCosmeticIds` and `isListingDisplayable` in the
 * main app (`creator-shop-withheld.ts`, `creator-shop.data.ts`); `src/server/services/knights/__tests__/withheld-parity.test.ts` keeps the two in step.
 */
const COSMETIC_FLAG_WITHHELD = 1 << 2;
// Fields whose edit sends an approved listing back to review (`DISPLAYED_FIELDS` in the main app).
const DISPLAYED_FIELDS = new Set(['name', 'description', 'artwork', 'offsets', 'slug']);

type ListingHistory = {
  kind?: string;
  action?: string;
  changes?: { field: string }[];
};
type ListingMeta = {
  takedown?: unknown;
  displayApproved?: boolean;
  lastApprovedAmount?: number | null;
  history?: ListingHistory[];
} | null;

export type CosmeticListing = {
  cosmeticId: number | null;
  addedById: number | null;
  status: string;
  meta: unknown;
  rejectionReason: string | null;
};
export type CosmeticOwnerRow = { id: number; createdById: number | null; flags: number };

export function isListingDisplayable(
  listing: Pick<CosmeticListing, 'status' | 'rejectionReason'> & { meta: unknown }
) {
  if (listing.status === 'Published') return true;
  const meta = listing.meta as ListingMeta;
  if (meta?.takedown) return false;
  if (meta?.displayApproved !== undefined) return meta.displayApproved;
  const history = meta?.history ?? [];
  let index = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].kind === 'reviewed') {
      index = i;
      break;
    }
  }
  const approved =
    index >= 0
      ? history[index].action === 'approve'
      : meta?.lastApprovedAmount != null && !listing.rejectionReason;
  return (
    approved &&
    !history
      .slice(index + 1)
      .some((entry) => entry.changes?.some((change) => DISPLAYED_FIELDS.has(change.field)))
  );
}

/** The ids among `cosmetics` that cannot be worn yet; `listings` are the shop listings of those cosmetics. */
export function withheldCosmeticIds(
  cosmetics: CosmeticOwnerRow[],
  listings: CosmeticListing[]
): Set<number> {
  const owner = new Map(cosmetics.map((row) => [row.id, row]));
  const withheld = new Set<number>();
  const displayable = new Set<number>();
  for (const listing of listings) {
    const cosmetic = listing.cosmeticId === null ? undefined : owner.get(listing.cosmeticId);
    if (!cosmetic || cosmetic.createdById === null || listing.addedById !== cosmetic.createdById)
      continue;
    (isListingDisplayable(listing) ? displayable : withheld).add(cosmetic.id);
  }
  for (const id of displayable) withheld.delete(id);
  for (const { id, createdById, flags } of cosmetics) {
    if (createdById === null || displayable.has(id) || withheld.has(id)) continue;
    if ((flags & COSMETIC_FLAG_WITHHELD) !== 0) withheld.add(id);
  }
  return withheld;
}
