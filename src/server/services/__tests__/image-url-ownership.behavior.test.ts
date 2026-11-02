import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { Prisma } from '@prisma/client';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);

const { assertClientImageUrlsUsable, COVER_IMAGE_UNAVAILABLE_MESSAGE, shopArtworkUrls, uuidsIn } =
  await import('~/server/services/image-url-ownership');

describe('uuidsIn', () => {
  // The regex it replaces: a lookahead at every position, so overlapping keys are found too.
  const byRegex = (value: string) =>
    [...value.matchAll(/(?=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))/gi)].map(
      ([, key]) => key.toLowerCase()
    );

  it('finds exactly what the lookahead regex finds, overlapping keys included', () => {
    // mulberry32: seeded, so a failure reproduces.
    let seed = 7;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
    // Chains of overlapping keys with a few characters swapped: keys, near-keys and overlaps.
    const chain = 'ab12CD34-0000-4000-8000-00000000beef-0000-4000-8000-0000000000aa';
    const swaps = ['a', 'F', '0', '-', 'g', ' ', '--'];
    const mutated = () => {
      const chars = [...chain];
      for (let i = next() % 4; i > 0; i--)
        chars[next() % chars.length] = swaps[next() % swaps.length];
      return chars.join('').slice(next() % 10);
    };
    const fixed = [
      'AB12CD34-EF56-4A7B-8C9D-0E1F2A3B4C5D',
      `x00000000-0000-4000-8000-000000000000-0000-4000-8000-00000000000a`,
      'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5', // one short
      'ab12cd3-ef56-4a7b-8c9d-0e1f2a3b4c5d',
    ];
    const samples = [...fixed, ...Array.from({ length: 5000 }, mutated)];
    let found = 0;
    for (const value of samples) {
      expect(uuidsIn(value)).toEqual(byRegex(value));
      found += byRegex(value).length;
    }
    // The samples reach keys at all, overlapping ones included.
    expect(found).toBeGreaterThan(100);
    expect(uuidsIn(fixed[1])).toHaveLength(2);
  });
});

const CALLER = 7;
const OTHER = 8;
const OWN_KEY = '0a0b0c0d-0000-4000-8000-00000000000a';
const OTHERS_LIVE_KEY = '0a0b0c0d-0000-4000-8000-00000000000b';
const OTHERS_PENDING_KEY = '0a0b0c0d-0000-4000-8000-00000000000c';
const FRESH_KEY = '0a0b0c0d-0000-4000-8000-00000000000d';

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      "id" serial PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL,
      "ingestion" text NOT NULL DEFAULT 'Scanned'
    );
    CREATE TABLE "Cosmetic" ("id" integer PRIMARY KEY, "data" jsonb NOT NULL);
    CREATE TABLE "CosmeticShopItem" (
      "id" integer PRIMARY KEY, "cosmeticId" integer, "meta" jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "ItemDefinition" ("id" integer PRIMARY KEY, "imageUrl" text);
    CREATE TABLE "ImageCdnShopTakedown" (url text, "shopItemId" integer, PRIMARY KEY (url, "shopItemId"));
  `);
});

beforeEach(async () => {
  await holder.db.exec(
    `TRUNCATE "Image", "Cosmetic", "CosmeticShopItem", "ItemDefinition", "ImageCdnShopTakedown"`
  );
  await holder.db.exec(`
    INSERT INTO "Image" ("userId", url, ingestion) VALUES
      (${CALLER}, '${OWN_KEY}', 'Scanned'),
      (${OTHER}, '${OTHERS_LIVE_KEY}', 'Scanned'),
      (${OTHER}, '${OTHERS_PENDING_KEY}', 'Pending');
  `);
});

const refused = (urls: (string | null)[]) =>
  assertClientImageUrlsUsable({ urls, userId: CALLER }).then(
    () => null,
    (e: unknown) => e
  );

describe('assertClientImageUrlsUsable', () => {
  it('accepts a key no row has and a key the caller owns', async () => {
    expect(await refused([FRESH_KEY])).toBeNull();
    expect(await refused([OWN_KEY])).toBeNull();
  });

  it("refuses a key owned by another user, whatever that row's state", async () => {
    for (const key of [OTHERS_LIVE_KEY, OTHERS_PENDING_KEY]) {
      const error = await refused([key]);
      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        message: COVER_IMAGE_UNAVAILABLE_MESSAGE,
      });
    }
  });

  it("refuses a batch when any one key is another user's", async () => {
    expect(await refused([FRESH_KEY, OWN_KEY, OTHERS_LIVE_KEY])).toBeInstanceOf(TRPCError);
    expect(await refused([FRESH_KEY, OWN_KEY, null])).toBeNull();
  });

  it("refuses another user's key written in uppercase", async () => {
    expect(await refused([OTHERS_LIVE_KEY.toUpperCase()])).toBeInstanceOf(TRPCError);
    expect(await refused([OWN_KEY.toUpperCase()])).toBeNull();
  });

  it('checks the key a first-party full url names', async () => {
    const full = (key: string) =>
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/${key}.jpeg`;

    expect(await refused([full(OTHERS_LIVE_KEY)])).toBeInstanceOf(TRPCError);
    expect(await refused([full(OTHERS_LIVE_KEY.toUpperCase())])).toBeInstanceOf(TRPCError);
    expect(await refused([full(OWN_KEY)])).toBeNull();
    expect(await refused([full(FRESH_KEY)])).toBeNull();
  });

  it("refuses another user's url stored in full or uppercase, given the same way", async () => {
    const stored = [
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${FRESH_KEY}/width=450/${FRESH_KEY}.jpeg`,
      FRESH_KEY.toUpperCase(),
    ];
    for (const url of stored) {
      await holder.db.exec(`TRUNCATE "Image"`);
      await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${url}')`);

      expect(await refused([url])).toBeInstanceOf(TRPCError);
    }
  });

  it('checks every key a url carries, however it is spelled', async () => {
    const key = OTHERS_LIVE_KEY;
    const encoded = key.replace('-', '%2D');
    const spellings = [
      `\t${key}`,
      `${key.slice(0, 10)}\n${key.slice(10)}`,
      `${key.slice(0, 10)}\r${key.slice(10)}`,
      `x/../${key}`,
      `./${key}`,
      `${key}#x`,
      `${key}?x=1`,
      ` ${key} `,
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${encoded}/original=true/a.jpeg`,
      `https://image.civitai.com./xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/a.jpeg`,
      `https://example.invalid/${key}.png`,
      `https://example.invalid/${FRESH_KEY}/${key}.png`,
    ];
    for (const url of spellings) expect(await refused([url]), url).toBeInstanceOf(TRPCError);

    expect(await refused([`x/../${OWN_KEY}`, `\t${FRESH_KEY}`])).toBeNull();
  });

  it('refuses a url carrying more keys than any image url does', async () => {
    const many = Array.from(
      { length: 70 },
      (_, i) => `0a0b0c0d-0000-4000-8000-${String(i).padStart(12, '0')}`
    ).join('/');

    expect(await refused([many])).toBeInstanceOf(TRPCError);
    expect(await refused([`${FRESH_KEY}/${OWN_KEY}`])).toBeNull();
  });

  it('leaves a full external url alone', async () => {
    await holder.db.exec(
      `INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, 'https://example.invalid/a.png')`
    );

    expect(await refused(['https://example.invalid/a.png'])).toBeNull();
  });
});

describe('assertClientImageUrlsUsable and shop artwork', () => {
  const SHOP_KEY = FRESH_KEY;
  const holders = [
    [
      'cosmetic artwork',
      `INSERT INTO "Cosmetic" (id, data) VALUES (1, '{"url":"${SHOP_KEY}"}');
       INSERT INTO "CosmeticShopItem" (id, "cosmeticId") VALUES (9, 1);`,
      { cosmeticId: 1 },
    ],
    [
      'a pack cover',
      `INSERT INTO "CosmeticShopItem" (id, meta) VALUES (1, '{"coverUrl":"${SHOP_KEY}"}')`,
      { shopItemId: 1 },
    ],
    [
      'a box image',
      `INSERT INTO "ItemDefinition" (id, "imageUrl") VALUES (1, '${SHOP_KEY}')`,
      { itemDefinitionId: 1 },
    ],
  ] as const;

  it.each(holders)('refuses a key %s uses, however the url spells it', async (_holder, insert) => {
    await holder.db.exec(insert);

    expect(await refused([SHOP_KEY])).toBeInstanceOf(TRPCError);
    expect(await refused([SHOP_KEY.toUpperCase()])).toBeInstanceOf(TRPCError);
    expect(
      await refused([
        `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${SHOP_KEY}/original=true/a.jpeg`,
      ])
    ).toBeInstanceOf(TRPCError);
  });

  it.each(holders)('lets the row %s belongs to keep its own key', async (_holder, insert, own) => {
    await holder.db.exec(insert);

    const result = await assertClientImageUrlsUsable({
      urls: [SHOP_KEY],
      userId: CALLER,
      shopRow: own,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(result).toBeNull();
  });

  it('checks image rows only for urls an article already stores (shopArtwork: false)', async () => {
    await holder.db.exec(`INSERT INTO "ItemDefinition" (id, "imageUrl") VALUES (1, '${SHOP_KEY}')`);
    const stored = (url: string) =>
      assertClientImageUrlsUsable({ urls: [url], userId: CALLER, shopArtwork: false }).then(
        () => null,
        (e: unknown) => e
      );

    expect(await stored(SHOP_KEY)).toBeNull();
    expect(await stored(OTHERS_LIVE_KEY)).toBeInstanceOf(TRPCError);
  });

  it('refuses to run a shop artwork write without the shop artwork check', async () => {
    await expect(
      assertClientImageUrlsUsable({
        urls: [SHOP_KEY],
        userId: CALLER,
        shopRow: {},
        shopArtwork: false,
      })
    ).rejects.toThrow(/needs the shop artwork check/);
  });

  it('ignores a cosmetic the shop does not sell', async () => {
    await holder.db.exec(`INSERT INTO "Cosmetic" (id, data) VALUES (1, '{"url":"${SHOP_KEY}"}')`);

    expect(await refused([SHOP_KEY])).toBeNull();
    expect(await shopArtworkUrls([SHOP_KEY])).toEqual(new Set());
  });

  it('refuses a key another shop row uses, even while editing one', async () => {
    await holder.db.exec(`
      INSERT INTO "Cosmetic" (id, data) VALUES (2, '{"url":"${SHOP_KEY}"}');
      INSERT INTO "CosmeticShopItem" (id, "cosmeticId") VALUES (9, 2);
    `);

    const result = await assertClientImageUrlsUsable({
      urls: [SHOP_KEY],
      userId: CALLER,
      shopRow: { cosmeticId: 1, shopItemId: 2, itemDefinitionId: 2 },
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(result).toBeInstanceOf(TRPCError);
  });

  const shop = (url: string) =>
    assertClientImageUrlsUsable({ urls: [url], userId: CALLER, shopRow: {} }).then(
      () => null,
      (e: unknown) => e
    );

  it("refuses shop artwork on any image's key, the caller's own included", async () => {
    expect(await shop(OWN_KEY)).toBeInstanceOf(TRPCError);
    expect(await shop(OTHERS_LIVE_KEY)).toBeInstanceOf(TRPCError);
    expect(await shop(SHOP_KEY)).toBeNull();
  });

  it.each([
    SHOP_KEY.toUpperCase(),
    `/${SHOP_KEY}`,
    `${SHOP_KEY}?v=1`,
    `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${SHOP_KEY}/original=true/a.jpeg`,
  ])('refuses shop artwork given as %s rather than the bare key', async (url) => {
    expect(await shop(url)).toBeInstanceOf(TRPCError);
  });

  it.each([
    `/${SHOP_KEY}?v=1`,
    SHOP_KEY.toUpperCase(),
    `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${SHOP_KEY}/original=true/a.jpeg`,
    SHOP_KEY.replace('-', '%2D'),
  ])('matches a shop row that stored the key as %s', async (stored) => {
    await holder.db.query(`INSERT INTO "ItemDefinition" (id, "imageUrl") VALUES (1, $1)`, [stored]);

    expect(await refused([SHOP_KEY])).toBeInstanceOf(TRPCError);
    expect(await shopArtworkUrls([SHOP_KEY, OWN_KEY])).toEqual(new Set([SHOP_KEY]));
  });

  it("refuses an image on a taken-down listing's art after the listing is gone", async () => {
    await holder.db.query(`INSERT INTO "ImageCdnShopTakedown" (url, "shopItemId") VALUES ($1, 1)`, [
      SHOP_KEY,
    ]);
    expect(await refused([SHOP_KEY])).toBeInstanceOf(TRPCError);
    expect(await refused([OWN_KEY])).toBeNull();
  });

  it("counts a taken-down listing's art after the listing is gone", async () => {
    await holder.db.query(`INSERT INTO "ImageCdnShopTakedown" (url, "shopItemId") VALUES ($1, 1)`, [
      SHOP_KEY,
    ]);
    expect(await shopArtworkUrls([SHOP_KEY, OWN_KEY])).toEqual(new Set([SHOP_KEY]));
  });

  it('looks each shop column up through its migration index', async () => {
    const migration = readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20261211120000_shop_artwork_key_indexes/migration.sql'
      ),
      'utf8'
    );
    await holder.db.exec(migration.replaceAll('CONCURRENTLY ', ''));
    const probes: { text: string; values: unknown[] }[] = [];
    dbMock.dbWrite.$queryRaw.mockImplementationOnce(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...values);
      probes.push({ text: sql.text, values: sql.values });
      return Promise.resolve([]);
    }) as never);
    await refused([SHOP_KEY]);

    await holder.db.exec(`SET enable_seqscan = off`);
    try {
      const { rows } = await holder.db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${probes[0].text}`,
        probes[0].values
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      for (const index of [
        'Cosmetic_data_url_key_idx',
        'CosmeticShopItem_meta_coverUrl_key_idx',
        'ItemDefinition_imageUrl_key_idx',
      ])
        expect(plan).toContain(index);
    } finally {
      await holder.db.exec(`RESET enable_seqscan`);
    }
  });
});
