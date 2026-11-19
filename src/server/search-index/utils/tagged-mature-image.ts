import { Prisma } from '@prisma/client';
import { childBrowsingTagIds } from '@civitai/shared';
import { NsfwLevel } from '~/server/common/enums';

const childTagIds = new Set<number>(childBrowsingTagIds);

/** Above PG13 and carrying one of `childBrowsingTagIds`: left out of every search document. */
export const isTaggedMatureImage = (image: { nsfwLevel: number; tags?: number[] }) =>
  image.nsfwLevel > NsfwLevel.PG13 && !!image.tags?.some((tagId) => childTagIds.has(tagId));

/** `isTaggedMatureImage` for a served cover, failing closed: above PG13 with unread tags is hidden. */
export const isWithheldMatureCover = (image: { nsfwLevel: number; tags?: number[] }) =>
  image.tags === undefined ? image.nsfwLevel > NsfwLevel.PG13 : isTaggedMatureImage(image);

/** `isTaggedMatureImage` as SQL over `"Image" i`, reading its enabled tags. */
export const taggedMatureImageSql = () => Prisma.sql`(
  i."nsfwLevel" > ${NsfwLevel.PG13} AND EXISTS (
    SELECT 1 FROM "TagsOnImageDetails" toid
    WHERE toid."imageId" = i."id" AND toid."disabled" = false
      AND toid."tagId" = ANY(${[...childBrowsingTagIds]}::int[])
  )
)`;
