import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  accountHoldReasonsSql,
  accountHoldSql,
  holdMarkerViewExists,
} from '~/server/services/legal-hold.service';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';

/**
 * A `WITH` entry, ahead of a DELETE that cascades "ResourceReview", that copies each review a held
 * author wrote among `reviews` (a query selecting review ids) into "HeldResourceReview". In the
 * DELETE's own statement, so a hold landing between two statements cannot skip the copy.
 */
export function keepHeldReviewsCte(reviews: Prisma.Sql, markerView: boolean): Prisma.Sql {
  const author = Prisma.raw('r."userId"');
  return Prisma.sql`held_reviews AS (
    INSERT INTO "HeldResourceReview" (
      id, "modelId", "modelVersionId", "userId", rating, recommended, details, exclude, nsfw,
      "tosViolation", metadata, "createdAt", "updatedAt", "holdReasons"
    )
    SELECT r.id, r."modelId", r."modelVersionId", r."userId", r.rating, r.recommended, r.details,
      r.exclude, r.nsfw, r."tosViolation", r.metadata, r."createdAt", r."updatedAt",
      ${accountHoldReasonsSql(author, markerView)}
    FROM "ResourceReview" r
    WHERE r.id IN (${reviews}) AND ${accountHoldSql(author, markerView)}
    ON CONFLICT (id) DO NOTHING
  )`;
}

/**
 * Whether a held author has an entry under the bounty `bountyId` (an int SQL expression): the bounty
 * is kept, hidden, instead of deleted, so the entry is not cascaded away.
 */
export const heldEntryOnBountySql = (bountyId: Prisma.Sql, markerView: boolean) =>
  Prisma.sql`EXISTS (
    SELECT 1 FROM "BountyEntry" he
    WHERE he."bountyId" = ${bountyId} AND ${accountHoldSql(Prisma.raw('he."userId"'), markerView)}
  )`;

/** The reviews on the models `models` selects, or on their versions: the two can disagree. */
export const reviewsOnModelsSql = (models: Prisma.Sql) =>
  Prisma.sql`SELECT rr.id FROM "ResourceReview" rr
    WHERE rr."modelId" IN (${models})
      OR rr."modelVersionId" IN (SELECT mv.id FROM "ModelVersion" mv WHERE mv."modelId" IN (${models}))`;

/** The reviews on the versions `versions` selects. */
export const reviewsOnVersionsSql = (versions: Prisma.Sql) =>
  Prisma.sql`SELECT rr.id FROM "ResourceReview" rr WHERE rr."modelVersionId" IN (${versions})`;

/**
 * A storyline copy is kept while either user it records is held, the placeholder owner included, as
 * when `removeStorylineChapter` made it. The reader on a branch choice or create click never
 * releases one, even once their account is gone.
 */
const storylineCopyReleasedSql = (markerView: boolean) => {
  const held = (id: Prisma.Sql) =>
    Prisma.sql`(${id} = ${PLACEHOLDER_OWNER_ID} OR ${accountHoldSql(id, markerView)})`;
  return Prisma.sql`NOT ${held(Prisma.raw('h."ownerId"'))} AND NOT ${held(
    Prisma.raw('h."authorId"')
  )}`;
};

/** Drops the copies whose users are no longer held. Returns how many went. */
export async function purgeReleasedHeldCopies() {
  const markerView = await holdMarkerViewExists();
  const released = accountHoldSql(Prisma.raw('h."userId"'), markerView);
  const reviews = await dbWrite.$executeRaw`
    DELETE FROM "HeldResourceReview" h WHERE NOT ${released}`;
  // One statement, so a hold placed meanwhile cannot leave a chapter's copy without its edges.
  const storylineReleased = storylineCopyReleasedSql(markerView);
  const [storyline] = await dbWrite.$queryRaw<
    { chapters: number; edges: number; choices: number; clicks: number }[]
  >`
    WITH chapters AS (
      DELETE FROM "HeldStorylineChapter" h WHERE ${storylineReleased} RETURNING 1
    ),
    edges AS (
      DELETE FROM "HeldStorylineChapterEdge" h WHERE ${storylineReleased} RETURNING 1
    ),
    choices AS (
      DELETE FROM "HeldStorylineBranchChoice" h WHERE ${storylineReleased} RETURNING 1
    ),
    clicks AS (
      DELETE FROM "HeldStorylineCreateClick" h WHERE ${storylineReleased} RETURNING 1
    )
    SELECT (SELECT count(*) FROM chapters)::int AS chapters,
      (SELECT count(*) FROM edges)::int AS edges,
      (SELECT count(*) FROM choices)::int AS choices,
      (SELECT count(*) FROM clicks)::int AS clicks
  `;
  return { reviews, storyline };
}
