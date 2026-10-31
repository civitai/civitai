import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getCsamSupplementalCandidates } from '@civitai/db-queries/csam-queue';
import { SHOWN_RENDITIONS } from '@civitai/shared/held-media';
import { kyselyWrite } from '~/server/db/kyselyDb';
import type {
  CreateCsamReportSchema,
  GetCsamSupplementalPreviewSchema,
} from '~/server/schema/csam.schema';
import type { CsamSupplementalDetails } from '~/server/services/csam-supplemental-text';
import { supplementalReportText } from '~/server/services/csam-supplemental-text';
import { getViewedImageIds, shownActivities } from '~/server/services/csam.service-new';
import { throwBadRequestError } from '~/server/utils/errorHandling';

const SHOWN_ACTIVITIES = SHOWN_RENDITIONS.flatMap(shownActivities);

const ids = (list: number[]) => list.map((id) => `#${id}`).join(', ');

/** Everything a supplemental filing would send, or why it may not be filed. */
async function resolveSupplemental(
  db: Kysely<DB>,
  {
    userId,
    imageIds,
    supplementalOf,
    reportedById,
  }: GetCsamSupplementalPreviewSchema & { reportedById: number }
): Promise<CsamSupplementalDetails> {
  if (!imageIds.length) throwBadRequestError('Select at least one confirmed image');

  const prior = await db
    .selectFrom('CsamReport')
    .select('id')
    .where('id', '=', supplementalOf)
    .where('userId', '=', userId)
    .where('type', '=', 'Image')
    .where('reportSentAt', 'is not', null)
    .where('reportId', 'is not', null)
    .executeTakeFirst();
  if (!prior)
    throwBadRequestError(`Report ${supplementalOf} is not a sent image report on this user`);

  const pending = await db
    .selectFrom('CsamReport')
    .select('id')
    .where('userId', '=', userId)
    .where('reportSentAt', 'is', null)
    .where(sql<boolean>`details ? 'supplemental'`)
    .executeTakeFirst();
  if (pending)
    throwBadRequestError(`Supplemental report ${pending.id} on this user is waiting to send`);

  const owned = await db
    .selectFrom('Image')
    .select('id')
    .where('id', 'in', imageIds)
    .where('userId', '=', userId)
    .execute();
  const notOwned = imageIds.filter((id) => !owned.some((image) => image.id === id));
  if (notOwned.length) throwBadRequestError(`Not this user's images: ${ids(notOwned)}`);

  const { rows: listed } = await sql<{ id: number }>`
    SELECT DISTINCT (e ->> 'id')::int AS id
    FROM "CsamReport" r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.images) = 'array' THEN r.images ELSE '[]'::jsonb END
    ) e
    WHERE r."userId" = ${userId} AND e ->> 'id' = ANY(${imageIds.map(String)}::text[])
    ORDER BY 1`.execute(db);
  if (listed.length) throwBadRequestError(`Already in a report: ${ids(listed.map((r) => r.id))}`);

  const viewed = await getViewedImageIds(imageIds, { reportedById, createdAt: new Date() });
  const unviewed = imageIds.filter((id) => !viewed.has(id));
  if (unviewed.length) throwBadRequestError(`Not reviewed on screen: ${ids(unviewed)}`);

  const candidates = await getCsamSupplementalCandidates(db, {
    userId,
    filing: imageIds,
    shownActivities: SHOWN_ACTIVITIES,
  });
  const undecided = candidates.filter((image) => image.viewed).map((image) => image.id);
  if (undecided.length)
    throwBadRequestError(
      `Reviewed but not decided: ${ids(undecided)}. Add them to this report or dismiss them first`
    );

  const priorReports = await db
    .selectFrom('CsamReport')
    .select('reportId')
    .distinct()
    .where('userId', '=', userId)
    .where('reportSentAt', 'is not', null)
    .where('reportId', 'is not', null)
    .orderBy('reportId')
    .execute();

  return {
    priorCsamReportId: supplementalOf,
    priorReportNumbers: priorReports.map((r) => r.reportId as number),
    unreviewedImageIds: candidates.map((image) => image.id),
  };
}

export async function getCsamSupplementalPreview(
  input: GetCsamSupplementalPreviewSchema & { reportedById: number }
) {
  const supplemental = await resolveSupplemental(kyselyWrite, input);
  return {
    priorReportNumbers: supplemental.priorReportNumbers,
    unreviewed: supplemental.unreviewedImageIds.length,
    text: supplementalReportText(supplemental.unreviewedImageIds.length),
  };
}

/** Files a report of reviewer-confirmed images on a user an earlier report was already sent for.
 *  It never folds into another report. */
export async function createSupplementalCsamReport({
  reportedById,
  userId,
  imageIds = [],
  details,
  type,
  supplementalOf,
}: CreateCsamReportSchema & { reportedById: number; supplementalOf: number }) {
  if (type !== 'Image' || userId === -1)
    throwBadRequestError('Only an image report on a user can be supplemental');

  return kyselyWrite.transaction().execute(async (tx) => {
    // Serialises supplemental filings on one user, so two cannot both pass the waiting check.
    await sql`SELECT 1 FROM "User" WHERE id = ${userId} FOR UPDATE`.execute(tx);
    const supplemental = await resolveSupplemental(tx, {
      userId,
      imageIds,
      supplementalOf,
      reportedById,
    });
    return tx
      .insertInto('CsamReport')
      .values({
        userId,
        reportedById,
        type: 'Image',
        details: JSON.stringify({ ...details, supplemental }),
        images: JSON.stringify(imageIds.map((id) => ({ id }))),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  });
}
