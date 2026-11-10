import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { getImageTagRows, type ImageTagRow } from '~/server/redis/image-tag-rows';

/**
 * The tag rows `tagIdsForImagesCache` is filled from, against real Postgres: the
 * "TagsOnImageDetails" view as migration 20250414192734_tag_type defines it, over
 * "TagsOnImageNew", with a citext "Tag"."name" as in production.
 *
 * A Rekognition row is filtered out in SQL when the image also has an enabled WD14 row, unless
 * the tag is a Moderation tag, has an empty name, or is one of the always-kept names. That
 * filter used to run in JS inside the cache's lookupFn; `oldJsFilter` below is that code,
 * verbatim, and the last case checks the two agree on every fixture image.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// Attribute bits, as the view decodes them.
const SOURCE = { User: 1, Rekognition: 2, WD14: 3, Computed: 4 } as const;
const DISABLED = 1 << 10;
const AUTOMATED = 1 << 11;
const attrs = (source: keyof typeof SOURCE, flags = 0) => (SOURCE[source] << 12) | flags | 37;

// Tags, ids pairwise distinct and distinct from every image id.
const T_HAIR = 100; // Label, the WD14 tag
const T_LANDSCAPE = 200; // Label, a plain Rekognition tag
const T_SKY = 201; // Label
const T_ANIME = 300; // always kept, by exact name
const T_ANIME_CASED = 301; // 'Anime': the kept-name match is case-sensitive, so not kept
const T_NUDITY = 400; // Moderation
const T_EMPTY = 500; // empty name
const T_WOMAN = 600; // always kept, UserGenerated
const T_GONE = 999; // no Tag row

// Images.
const I_WD = 11; // WD14 plus every Rekognition case
const I_NO_WD = 12; // Rekognition only: nothing to supersede it
const I_WD_DISABLED = 13; // its WD14 row is disabled, so does not count
const I_OTHER = 14; // WD14, a Computed row, a disabled Rekognition row
const I_OUTSIDE = 15; // not asked for

const BATCH = [I_WD, I_NO_WD, I_WD_DISABLED, I_OTHER];

let pg: PGlite;
let raw: ReturnType<typeof pgliteRaw>;
const db = () => ({ $queryRaw: raw.queryRaw } as unknown as Parameters<typeof getImageTagRows>[0]);

beforeAll(async () => {
  pg = new PGlite({ extensions: { citext } });
  raw = pgliteRaw(pg);
  await pg.exec(`
    CREATE EXTENSION citext;
    CREATE TYPE "TagType" AS ENUM ('UserGenerated', 'Label', 'Moderation', 'System');
    CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'Hive',
      'MinorDetection', 'HiveDemographics', 'Clavata', 'SpineRating', 'AiRecognition', 'AnimeRecognition');
    CREATE TABLE "Tag" (id int PRIMARY KEY, name citext NOT NULL, type "TagType" NOT NULL);
    CREATE TABLE "TagsOnImageNew" (
      "imageId" integer NOT NULL, "tagId" integer NOT NULL, attributes smallint NOT NULL,
      PRIMARY KEY ("imageId", "tagId")
    );
    CREATE VIEW "TagsOnImageDetails" AS
    SELECT
      "imageId",
      "tagId",
      CASE
        WHEN (("attributes" >> 12) & 15) = 1 THEN 'User'::"TagSource"
        WHEN (("attributes" >> 12) & 15) = 2 THEN 'Rekognition'::"TagSource"
        WHEN (("attributes" >> 12) & 15) = 3 THEN 'WD14'::"TagSource"
        WHEN (("attributes" >> 12) & 15) = 4 THEN 'Computed'::"TagSource"
        WHEN (("attributes" >> 12) & 15) = 5 THEN 'ImageHash'::"TagSource"
        WHEN (("attributes" >> 12) & 15) = 6 THEN 'MinorDetection'::"TagSource"
        WHEN (("attributes" >> 12) & 15) = 7 THEN 'Clavata'::"TagSource"
        ELSE 'User'::"TagSource"
      END AS source,
      CASE WHEN ("attributes" >> 11) & 1 = 1 THEN TRUE ELSE FALSE END AS automated,
      CASE WHEN ("attributes" >> 10) & 1 = 1 THEN TRUE ELSE FALSE END AS disabled,
      CASE WHEN ("attributes" >> 9) & 1 = 1 THEN TRUE ELSE FALSE END AS "needsReview",
      CASE WHEN ("attributes" >> 8) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_1,
      CASE WHEN ("attributes" >> 7) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_2,
      ("attributes" & 127) AS confidence
    FROM "TagsOnImageNew";
    INSERT INTO "Tag" (id, name, type) VALUES
      (${T_HAIR}, 'hair', 'Label'),
      (${T_LANDSCAPE}, 'landscape', 'Label'),
      (${T_SKY}, 'sky', 'Label'),
      (${T_ANIME}, 'anime', 'Label'),
      (${T_ANIME_CASED}, 'Anime', 'Label'),
      (${T_NUDITY}, 'nudity', 'Moderation'),
      (${T_EMPTY}, '', 'Label'),
      (${T_WOMAN}, 'woman', 'UserGenerated');
    INSERT INTO "TagsOnImageNew" ("imageId", "tagId", attributes) VALUES
      (${I_WD}, ${T_HAIR}, ${attrs('WD14', AUTOMATED)}),
      (${I_WD}, ${T_SKY}, ${attrs('User')}),
      (${I_WD}, ${T_LANDSCAPE}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_WD}, ${T_ANIME}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_WD}, ${T_ANIME_CASED}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_WD}, ${T_NUDITY}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_WD}, ${T_EMPTY}, ${attrs('Rekognition')}),
      (${I_WD}, ${T_WOMAN}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_WD}, ${T_GONE}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_NO_WD}, ${T_LANDSCAPE}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_WD_DISABLED}, ${T_HAIR}, ${attrs('WD14', AUTOMATED | DISABLED)}),
      (${I_WD_DISABLED}, ${T_LANDSCAPE}, ${attrs('Rekognition', AUTOMATED)}),
      (${I_OTHER}, ${T_HAIR}, ${attrs('WD14', AUTOMATED)}),
      (${I_OTHER}, ${T_SKY}, ${attrs('Computed')}),
      (${I_OTHER}, ${T_LANDSCAPE}, ${attrs('Rekognition', AUTOMATED | DISABLED)}),
      (${I_OUTSIDE}, ${T_LANDSCAPE}, ${attrs('Rekognition', AUTOMATED)});
  `);
});
afterAll(async () => pg.close());

const byKey = (rows: ImageTagRow[]) =>
  [...rows]
    .map(({ imageId, source, tagId }) => ({ imageId, source, tagId }))
    .sort((a, b) => a.imageId - b.imageId || a.tagId - b.tagId);

type TagLookup = { id: number; name: string; type: string };
async function tagLookup(): Promise<Record<number, TagLookup>> {
  const { rows } = await pg.query<TagLookup>(
    `SELECT id, name::text AS name, type::text FROM "Tag"`
  );
  return Object.fromEntries(rows.map((t) => [t.id, t]));
}

// The pre-change statement: every enabled row, unfiltered.
async function unfilteredRows(imageIds: number[]) {
  const { rows } = await pg.query<ImageTagRow>(
    `SELECT "imageId", "source", "tagId" FROM "TagsOnImageDetails"
     WHERE "imageId" = ANY($1::int[]) AND "disabled" = false`,
    [imageIds]
  );
  return rows;
}

// The JS filter tagIdsForImagesCache's lookupFn applied before the filter moved into SQL, verbatim
// apart from the inlined enum values and kept-name list.
function oldJsFilter(imageTags: ImageTagRow[], tags: Record<number, TagLookup>) {
  const alwaysIncludeTags = ['anime', 'cartoon', 'comics', 'manga', 'man', 'woman', 'men', 'women'];
  const hasWD: { [p: string]: boolean } = {};
  for (const row of imageTags) {
    const imageIdStr = row.imageId.toString();
    hasWD[imageIdStr] ??= false;
    if (row.source === 'WD14') hasWD[imageIdStr] = true;
  }
  return imageTags.reduce((acc, { tagId, imageId, source }) => {
    const imageIdStr = imageId.toString();
    acc[imageIdStr] ??= { imageId, tags: [] };

    const tag = tags[tagId];
    if (!tag) return acc;

    let canAdd = true;
    if (source === 'Rekognition' && hasWD[imageIdStr as keyof typeof hasWD]) {
      if (tag.type !== 'Moderation' && tag.name && !alwaysIncludeTags.includes(tag.name)) {
        canAdd = false;
      }
    }

    if (canAdd) acc[imageIdStr].tags.push(tagId);
    return acc;
  }, {} as Record<string, { imageId: number; tags: number[] }>);
}

// What the lookupFn does now with the rows the query returns: drop tags it cannot resolve.
function currentFold(imageTags: ImageTagRow[], tags: Record<number, TagLookup>) {
  return imageTags.reduce((acc, { tagId, imageId }) => {
    const imageIdStr = imageId.toString();
    acc[imageIdStr] ??= { imageId, tags: [] };
    if (tags[tagId]) acc[imageIdStr].tags.push(tagId);
    return acc;
  }, {} as Record<string, { imageId: number; tags: number[] }>);
}

const sortedTags = (result: Record<string, { imageId: number; tags: number[] }>) =>
  Object.fromEntries(
    Object.entries(result).map(([id, v]) => [id, { ...v, tags: [...v.tags].sort((a, b) => a - b) }])
  );

describe('getImageTagRows against real rows', () => {
  it('leaves superseded Rekognition rows in the database', async () => {
    const rows = await getImageTagRows(db(), BATCH);

    expect(byKey(rows)).toEqual([
      // Dropped here: landscape and 'Anime' (Rekognition, plain Label, image has enabled WD14).
      { imageId: I_WD, source: 'WD14', tagId: T_HAIR },
      { imageId: I_WD, source: 'User', tagId: T_SKY },
      { imageId: I_WD, source: 'Rekognition', tagId: T_ANIME },
      { imageId: I_WD, source: 'Rekognition', tagId: T_NUDITY },
      { imageId: I_WD, source: 'Rekognition', tagId: T_EMPTY },
      { imageId: I_WD, source: 'Rekognition', tagId: T_WOMAN },
      // No Tag row: returned, and dropped by the caller as an unresolvable tag.
      { imageId: I_WD, source: 'Rekognition', tagId: T_GONE },
      { imageId: I_NO_WD, source: 'Rekognition', tagId: T_LANDSCAPE },
      { imageId: I_WD_DISABLED, source: 'Rekognition', tagId: T_LANDSCAPE },
      { imageId: I_OTHER, source: 'WD14', tagId: T_HAIR },
      { imageId: I_OTHER, source: 'Computed', tagId: T_SKY },
    ]);
  });

  it('returns nothing for an image with no rows', async () => {
    expect(await getImageTagRows(db(), [7777])).toEqual([]);
  });

  it('gives the cache exactly what the old JS filter gave it, image by image', async () => {
    const tags = await tagLookup();
    const before = sortedTags(oldJsFilter(await unfilteredRows(BATCH), tags));
    const after = sortedTags(currentFold(await getImageTagRows(db(), BATCH), tags));

    const expected = {
      [I_WD]: { imageId: I_WD, tags: [T_HAIR, T_SKY, T_ANIME, T_NUDITY, T_EMPTY, T_WOMAN] },
      [I_NO_WD]: { imageId: I_NO_WD, tags: [T_LANDSCAPE] },
      [I_WD_DISABLED]: { imageId: I_WD_DISABLED, tags: [T_LANDSCAPE] },
      [I_OTHER]: { imageId: I_OTHER, tags: [T_HAIR, T_SKY] },
    };
    expect(before).toEqual(expected);
    expect(after).toEqual(expected);
  });
});
