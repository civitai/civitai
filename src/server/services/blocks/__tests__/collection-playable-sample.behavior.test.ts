import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a
// contended runner. Relaxing it can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What `getCollectionPlayableSample` actually reads, against REAL ROWS.
 *
 * 🔴 WHY THIS IS EXECUTED AND NOT STRING-ASSERTED. Every defect this file exists
 * to catch is a query that still parses and still returns plausible numbers:
 *
 *   - `JOIN "Image"` instead of `LEFT JOIN` scores every model / post / article
 *     item as unplayable and empties those collections out of discovery.
 *   - A bare `LIMIT` with no `ORDER BY` samples PHYSICAL row order — which is
 *     neither stable nor reviewable, and which flips a real collection's verdict
 *     (measured: 1 disagreement in 84, worst-case gap 0.800 between the two ends
 *     of the same collection).
 *   - `ORDER BY ci."id" ASC` samples the OLDEST items, the exact opposite window.
 *   - One shared `LIMIT` instead of a per-collection LATERAL samples the first
 *     collection and starves the rest.
 *
 * A text assertion passes on all four. Only running the statement on rows shaped
 * like the live ones can tell them apart, so that is what this does: the
 * service's own SQL, unmodified, on an in-process Postgres.
 */

// `beforeAll` builds the instance, so everything below reaches it through this
// holder rather than capturing a value that does not exist yet.
const holder = { db: null as unknown as PGlite };

/**
 * Run the service's tagged-template statement on PGlite.
 *
 * 🔴 THE FLATTEN IS LOAD-BEARING. The statement interpolates a NESTED
 * `Prisma.sql` fragment (the cast id list), so the naive `$${i + 1}` stitch used
 * by sibling harnesses would substitute a single bind parameter where a whole
 * comma-separated list belongs and produce a syntactically valid statement that
 * tests nothing. `Prisma.sql(strings, ...values)` performs exactly the flattening
 * Prisma itself does before sending, and `.text` / `.values` are the statement and
 * binds the database would have received.
 */
dbMock.dbRead.$queryRaw.mockImplementation(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return holder.db.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  }
);

const { getCollectionPlayableSample, PLAYABLE_SAMPLE_SIZE } = await import(
  '~/server/services/blocks/block-collections.service'
);

// nsfwLevel buckets, as the app's Flags enum lays them out.
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
/** A SFW-domain ceiling: PG | PG13. */
const SFW_CEILING = PG | PG13;

/** Image ids with a fixed maturity, reused by every fixture below. */
const IMG_PG = 1;
const IMG_PG13 = 2;
const IMG_R = 3;
const IMG_X = 4;
const IMG_UNRATED = 5;

// One collection per property, so a bug that only affects one shape cannot hide
// behind another's totals.
const MIXED = 7001; // images at several maturities + one of every non-image shape
const IMAGES_ONLY = 7002;
const MODELS_ONLY = 7003; // 🔴 the inner-join canary
const ARTICLES_ONLY = 7004;
const POSTS_ONLY = 7005;
const EMPTY = 7006; // no countable accepted items at all
const ORPHAN_IMAGE = 7007; // an item pointing at an Image row that no longer exists
const BIG_A = 7008; // >cap, used with BIG_B to prove the LIMIT is per-collection
const BIG_B = 7009;

/**
 * 🔴 THE TWO ORDER FIXTURES. Both hold {@link ORDER_TOTAL} items — deliberately
 * MORE than `PLAYABLE_SAMPLE_SIZE`, and not a multiple of it, so the sample window
 * lands strictly inside the collection and the two ends genuinely disagree.
 *
 * `ORDER_NEWEST_SAFE` changes the COUNT: newest-200 is fully playable (200),
 * oldest-200 is not (140).
 *
 * `ORDER_NEWEST_MATURE` changes the VERDICT, which is the measured 1-in-84 case
 * turned into a guard: newest-200 is 10% playable (below the 20% floor → dropped),
 * oldest-200 is 30% (above it → kept). A sample that reads the wrong end does not
 * merely report a different number here, it surfaces a collection the floor exists
 * to remove.
 */
const ORDER_NEWEST_SAFE = 7010;
const ORDER_NEWEST_MATURE = 7011;
/** Comfortably over the cap, and not a multiple of it. */
const ORDER_TOTAL = 260;
const ORDER_OLD_TAIL = ORDER_TOTAL - PLAYABLE_SAMPLE_SIZE; // 60 items older than the window

/** Item-id allocator: ids ascend with insertion, exactly as the real serial does. */
let nextItemId = 100_000;
const rowsSql: string[] = [];
function item(collectionId: number, cols: Partial<Record<string, number | string>> = {}) {
  const id = nextItemId++;
  const v = (k: string) => (cols[k] == null ? 'NULL' : String(cols[k]));
  rowsSql.push(
    `(${id}, ${collectionId}, ${v('imageId')}, ${v('modelId')}, ${v('postId')}, ${v(
      'articleId'
    )}, '${cols.status ?? 'ACCEPTED'}')`
  );
}

// ---- MIXED: 2 permitted images, 1 unrated, 2 over-ceiling, one of each non-image
item(MIXED, { imageId: IMG_PG });
item(MIXED, { imageId: IMG_PG13 });
item(MIXED, { imageId: IMG_UNRATED });
item(MIXED, { imageId: IMG_R });
item(MIXED, { imageId: IMG_X });
item(MIXED, { modelId: 900 });
item(MIXED, { postId: 901 });
item(MIXED, { articleId: 902 });
// A REJECTED row that the ceiling WOULD permit: proves the status filter still
// applies inside the lateral rather than being replaced by the maturity test.
item(MIXED, { imageId: IMG_PG, status: 'REJECTED' });

// ---- IMAGES_ONLY: 1 permitted, 1 over the ceiling
item(IMAGES_ONLY, { imageId: IMG_PG });
item(IMAGES_ONLY, { imageId: IMG_X });

// ---- non-image collections: no image rows anywhere
for (let i = 0; i < 3; i++) item(MODELS_ONLY, { modelId: 910 + i });
for (let i = 0; i < 2; i++) item(ARTICLES_ONLY, { articleId: 920 + i });
item(POSTS_ONLY, { postId: 930 });

// ---- EMPTY: an item with NO subject at all — the row filter drops it, so this
// collection produces no lateral row and must be ABSENT from the map.
item(EMPTY, {});

// ---- ORPHAN_IMAGE: imageId 99999 has no "Image" row.
item(ORPHAN_IMAGE, { imageId: 99999 });
item(ORPHAN_IMAGE, { imageId: IMG_PG });

// ---- BIG_A / BIG_B: 6 permitted items each, sampled at 3 in the same call.
for (let i = 0; i < 6; i++) item(BIG_A, { imageId: IMG_PG });
for (let i = 0; i < 6; i++) item(BIG_B, { imageId: IMG_PG });

// ---- ORDER_NEWEST_SAFE: 60 mature, THEN 200 safe (so the newest 200 are safe).
for (let i = 0; i < ORDER_OLD_TAIL; i++) item(ORDER_NEWEST_SAFE, { imageId: IMG_X });
for (let i = 0; i < PLAYABLE_SAMPLE_SIZE; i++) item(ORDER_NEWEST_SAFE, { imageId: IMG_PG });

// ---- ORDER_NEWEST_MATURE: 60 safe, THEN 180 mature, THEN 20 safe.
// newest-200 → 20 safe (10%); oldest-200 → 60 safe (30%).
const NEWEST_SAFE_TAIL = 20;
for (let i = 0; i < ORDER_OLD_TAIL; i++) item(ORDER_NEWEST_MATURE, { imageId: IMG_PG });
for (let i = 0; i < PLAYABLE_SAMPLE_SIZE - NEWEST_SAFE_TAIL; i++)
  item(ORDER_NEWEST_MATURE, { imageId: IMG_X });
for (let i = 0; i < NEWEST_SAFE_TAIL; i++) item(ORDER_NEWEST_MATURE, { imageId: IMG_PG });

beforeAll(async () => {
  holder.db = new PGlite();
  // The real `status` column is the `CollectionItemStatus` enum, not text. A text
  // stand-in accepts casts Postgres rejects on the enum, so the statement's
  // `::"CollectionItemStatus"` would prove nothing against it.
  await holder.db.exec(`
    CREATE TYPE "CollectionItemStatus" AS ENUM (${Object.values(CollectionItemStatus)
      .map((s) => `'${s}'`)
      .join(', ')});
    CREATE TABLE "Image" (
      "id"        integer PRIMARY KEY,
      "nsfwLevel" integer NOT NULL DEFAULT 0
    );
    CREATE TABLE "CollectionItem" (
      "id"           integer PRIMARY KEY,
      "collectionId" integer NOT NULL,
      "imageId"      integer,
      "modelId"      integer,
      "postId"       integer,
      "articleId"    integer,
      "status"       "CollectionItemStatus" NOT NULL DEFAULT 'ACCEPTED'
    );
    INSERT INTO "Image" ("id", "nsfwLevel") VALUES
      (${IMG_PG}, ${PG}), (${IMG_PG13}, ${PG13}), (${IMG_R}, ${R}),
      (${IMG_X}, ${X}), (${IMG_UNRATED}, 0);
    INSERT INTO "CollectionItem"
      ("id","collectionId","imageId","modelId","postId","articleId","status")
    VALUES ${rowsSql.join(',\n')};
  `);
});

const ALL = [
  MIXED,
  IMAGES_ONLY,
  MODELS_ONLY,
  ARTICLES_ONLY,
  POSTS_ONLY,
  EMPTY,
  ORPHAN_IMAGE,
  BIG_A,
  BIG_B,
];

describe('getCollectionPlayableSample — what it counts', () => {
  it('🔴 keeps NON-IMAGE items unconditionally (the LEFT JOIN guarantee)', async () => {
    // THE regression this file exists for. `nsfwLevel` lives on "Image"; an inner
    // join drops these rows entirely — the collections do not merely score lower,
    // they score `sampled: 0` and vanish from the map, which the endpoint reads as
    // "nothing to judge" and the floor then silently stops filtering.
    const map = await getCollectionPlayableSample(ALL, SFW_CEILING, 10);
    expect(map.get(MODELS_ONLY)).toEqual({ sampled: 3, playable: 3 });
    expect(map.get(ARTICLES_ONLY)).toEqual({ sampled: 2, playable: 2 });
    expect(map.get(POSTS_ONLY)).toEqual({ sampled: 1, playable: 1 });
  });

  it('🔴 a MIXED collection keeps permitted images AND every non-image row, and scores only the over-ceiling images as unplayable', async () => {
    const map = await getCollectionPlayableSample([MIXED], SFW_CEILING, 10);
    // 8 countable ACCEPTED items (the REJECTED one is filtered out inside the
    // lateral), of which PG + PG13 + unrated + model + post + article = 6 are
    // playable. 6 is distinct from 8 (no clamp at all) and from 3 (an image-only
    // clamp that dropped the non-image rows), so neither mistake produces it.
    expect(map.get(MIXED)).toEqual({ sampled: 8, playable: 6 });
  });

  it('the maturity test is the BITWISE intersection, not a threshold', async () => {
    const sfw = await getCollectionPlayableSample([IMAGES_ONLY], SFW_CEILING, 10);
    expect(sfw.get(IMAGES_ONLY)).toEqual({ sampled: 2, playable: 1 });

    // A ceiling of exactly R admits the R image and REFUSES the PG one — which a
    // `nsfwLevel <= browsingLevel` comparison could never produce (PG=1 <= R=4).
    const atR = await getCollectionPlayableSample([MIXED], R, 10);
    // The R image + the unrated one + the three non-image rows = 5 playable; PG,
    // PG13 and X are all excluded.
    expect(atR.get(MIXED)).toEqual({ sampled: 8, playable: 5 });
  });

  it('🔴 a ceiling of 0 clamps to unrated-only — it is not read as "no clamp"', async () => {
    const map = await getCollectionPlayableSample([MIXED], 0, 10);
    // Only the unrated image + the three non-image rows survive.
    expect(map.get(MIXED)).toEqual({ sampled: 8, playable: 4 });
  });

  it('an item whose Image row is gone is SAMPLED but NOT playable (fail closed)', async () => {
    const map = await getCollectionPlayableSample([ORPHAN_IMAGE], SFW_CEILING, 10);
    // An image we cannot rate is one we cannot promise is playable — and
    // `getFallbackCoverImages` drops the same row.
    expect(map.get(ORPHAN_IMAGE)).toEqual({ sampled: 2, playable: 1 });
  });

  it('a collection with nothing countable is ABSENT from the map (no phantom zero row)', async () => {
    const map = await getCollectionPlayableSample([EMPTY], SFW_CEILING, 10);
    // The endpoint reads an absent id as "nothing to judge, keep" — a phantom
    // `{sampled: 0}` row would read the same, but a phantom `{sampled: 1,
    // playable: 0}` would drop an empty collection for a mismatch it cannot have.
    expect(map.has(EMPTY)).toBe(false);
    expect(map.size).toBe(0);
  });

  it('an empty id list short-circuits without touching the database', async () => {
    dbMock.dbRead.$queryRaw.mockClear();
    expect(await getCollectionPlayableSample([], SFW_CEILING)).toEqual(new Map());
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('a ceiling that permits everything makes playable equal sampled (positive control)', async () => {
    // If the playable expression were wired to nothing — or to a predicate that
    // can only ever exclude — it could not reach these totals.
    const everything = PG | PG13 | R | X;
    const map = await getCollectionPlayableSample(ALL, everything, 10);
    for (const id of [MIXED, IMAGES_ONLY, MODELS_ONLY, ORPHAN_IMAGE]) {
      const s = map.get(id);
      expect(s).toBeTruthy();
      // ORPHAN_IMAGE is the one exception and it is the fail-closed rule, not a
      // ceiling effect: no "Image" row means no maturity to permit.
      if (id === ORPHAN_IMAGE) expect(s).toEqual({ sampled: 2, playable: 1 });
      else expect(s!.playable).toBe(s!.sampled);
    }
  });
});

describe('getCollectionPlayableSample — the BOUND', () => {
  it('🔴 the cap is PER COLLECTION, not one LIMIT shared across the batch', async () => {
    // Both collections hold 6 items and both are asked for 3 in ONE call. A single
    // ordered query with one `LIMIT 3` returns 3 rows TOTAL — one collection gets
    // 3 and the other gets 0 (or they split) — which reads as a real, dramatic
    // maturity difference between two identical collections.
    const map = await getCollectionPlayableSample([BIG_A, BIG_B], SFW_CEILING, 3);
    expect(map.get(BIG_A)).toEqual({ sampled: 3, playable: 3 });
    expect(map.get(BIG_B)).toEqual({ sampled: 3, playable: 3 });
  });

  it('a collection smaller than the cap is sampled whole (the cap is a ceiling, not a quota)', async () => {
    const map = await getCollectionPlayableSample([POSTS_ONLY], SFW_CEILING, 50);
    expect(map.get(POSTS_ONLY)).toEqual({ sampled: 1, playable: 1 });
  });

  it('🔴 the DEFAULT sample size is PLAYABLE_SAMPLE_SIZE, applied without being asked for', async () => {
    // Called with no third argument, over a collection of 260 items.
    const map = await getCollectionPlayableSample([ORDER_NEWEST_SAFE], SFW_CEILING);
    expect(map.get(ORDER_NEWEST_SAFE)!.sampled).toBe(PLAYABLE_SAMPLE_SIZE);
    // …and emphatically not the whole collection, which is what dropping the LIMIT
    // would produce.
    expect(map.get(ORDER_NEWEST_SAFE)!.sampled).not.toBe(ORDER_TOTAL);
  });

  it('🔴 PLAYABLE_SAMPLE_SIZE is 200 — the measured point, pinned absolutely', async () => {
    // Every other assertion in this file derives its fixtures from the constant, so
    // all of them would follow it anywhere. This one does not: 200 is the value
    // measured to cost ~257 ms and to agree with the exact clamped count on the
    // floor for 97 of 97 live collections, against ~354 ms for 500 (no measurable
    // accuracy gain, wider worst case) and ~2.6 s for the exact count. Moving it is
    // a cost/accuracy decision that must be re-measured, not a refactor.
    expect(PLAYABLE_SAMPLE_SIZE).toBe(200);
  });
});

describe('getCollectionPlayableSample — the ORDER (🔴 the finding that shapes this design)', () => {
  it('🔴 samples the NEWEST items — an unordered LIMIT or an ASC order reads the wrong end', async () => {
    // 260 items: the oldest 60 are mature, the newest 200 are safe.
    //   ORDER BY id DESC (correct) → 200 sampled, 200 playable
    //   ORDER BY id ASC            → 200 sampled, 140 playable
    //   no ORDER BY                → physical (= insertion = oldest-first) order,
    //                                so also 140 here
    const map = await getCollectionPlayableSample([ORDER_NEWEST_SAFE], SFW_CEILING);
    expect(map.get(ORDER_NEWEST_SAFE)).toEqual({
      sampled: PLAYABLE_SAMPLE_SIZE,
      playable: PLAYABLE_SAMPLE_SIZE,
    });
    // Named explicitly so the failure message says WHICH end was read.
    expect(map.get(ORDER_NEWEST_SAFE)!.playable).not.toBe(PLAYABLE_SAMPLE_SIZE - ORDER_OLD_TAIL);
  });

  it('🔴 reading the wrong end FLIPS THE FLOOR VERDICT, not just the number', async () => {
    // The measured 1-in-84 disagreement, reproduced. 260 items: the oldest 60 are
    // safe, then 180 mature, then the newest 20 safe.
    //   newest-200 (correct) → 20/200 = 10% → BELOW the 20% floor → dropped
    //   oldest-200           → 60/200 = 30% → above it → kept
    // A collection that recently went mature is exactly what the floor is for, and
    // an oldest-first sample surfaces it anyway.
    const map = await getCollectionPlayableSample([ORDER_NEWEST_MATURE], SFW_CEILING);
    const s = map.get(ORDER_NEWEST_MATURE)!;
    expect(s).toEqual({ sampled: PLAYABLE_SAMPLE_SIZE, playable: NEWEST_SAFE_TAIL });
    // Stated as the verdict, since that is the consequence: 0.2 is
    // MIN_PLAYABLE_FRACTION (pinned against the endpoint's constant there).
    expect(s.playable / s.sampled).toBeLessThan(0.2);
    // The oldest-first reading would have been 60/200 = 0.3, above the floor.
    expect(s.playable).not.toBe(ORDER_OLD_TAIL);
  });
});
