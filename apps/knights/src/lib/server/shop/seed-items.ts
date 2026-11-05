/** Dev catalog. Prices live in `KnightsShopItem`, so changing one is an UPDATE, not a deploy; the seed never overwrites an existing row. */
export type SeedItem = {
  kind: 'buzz_pack' | 'cosmetic' | 'membership';
  name: string;
  description?: string;
  price: number;
  buzz?: number;
  cosmeticId?: number;
  /** With `name`, how `seedSql` finds the cosmetic in whichever database it runs against: ids differ between environments. */
  cosmeticType?: string;
  tier?: 'bronze' | 'silver' | 'gold';
  months?: number;
  minRank?: string;
  rotating?: boolean;
  sortOrder: number;
};

const BUZZ_PACKS: [number, number][] = [
  [50, 1_000],
  [130, 2_500],
  [275, 5_000],
  [600, 10_000],
];

const MEMBERSHIPS: ['bronze' | 'silver' | 'gold', number][] = [
  ['bronze', 24_000],
  ['silver', 48_000],
  ['gold', 96_000],
];

export const FIXED_ITEMS: SeedItem[] = [
  ...BUZZ_PACKS.map(
    ([buzz, price], i): SeedItem => ({
      kind: 'buzz_pack',
      name: `${buzz} Buzz`,
      price,
      buzz,
      sortOrder: 10 + i,
    })
  ),
  ...MEMBERSHIPS.map(
    ([tier, price], i): SeedItem => ({
      kind: 'membership',
      name: `${tier[0].toUpperCase()}${tier.slice(1)} membership`,
      price,
      tier,
      months: 1,
      sortOrder: 20 + i,
    })
  ),
];

export type CosmeticRow = { id: number; name: string; type: string };

export function cosmeticItems(rows: CosmeticRow[]): SeedItem[] {
  const of = (type: string) => rows.filter((row) => row.type === type);
  const make = (
    row: CosmeticRow,
    price: number,
    sortOrder: number,
    minRank?: string
  ): SeedItem => ({
    kind: 'cosmetic',
    name: row.name,
    price,
    cosmeticId: row.id,
    cosmeticType: row.type,
    minRank,
    rotating: true,
    sortOrder,
  });
  return [
    ...of('Badge').map((row, i) => make(row, 1_000 + i * 1_000, 30 + i)),
    ...of('NamePlate').map((row, i) => make(row, 5_000, 40 + i)),
    ...of('ProfileDecoration').map((row, i) =>
      make(row, i === 0 ? 10_000 : 20_000, 50 + i, i === 0 ? 'Templar' : 'Paladin')
    ),
    ...of('Sticker').map((row, i) => make(row, 400, 60 + i)),
  ];
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const lit = (value: string | number | undefined) =>
  value === undefined
    ? 'NULL'
    : typeof value === 'number'
    ? String(Math.trunc(value))
    : quote(value);

const COLUMNS = `"kind","name","description","price","buzz","cosmeticId","tier","months","minRank","rotating","sortOrder"`;

/** What makes two rows the same item. Within a kind the database allows duplicates, so the seed has to ask. */
function identity(item: SeedItem, cosmeticRef: string | null): string {
  const kind = `"kind" = ${quote(item.kind)}`;
  if (item.kind === 'buzz_pack') return `${kind} AND "buzz" = ${lit(item.buzz)}`;
  if (item.kind === 'membership')
    return `${kind} AND "tier" = ${lit(item.tier)} AND "months" = ${lit(item.months)}`;
  return `${kind} AND "cosmeticId" = ${cosmeticRef ?? lit(item.cosmeticId)}`;
}

/**
 * Inserts only the items the catalog does not already have (a buzz pack by its Buzz, a membership by tier and months,
 * a cosmetic by its cosmetic), so a price someone edited survives a re-seed. A cosmetic item names its cosmetic and is
 * inserted from the `Cosmetic` row of that name and type in the target database, so the SQL is the same anywhere;
 * where no such cosmetic exists the item is skipped.
 */
export function seedSql(items: SeedItem[]): string {
  const values = (item: SeedItem, cosmeticRef: string | null) =>
    [
      quote(item.kind),
      quote(item.name),
      quote(item.description ?? ''),
      lit(item.price),
      lit(item.buzz),
      cosmeticRef ?? lit(item.cosmeticId),
      lit(item.tier),
      lit(item.months),
      lit(item.minRank),
      item.rotating ? 'true' : 'false',
      lit(item.sortOrder),
    ].join(', ');
  return items
    .map((item) => {
      if (!item.cosmeticType) {
        return `INSERT INTO "KnightsShopItem" (${COLUMNS})
SELECT ${values(item, null)}
WHERE NOT EXISTS (SELECT 1 FROM "KnightsShopItem" WHERE ${identity(item, null)});`;
      }
      return `INSERT INTO "KnightsShopItem" (${COLUMNS})
SELECT ${values(item, 'c."id"')}
FROM (SELECT "id" FROM "Cosmetic" WHERE "name" = ${quote(item.name)} AND "type" = ${quote(
        item.cosmeticType
      )} AND "source" = 'Purchase' ORDER BY "id" DESC LIMIT 1) c
WHERE NOT EXISTS (SELECT 1 FROM "KnightsShopItem" WHERE ${identity(item, 'c."id"')});`;
    })
    .join('\n');
}

export function pickCosmetics(rows: CosmeticRow[]): CosmeticRow[] {
  const take = (type: string, n: number) => rows.filter((row) => row.type === type).slice(0, n);
  return [
    ...take('Badge', 2),
    ...take('NamePlate', 1),
    ...take('ProfileDecoration', 2),
    ...take('Sticker', 2),
  ];
}
