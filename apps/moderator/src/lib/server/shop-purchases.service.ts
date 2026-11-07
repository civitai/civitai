import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { USER_ACCOUNT_TYPES } from './buzz-accounts';
import { MAX_BUZZ_DAYS } from './buzz-flows.service';
import { isInt4Id, usersByIds } from './users.service';

// What a set of accounts bought from the Creator Shop, and with which Buzz.
//
// The purchase row knows the item and the price; only the ledger knows which account type paid, and a
// charge can split across types. A row's `buzzTransactionId` is the charge prefix and each ledger leg
// is that prefix plus `-<AccountType>`. Sticker top-ups write no purchase row, so they come from the
// ledger alone.

const PURCHASE_ROW_LIMIT = 1000;
const LEG_ROW_LIMIT = 5000;
const LEG_READ_TIMEOUT_S = 30;
const ITEMS_SHOWN = 25;

const PACK_PREFIX = 'cosmetic-pack-v2-';
const BOX_PREFIX = 'item-purchase-v1-';
const LEG_PREFIXES = ['cosmetic-purchase-v2-', PACK_PREFIX, BOX_PREFIX, 'sticker-topup-'];

const TOP_UP_LEG = /^(sticker-topup-\d+-(\d+)-.+)-[A-Za-z]+$/;
const USER_ACCOUNT_TYPE_SET = new Set<string>(USER_ACCOUNT_TYPES);

export const SHOP_PURCHASE_KINDS = [
  'box',
  'pack',
  'Badge',
  'NamePlate',
  'ContentDecoration',
  'ProfileDecoration',
  'ProfileBackground',
  'Sticker',
] as const;
export type ShopPurchaseKindFilter = (typeof SHOP_PURCHASE_KINDS)[number];

export type PurchaseRow = {
  userId: number;
  shopItemId: number;
  title: string;
  cosmeticType: string | null;
  unitAmount: number;
  purchasedAt: Date;
  refunded: boolean;
  buzzTransactionId: string;
};

export type LegRow = {
  externalTransactionId: string;
  fromAccountId: string | number;
  toAccountId: string | number;
  fromAccountType: string;
  type: string;
  amount: string | number;
  description: string;
  /** The read reaches a day further back than the window; 1 when the leg is inside the window. */
  inWindow: number;
};

type Tally = {
  count: number;
  buzz: number;
  refunded: number;
  firstAt: Date;
  lastAt: Date;
  paidFrom: Record<string, number>;
  /** Paid rows with no ledger leg. Null when the ledger read was cut short, so a miss proves nothing. */
  noChargeFound: number | null;
};

export type ShopItemSummary = Tally & { shopItemId: number; title: string; kind: string };
export type OtherItems = Tally & { items: number };

export type StickerTopUp = {
  cosmeticId: number;
  name: string | null;
  charges: number;
  paidFrom: Record<string, number>;
  usesBought: 'not recorded';
};

export type AccountShopPurchases = {
  userId: number;
  username: string | null;
  items: ShopItemSummary[];
  other: OtherItems | null;
  topUps: StickerTopUp[];
  /** The ledger read hit its cap for this account, so paidFrom and topUps may be partial. */
  ledgerCapped: boolean;
  truncated: boolean;
};

export type ShopPurchases = { days: number; accounts: AccountShopPurchases[]; truncated: boolean };

const kindOf = (row: PurchaseRow) => {
  if (row.buzzTransactionId.startsWith(PACK_PREFIX)) return 'pack';
  if (row.buzzTransactionId.startsWith(BOX_PREFIX)) return 'box';
  return row.cosmeticType ?? 'unknown';
};

const addTo = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [type, amount] of Object.entries(from)) into[type] = (into[type] ?? 0) + amount;
};

/** The same prefix also sits on seller payouts and refunds, which are not the buyer paying. */
function buyerDebits(legs: LegRow[], ids: Set<number>) {
  return legs.filter(
    (l) =>
      ids.has(Number(l.fromAccountId)) &&
      Number(l.toAccountId) === 0 &&
      l.type === 'purchase' &&
      USER_ACCOUNT_TYPE_SET.has(l.fromAccountType)
  );
}

function summarizeItems(
  rows: PurchaseRow[],
  paidByCharge: Map<string, Record<string, number>>,
  legsCut: boolean
) {
  const byItem = new Map<number, ShopItemSummary>();
  for (const row of rows) {
    let item = byItem.get(row.shopItemId);
    if (!item) {
      item = {
        shopItemId: row.shopItemId,
        title: row.title,
        kind: kindOf(row),
        count: 0,
        buzz: 0,
        refunded: 0,
        firstAt: row.purchasedAt,
        lastAt: row.purchasedAt,
        paidFrom: {},
        noChargeFound: legsCut ? null : 0,
      };
      byItem.set(row.shopItemId, item);
    }
    item.count += 1;
    item.buzz += row.unitAmount;
    if (row.refunded) item.refunded += 1;
    if (row.purchasedAt < item.firstAt) item.firstAt = row.purchasedAt;
    if (row.purchasedAt > item.lastAt) item.lastAt = row.purchasedAt;
    const paid = paidByCharge.get(row.buzzTransactionId);
    if (paid) addTo(item.paidFrom, paid);
    // A free row was never charged, so it has no leg to find.
    else if (item.noChargeFound !== null && row.unitAmount > 0) item.noChargeFound += 1;
  }
  return [...byItem.values()].sort((a, b) => b.buzz - a.buzz || b.count - a.count);
}

function rollUpOther(rest: ShopItemSummary[]): OtherItems | null {
  if (!rest.length) return null;
  const other: OtherItems = {
    items: rest.length,
    count: 0,
    buzz: 0,
    refunded: 0,
    firstAt: rest[0].firstAt,
    lastAt: rest[0].lastAt,
    paidFrom: {},
    noChargeFound: rest[0].noChargeFound === null ? null : 0,
  };
  for (const item of rest) {
    other.count += item.count;
    other.buzz += item.buzz;
    other.refunded += item.refunded;
    if (item.firstAt < other.firstAt) other.firstAt = item.firstAt;
    if (item.lastAt > other.lastAt) other.lastAt = item.lastAt;
    addTo(other.paidFrom, item.paidFrom);
    if (other.noChargeFound !== null) other.noChargeFound += item.noChargeFound ?? 0;
  }
  return other;
}

function summarizeTopUps(legs: LegRow[]): StickerTopUp[] {
  const byCosmetic = new Map<number, StickerTopUp & { seen: Set<string> }>();
  for (const leg of legs) {
    const m = TOP_UP_LEG.exec(leg.externalTransactionId);
    if (!m || !Number(leg.inWindow)) continue;
    const cosmeticId = Number(m[2]);
    let topUp = byCosmetic.get(cosmeticId);
    if (!topUp) {
      topUp = {
        cosmeticId,
        name: leg.description.replace(/^Sticker uses - /, '') || null,
        charges: 0,
        paidFrom: {},
        usesBought: 'not recorded',
        seen: new Set(),
      };
      byCosmetic.set(cosmeticId, topUp);
    }
    topUp.seen.add(m[1]);
    topUp.charges = topUp.seen.size;
    addTo(topUp.paidFrom, { [leg.fromAccountType]: Number(leg.amount) });
  }
  return [...byCosmetic.values()]
    .map(({ seen: _seen, ...topUp }) => topUp)
    .sort((a, b) => b.charges - a.charges);
}

/** Joins purchase rows to ledger legs. */
export function summarizeShopPurchases(
  ids: number[],
  purchases: PurchaseRow[],
  legs: LegRow[],
  usernames: Map<number, { username: string | null }>,
  days: number,
  kind?: ShopPurchaseKindFilter
): ShopPurchases {
  const debits = buyerDebits(legs, new Set(ids));
  const charges = new Set(purchases.map((p) => p.buzzTransactionId));
  const paidByCharge = new Map<string, Record<string, number>>();
  for (const leg of debits) {
    const charge = leg.externalTransactionId.replace(/-[A-Za-z]+$/, '');
    if (!charges.has(charge)) continue;
    const paid = paidByCharge.get(charge) ?? {};
    addTo(paid, { [leg.fromAccountType]: Number(leg.amount) });
    paidByCharge.set(charge, paid);
  }

  const accounts = ids.map((userId) => {
    const own = purchases.filter((p) => p.userId === userId);
    const rowsCut = own.length >= PURCHASE_ROW_LIMIT;
    const legsCut = legs.filter((l) => Number(l.fromAccountId) === userId).length >= LEG_ROW_LIMIT;
    const shown = kind ? own.filter((p) => kindOf(p) === kind) : own;
    const items = summarizeItems(shown, paidByCharge, legsCut);
    const ownTopUps = debits.filter((l) => Number(l.fromAccountId) === userId);
    return {
      userId,
      username: usernames.get(userId)?.username ?? null,
      items: items.slice(0, ITEMS_SHOWN),
      other: rollUpOther(items.slice(ITEMS_SHOWN)),
      topUps: !kind || kind === 'Sticker' ? summarizeTopUps(ownTopUps) : [],
      ledgerCapped: legsCut,
      truncated: rowsCut || legsCut,
    };
  });
  return { days, accounts, truncated: accounts.some((a) => a.truncated) };
}

export async function getShopPurchaseSummary(
  userIds: number[],
  days = 30,
  kind?: ShopPurchaseKindFilter
): Promise<ShopPurchases> {
  const ids = [...new Set(userIds)].filter(isInt4Id);
  const window = Math.min(MAX_BUZZ_DAYS, Math.max(1, Math.trunc(days)));
  if (!ids.length) return { days: window, accounts: [], truncated: false };

  const purchases = dbRead
    .selectFrom((qb) =>
      qb
        .selectFrom('UserCosmeticShopPurchases as p')
        .innerJoin('CosmeticShopItem as csi', 'csi.id', 'p.shopItemId')
        .leftJoin('Cosmetic as c', 'c.id', 'p.cosmeticId')
        .select([
          'p.userId',
          'p.shopItemId',
          'csi.title',
          'c.type as cosmeticType',
          'p.unitAmount',
          'p.purchasedAt',
          'p.refunded',
          'p.buzzTransactionId',
        ])
        .select(
          sql<number>`row_number() OVER (PARTITION BY p."userId" ORDER BY p."purchasedAt" DESC)`.as(
            'recency'
          )
        )
        .where('p.userId', 'in', ids)
        .where('p.purchasedAt', '>=', sql<Date>`now() - make_interval(days => ${sql.lit(window)})`)
        .as('recent')
    )
    .selectAll()
    .where('recency', '<=', PURCHASE_ROW_LIMIT)
    .execute();

  // The charge lands just before its row is written, so a purchase on the window's edge can have its
  // leg outside the window: read a day further back or it reports a false "no charge found".
  const legs = getClickhouse()
    .query({
      query: `
        SELECT externalTransactionId, fromAccountId, toAccountId, fromAccountType, type, amount, description,
               date >= now() - toIntervalDay({days:UInt32}) AS inWindow
        FROM default.buzzTransactions
        PREWHERE fromAccountId IN {ids:Array(Int32)}
        WHERE date >= now() - toIntervalDay({readDays:UInt32})
          AND arrayExists(p -> startsWith(externalTransactionId, p), {prefixes:Array(String)})
        ORDER BY date DESC
        LIMIT {limit:UInt32} BY fromAccountId
      `,
      query_params: {
        ids,
        days: window,
        readDays: window + 1,
        prefixes: LEG_PREFIXES,
        limit: LEG_ROW_LIMIT,
      },
      format: 'JSONEachRow',
      clickhouse_settings: { max_execution_time: LEG_READ_TIMEOUT_S },
    })
    .then((r) => r.json<LegRow>());

  const [purchaseRows, legRows, usernames] = await Promise.all([purchases, legs, usersByIds(ids)]);
  return summarizeShopPurchases(ids, purchaseRows, legRows, usernames, window, kind);
}
