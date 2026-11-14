import { NsfwLevel } from '~/server/common/enums';
import { heldUserSql } from '@civitai/shared/held-media';
import { semanticImageHeldText } from '~/server/services/semantic-held-content.sql';

/**
 * Which 3D models the semantic search may return, over "Model3D" `m` and its owner "User" `u`.
 * The vector is the thumbnail, so it must be the owner's own and pass the same gates. The
 * event-engine's MODEL3D_ELIGIBLE_SQL is its copy, held to it by model3d-eligibility.parity.test.ts.
 */
/**
 * The level of 3D model `m`'s thumbnail `ti`, which the models3d search gate requires apart from
 * the model's: the vector is the thumbnail. The event-engine's MODEL3D_THUMBNAIL_LEVEL_SQL is its
 * copy, pinned by the same parity test.
 */
export const model3dThumbnailLevelText = ({ ti = 'ti' } = {}) => `${ti}."nsfwLevel"`;

export const model3dSemanticEligibleText = ({ m = 'm', u = 'u' } = {}) =>
  `(${m}.status = 'Published' AND ${m}."deletedAt" IS NULL AND ${m}."nsfwLevel" NOT IN (0, ${
    NsfwLevel.Blocked
  })
  AND NOT ${m}."tosViolation" AND NOT ${m}.unlisted AND NOT ${m}.minor AND NOT ${m}.poi
  AND ${m}.availability = 'Public'
  AND ${u}."bannedAt" IS NULL AND ${u}."deletedAt" IS NULL
  AND NOT ${heldUserSql(`${m}."userId"`)}
  AND EXISTS (SELECT 1 FROM "Image" ti WHERE ti.id = ${m}."thumbnailImageId"
    AND ti.ingestion = 'Scanned' AND ti."needsReview" IS NULL AND NOT ti."tosViolation"
    AND ti."blockedFor" IS NULL AND ti."nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked})
    AND ti."userId" = ${m}."userId" AND NOT ti.minor AND NOT ti.poi
    AND NOT ${semanticImageHeldText('ti')}))`;
