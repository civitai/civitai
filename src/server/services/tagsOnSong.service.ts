import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { getModeratedTags } from '~/server/services/system-cache';
import {
  deleteTagsOnImageNew,
  insertTagsOnImageNew,
} from '~/server/services/tagsOnImageNew.service';
import { NsfwLevel } from '~/server/common/enums';
import { TagSource } from '~/shared/utils/prisma/enums';

/**
 * The tags a song's owner can attach and remove themselves. Only plain labels: a song's owner
 * writes straight into the shared image tag store, so anything that rates, moderates or
 * categorises content stays with scanners and moderators.
 */

export type SongTag = { id: number; name: string };

/** A tag an owner may attach: a plain PG label outside the moderated set. */
async function attachableTagSql(alias: string) {
  const moderatedIds = (await getModeratedTags()).map((tag) => tag.id);
  const t = Prisma.raw(alias);
  return Prisma.sql`
    ${t}.type::text IN ('UserGenerated', 'Label')
    AND ${t}."nsfwLevel" = ${NsfwLevel.PG}
    AND NOT ${t}."adminOnly"
    AND NOT ${t}.unlisted
    AND NOT ${t}."isCategory"
    AND NOT (${t}.id = ANY(${moderatedIds}::int[]))
  `;
}

/** The tag of this name, when an owner may attach it. */
export async function findAttachableTag(name: string): Promise<SongTag | undefined> {
  const [tag] = await dbWrite.$queryRaw<SongTag[]>`
    SELECT t.id, t.name FROM "Tag" t
    WHERE t.name = ${name} AND ${await attachableTagSql('t')}
  `;
  return tag;
}

/**
 * Each song's owner-managed tags: rows a person attached (not a scanner), still enabled, on a tag
 * an owner may attach.
 */
export async function readSongTags(
  imageIds: number[],
  db: typeof dbRead | typeof dbWrite = dbWrite
) {
  const byImage = new Map<number, SongTag[]>();
  if (!imageIds.length) return byImage;
  const rows = await (db as typeof dbWrite).$queryRaw<(SongTag & { imageId: number })[]>`
    SELECT toi."imageId", t.id, t.name
    FROM "TagsOnImageDetails" toi
    JOIN "Tag" t ON t.id = toi."tagId"
    WHERE toi."imageId" = ANY(${imageIds}::int[])
      AND toi.source::text = ${TagSource.User}
      AND NOT toi.automated
      AND NOT toi.disabled
      AND ${await attachableTagSql('t')}
    ORDER BY t.name
  `;
  for (const { imageId, id, name } of rows)
    byImage.set(imageId, [...(byImage.get(imageId) ?? []), { id, name }]);
  return byImage;
}

/**
 * Tags an owner may attach whose name starts with `prefix`, for the song card's suggestions. The
 * range on `name` (citext) is what lets the unique name index answer it; a `LIKE 'x%'` cannot use
 * that index under the database collation. The `left()` check keeps the result exact wherever the
 * collation's order and a plain prefix disagree.
 */
export async function searchSongTags(prefix: string, limit = 8): Promise<SongTag[]> {
  const chars = Array.from(prefix.trim().toLowerCase());
  if (!chars.length) return [];
  const lower = chars.join('');
  const last = chars[chars.length - 1].codePointAt(0) as number;
  const upper = chars.slice(0, -1).join('') + String.fromCodePoint(last + 1);
  // Name order puts an exact match first, since it sorts before every longer name it prefixes.
  return dbRead.$queryRaw<SongTag[]>`
    SELECT t.id, t.name FROM "Tag" t
    WHERE t.name >= ${lower}::citext AND t.name < ${upper}::citext
      AND left(t.name::text, ${chars.length}) = ${lower}
      AND ${await attachableTagSql('t')}
    ORDER BY t.name
    LIMIT ${limit}
  `;
}

/** Whether the song has any row for this tag, whoever attached it and whatever its state. */
export async function hasSongTagRow(imageId: number, tagId: number) {
  const rows = await dbWrite.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM "TagsOnImageDetails" WHERE "imageId" = ${imageId} AND "tagId" = ${tagId}
  `;
  return rows.length > 0;
}

/** Insert only: an existing row (a disabled one included) is never changed. */
export function attachSongTag(imageId: number, tagId: number) {
  return insertTagsOnImageNew([
    {
      imageId,
      tagId,
      source: TagSource.User,
      automated: false,
      disabled: false,
      needsReview: false,
    },
  ]);
}

export function detachSongTag(imageId: number, tagId: number) {
  return deleteTagsOnImageNew([{ imageId, tagId }]);
}
