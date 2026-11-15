import { Prisma } from '@prisma/client';
import { modelBrowsingLevelLimit } from '~/shared/constants/browsingLevel.constants';

const minorLimit = modelBrowsingLevelLimit({ minor: true, sfwOnly: false });
const sfwOnlyLimit = modelBrowsingLevelLimit({ minor: false, sfwOnly: true });

/**
 * The SQL twin of `heldGalleryLevel`: an image `i` on a post of model `m` may be served when `m` is
 * neither minor nor SFW-only, when no model is joined, or when the image is within the model's held
 * gallery level (its stored level within its flag limit, or the whole limit when that is empty).
 * `exempt` names who sees the whole showcase (the model's owner, a moderator); pass FALSE where
 * the result is shared between viewers.
 */
export function heldGalleryImageSql({
  image = Prisma.raw('i'),
  model = Prisma.raw('m'),
  exempt = Prisma.sql`FALSE`,
}: { image?: Prisma.Sql; model?: Prisma.Sql; exempt?: Prisma.Sql } = {}) {
  const limit = Prisma.sql`(CASE WHEN ${model}.minor THEN ${minorLimit}::int ELSE ${sfwOnlyLimit}::int END)`;
  const stored = Prisma.sql`(CASE WHEN jsonb_typeof(${model}."gallerySettings"->'level') = 'number'
    THEN (${model}."gallerySettings"->>'level')::numeric::int ELSE 0 END)`;
  return Prisma.sql`(
    ${model}.id IS NULL
    OR NOT (COALESCE(${model}.minor, FALSE) OR COALESCE(${model}."sfwOnly", FALSE))
    OR (${image}."nsfwLevel" & COALESCE(NULLIF(${stored} & ${limit}, 0), ${limit})) <> 0
    OR ${exempt}
  )`;
}
