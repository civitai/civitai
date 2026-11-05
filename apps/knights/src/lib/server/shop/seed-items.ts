/**
 * The placeholder catalog for dev. Prices are placeholders until the price sheet is signed off; they live in
 * `KnightsShopItem`, so changing one is an UPDATE, not a deploy. The seed never overwrites a row that exists.
 */
export type SeedItem = {
  id: string;
  kind: 'buzz_pack' | 'cosmetic' | 'membership';
  name: string;
  description?: string;
  price: number;
  buzz?: number;
  cosmeticId?: number;
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
      id: `buzz-${buzz}`,
      kind: 'buzz_pack',
      name: `${buzz} Buzz`,
      price,
      buzz,
      sortOrder: 10 + i,
    })
  ),
  ...MEMBERSHIPS.map(
    ([tier, price], i): SeedItem => ({
      id: `membership-${tier}-1m`,
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

/** Rotating cosmetics from rows that already exist in the database: badges, a nameplate, decorations (rank-gated) and stickers. */
export function cosmeticItems(rows: CosmeticRow[]): SeedItem[] {
  const of = (type: string) => rows.filter((row) => row.type === type);
  const make = (
    row: CosmeticRow,
    price: number,
    sortOrder: number,
    minRank?: string
  ): SeedItem => ({
    id: `cosmetic-${row.id}`,
    kind: 'cosmetic',
    name: row.name,
    price,
    cosmeticId: row.id,
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

/** One idempotent INSERT: an existing id (a price someone edited) is left alone. */
export function seedSql(items: SeedItem[]): string {
  if (items.length === 0) return '';
  const rows = items.map(
    (item) =>
      `(${[
        quote(item.id),
        quote(item.kind),
        quote(item.name),
        quote(item.description ?? ''),
        lit(item.price),
        lit(item.buzz),
        lit(item.cosmeticId),
        lit(item.tier),
        lit(item.months),
        lit(item.minRank),
        item.rotating ? 'true' : 'false',
        lit(item.sortOrder),
      ].join(', ')})`
  );
  return `INSERT INTO "KnightsShopItem" ("id","kind","name","description","price","buzz","cosmeticId","tier","months","minRank","rotating","sortOrder") VALUES\n${rows.join(
    ',\n'
  )}\nON CONFLICT ("id") DO NOTHING;`;
}

/** Picks a few of each cosmetic type so the dev shop has something to rotate. */
export function pickCosmetics(rows: CosmeticRow[]): CosmeticRow[] {
  const take = (type: string, n: number) => rows.filter((row) => row.type === type).slice(0, n);
  return [
    ...take('Badge', 2),
    ...take('NamePlate', 1),
    ...take('ProfileDecoration', 2),
    ...take('Sticker', 2),
  ];
}
