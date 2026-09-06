import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a
// contended runner. Relaxing it can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What `getCollectionItemCount`'s maturity clamp counts against REAL ROWS, as
 * opposed to what its SQL text says.
 *
 * 🔴 WHY THIS IS EXECUTED AND NOT STRING-ASSERTED. The defect this file exists to
 * prevent is a one-word difference — `JOIN "Image"` where the code needs `LEFT
 * JOIN "Image"`. An assertion that the statement "contains `Image`" and
 * "contains `nsfwLevel &`" passes on BOTH, and so does one that pins the fragment
 * order, because both spellings contain the same fragments in the same order. The
 * inner-join version silently returns ZERO for every model / post / article
 * collection — `nsfwLevel` lives on `Image`, and those items have no image row to
 * join to. Only running the query on rows of each shape can tell the two apart,
 * so that is what this does: the service's own SQL, unmodified, on an in-process
 * Postgres.
 *
 * The clamped count is what a discovery card advertises, so a collection reading
 * 0 is a collection that disappears behind the playable-fraction floor. An
 * inner-join regression here would empty every non-image collection out of the
 * catalog while every mocked test stayed green.
 */

// `beforeAll` builds the instance, so everything below reaches it through this
// holder rather than capturing a value that does not exist yet.
const holder = { db: null as unknown as PGlite };

/**
 * Run the service's tagged-template statement on PGlite.
 *
 * 🔴 THE FLATTEN IS LOAD-BEARING. `getCollectionItemCount` interpolates NESTED
 * `Prisma.sql` fragments (the join clause and the composed WHERE), so the naive
 * `$${i + 1}` stitch used by sibling harnesses would substitute a bind parameter
 * where a whole SQL clause belongs and produce a syntactically valid statement
 * that tests nothing. `Prisma.sql(strings, ...values)` performs exactly the
 * flattening Prisma itself does before sending, and `.text` / `.values` are the
 * statement and binds the database would have received.
 */
dbMock.dbRead.$queryRaw.mockImplementation(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return holder.db.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  }
);

const { getCollectionItemCount } = await import('~/server/services/collection.service');

// nsfwLevel buckets, as the app's Flags enum lays them out.
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
/** A SFW-domain ceiling: PG | PG13. */
const SFW_CEILING = PG | PG13;

// One collection per item shape, so a clamp that only works for one of them
// cannot hide behind the others' totals.
const MIXED = 7001; // images at several maturities + one of every non-image shape
const IMAGES_ONLY = 7002;
const MODELS_ONLY = 7003; // 🔴 the inner-join canary
const ARTICLES_ONLY = 7004;
const POSTS_ONLY = 7005;
const EMPTY = 7006; // no accepted items at all
const ORPHAN_IMAGE = 7007; // an item pointing at an Image row that no longer exists

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
      (1, ${PG}), (2, ${PG13}), (3, ${R}), (4, ${X}), (5, 0),
      (6, ${PG}), (7, ${X}),
      (8, ${R});
    INSERT INTO "CollectionItem" ("id","collectionId","imageId","modelId","postId","articleId","status") VALUES
      -- MIXED: 2 permitted images (PG, PG13), 1 unrated image (always permitted),
      -- 2 over-ceiling images (R, X), and one item of every NON-IMAGE shape.
      (101, ${MIXED},        1,    NULL, NULL, NULL, 'ACCEPTED'),
      (102, ${MIXED},        2,    NULL, NULL, NULL, 'ACCEPTED'),
      (103, ${MIXED},        5,    NULL, NULL, NULL, 'ACCEPTED'),
      (104, ${MIXED},        3,    NULL, NULL, NULL, 'ACCEPTED'),
      (105, ${MIXED},        4,    NULL, NULL, NULL, 'ACCEPTED'),
      (106, ${MIXED},        NULL, 900,  NULL, NULL, 'ACCEPTED'),
      (107, ${MIXED},        NULL, NULL, 901,  NULL, 'ACCEPTED'),
      (108, ${MIXED},        NULL, NULL, NULL, 902,  'ACCEPTED'),
      -- A REJECTED row that would be permitted by the ceiling: proves the status
      -- filter still composes with the clamp rather than being replaced by it.
      (109, ${MIXED},        6,    NULL, NULL, NULL, 'REJECTED'),
      -- IMAGES_ONLY: 1 permitted, 1 over the ceiling.
      (201, ${IMAGES_ONLY},  1,    NULL, NULL, NULL, 'ACCEPTED'),
      (202, ${IMAGES_ONLY},  7,    NULL, NULL, NULL, 'ACCEPTED'),
      -- MODELS_ONLY / ARTICLES_ONLY / POSTS_ONLY: no image rows anywhere.
      (301, ${MODELS_ONLY},  NULL, 910,  NULL, NULL, 'ACCEPTED'),
      (302, ${MODELS_ONLY},  NULL, 911,  NULL, NULL, 'ACCEPTED'),
      (303, ${MODELS_ONLY},  NULL, 912,  NULL, NULL, 'ACCEPTED'),
      (401, ${ARTICLES_ONLY},NULL, NULL, NULL, 920,  'ACCEPTED'),
      (402, ${ARTICLES_ONLY},NULL, NULL, NULL, 921,  'ACCEPTED'),
      (501, ${POSTS_ONLY},   NULL, NULL, 930,  NULL, 'ACCEPTED'),
      -- EMPTY: an item with no subject at all (the row filter drops it), so this
      -- collection produces no GROUP BY row in either mode.
      (601, ${EMPTY},        NULL, NULL, NULL, NULL, 'ACCEPTED'),
      -- ORPHAN_IMAGE: imageId 99999 has no "Image" row.
      (701, ${ORPHAN_IMAGE}, 99999,NULL, NULL, NULL, 'ACCEPTED'),
      (702, ${ORPHAN_IMAGE}, 1,    NULL, NULL, NULL, 'ACCEPTED');
  `);
});

/** `[{id,count}]` → a plain id→number map; a collection with no row reads 0. */
async function counts(args: Parameters<typeof getCollectionItemCount>[0]) {
  const rows = await getCollectionItemCount(args);
  const map = new Map<number, number>(rows.map((r) => [Number(r.id), Number(r.count)]));
  return (id: number) => map.get(id) ?? 0;
}

const ALL = [MIXED, IMAGES_ONLY, MODELS_ONLY, ARTICLES_ONLY, POSTS_ONLY, EMPTY, ORPHAN_IMAGE];

describe("getCollectionItemCount — UNCLAMPED (today's behaviour, must not move)", () => {
  it('counts every accepted item with a subject, of any type, at any maturity', async () => {
    const at = await counts({ collectionIds: ALL, status: CollectionItemStatus.ACCEPTED });
    // 5 images (incl. the R and X ones) + model + post + article = 8. The REJECTED
    // row is excluded by the status filter, the subject-less row by the row filter.
    expect(at(MIXED)).toBe(8);
    expect(at(IMAGES_ONLY)).toBe(2);
    expect(at(MODELS_ONLY)).toBe(3);
    expect(at(ARTICLES_ONLY)).toBe(2);
    expect(at(POSTS_ONLY)).toBe(1);
    // GROUP BY emits no row for a collection with nothing to count.
    expect(at(EMPTY)).toBe(0);
    // An item whose Image is gone is still an item as far as the unclamped count
    // is concerned — it never looks at "Image".
    expect(at(ORPHAN_IMAGE)).toBe(2);
  });

  it('omitting `status` counts REVIEW/REJECTED rows too', async () => {
    const at = await counts({ collectionIds: [MIXED] });
    expect(at(MIXED)).toBe(9);
  });

  it('an empty id list short-circuits without touching the database', async () => {
    dbMock.dbRead.$queryRaw.mockClear();
    // Note: the short-circuit returns the array SYNCHRONOUSLY while the query path
    // returns a promise. That union is pre-existing and every caller `await`s the
    // result, so both work; asserted as-is rather than tidied, since changing it
    // is a change to five call sites' return type.
    expect(await getCollectionItemCount({ collectionIds: [] })).toEqual([]);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('getCollectionItemCount — CLAMPED to a browsingLevel', () => {
  it('🔴 keeps NON-IMAGE items unconditionally (the LEFT JOIN guarantee)', async () => {
    // THE regression this file exists for. `nsfwLevel` lives on "Image"; an inner
    // join here returns 0 for all three of these, which is not a smaller number —
    // it is the whole collection vanishing from discovery.
    const at = await counts({
      collectionIds: ALL,
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: SFW_CEILING,
    });
    expect(at(MODELS_ONLY)).toBe(3);
    expect(at(ARTICLES_ONLY)).toBe(2);
    expect(at(POSTS_ONLY)).toBe(1);
    // …and their unclamped counts are identical, i.e. a ceiling cannot move a
    // number that no image contributes to.
    const unclamped = await counts({ collectionIds: ALL, status: CollectionItemStatus.ACCEPTED });
    for (const id of [MODELS_ONLY, ARTICLES_ONLY, POSTS_ONLY]) expect(at(id)).toBe(unclamped(id));
  });

  it('🔴 a MIXED collection keeps permitted images AND every non-image row, and drops only the over-ceiling images', async () => {
    const at = await counts({
      collectionIds: [MIXED],
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: SFW_CEILING,
    });
    // PG + PG13 + unrated + model + post + article = 6. The R and X images go.
    // Distinct from both 8 (no clamp at all) and 3 (image-only clamp that dropped
    // the non-image rows), so neither mistake can produce this number.
    expect(at(MIXED)).toBe(6);
  });

  it('images-only: the clamp is the bitwise intersection, not a threshold', async () => {
    const at = await counts({
      collectionIds: [IMAGES_ONLY],
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: SFW_CEILING,
    });
    expect(at(IMAGES_ONLY)).toBe(1);

    // A ceiling of exactly R admits the R image and REFUSES the PG one — which a
    // `nsfwLevel <= browsingLevel` comparison could never produce (PG=1 <= R=4).
    const atR = await counts({
      collectionIds: [MIXED],
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: R,
    });
    // The R image + the unrated one + the three non-image rows = 5; the PG, PG13
    // and X images are all excluded.
    expect(atR(MIXED)).toBe(5);
  });

  it('the status filter still composes with the clamp', async () => {
    // Item 109 is a PG image (permitted) but REJECTED. Counting REJECTED alone at
    // a SFW ceiling must find exactly it — proving the clamp did not replace the
    // status predicate, and that a permitted-but-wrong-status row is still excluded
    // from the ACCEPTED count above.
    const at = await counts({
      collectionIds: [MIXED],
      status: CollectionItemStatus.REJECTED,
      browsingLevel: SFW_CEILING,
    });
    expect(at(MIXED)).toBe(1);
  });

  it('🔴 `browsingLevel: 0` clamps to unrated-only — it is NOT read as "no clamp"', async () => {
    // The mutation this pins: `if (browsingLevel)` instead of `if (browsingLevel
    // != null)`. Under truthiness a ceiling of 0 — the most restrictive viewer
    // there is — silently returns the FULL unclamped count.
    const at = await counts({
      collectionIds: [MIXED],
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: 0,
    });
    // Only the unrated image + the three non-image rows survive.
    expect(at(MIXED)).toBe(4);
    // Emphatically not the unclamped 8.
    expect(at(MIXED)).not.toBe(8);
  });

  it('an item whose Image row is gone is NOT counted as playable (fail closed)', async () => {
    const at = await counts({
      collectionIds: [ORPHAN_IMAGE],
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: SFW_CEILING,
    });
    // Only the item with a real, permitted Image. An image we cannot rate is one
    // we cannot promise is playable — and `getFallbackCoverImages` drops it too.
    expect(at(ORPHAN_IMAGE)).toBe(1);
  });

  it('a collection with nothing to count stays absent (no phantom zero row)', async () => {
    const rows = await getCollectionItemCount({
      collectionIds: [EMPTY],
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: SFW_CEILING,
    });
    expect(rows).toEqual([]);
  });

  it('a ceiling that permits everything reproduces the unclamped count exactly', async () => {
    // Positive control on the harness: if the clamped path were wired to nothing —
    // or to a predicate that can only ever exclude — this would not be able to
    // reach the unclamped totals.
    const everything = PG | PG13 | R | X;
    const at = await counts({
      collectionIds: ALL,
      status: CollectionItemStatus.ACCEPTED,
      browsingLevel: everything,
    });
    expect(at(MIXED)).toBe(8);
    expect(at(IMAGES_ONLY)).toBe(2);
    expect(at(MODELS_ONLY)).toBe(3);
  });
});
