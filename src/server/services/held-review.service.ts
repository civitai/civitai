import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  accountHoldReasonsSql,
  accountHoldSql,
  holdMarkerViewExists,
} from '~/server/services/legal-hold.service';

/**
 * A `WITH` entry, ahead of a DELETE that cascades "ResourceReview", that copies each review a held
 * author wrote among `reviews` (a query selecting review ids) into "HeldResourceReview". In the
 * DELETE's own statement, so it copies exactly what the DELETE takes.
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

/** As `keepHeldReviewsCte`, for "Answer" rows ahead of a "Question" DELETE, into "HeldAnswer". */
export function keepHeldAnswersCte(answers: Prisma.Sql, markerView: boolean): Prisma.Sql {
  const author = Prisma.raw('a."userId"');
  return Prisma.sql`held_answers AS (
    INSERT INTO "HeldAnswer" (
      id, "questionId", "userId", content, "createdAt", "updatedAt", "holdReasons"
    )
    SELECT a.id, a."questionId", a."userId", a.content, a."createdAt", a."updatedAt",
      ${accountHoldReasonsSql(author, markerView)}
    FROM "Answer" a
    WHERE a.id IN (${answers}) AND ${accountHoldSql(author, markerView)}
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

/** The answers to the questions `questions` selects. */
export const answersToQuestionsSql = (questions: Prisma.Sql) =>
  Prisma.sql`SELECT aa.id FROM "Answer" aa WHERE aa."questionId" IN (${questions})`;

/** The reviews on the models `models` selects. */
export const reviewsOnModelsSql = (models: Prisma.Sql) =>
  Prisma.sql`SELECT rr.id FROM "ResourceReview" rr WHERE rr."modelId" IN (${models})`;

/** The reviews on the versions `versions` selects. */
export const reviewsOnVersionsSql = (versions: Prisma.Sql) =>
  Prisma.sql`SELECT rr.id FROM "ResourceReview" rr WHERE rr."modelVersionId" IN (${versions})`;

/** Drops the copies whose author is no longer held. Returns how many went from each table. */
export async function purgeReleasedHeldCopies() {
  const markerView = await holdMarkerViewExists();
  const released = accountHoldSql(Prisma.raw('h."userId"'), markerView);
  const reviews = await dbWrite.$executeRaw`
    DELETE FROM "HeldResourceReview" h WHERE NOT ${released}`;
  const answers = await dbWrite.$executeRaw`DELETE FROM "HeldAnswer" h WHERE NOT ${released}`;
  return { reviews, answers };
}
