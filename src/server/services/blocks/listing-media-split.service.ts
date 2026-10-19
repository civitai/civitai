import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import {
  isComEligibleLevel,
  type ListingMediaSplitDecision,
} from '~/shared/utils/listing-media-split';

/**
 * Reads and writes a listing's media-split decision (`~/shared/utils/listing-media-split`),
 * stored in `app_listing_red_media`.
 *
 * 🔴 THE TABLE IS MANUAL-APPLY, AND EVERY STATEMENT HERE IS PRECEDED BY A PROBE THAT CANNOT
 * FAIL. Callers run inside approve transactions, and PostgreSQL aborts a transaction on any
 * failed statement even when the application catches the error, so querying a missing table
 * and swallowing the error would still take the approve down. With the table absent, a read is
 * "no split" (the rating floor reads every asset, exactly as before the split existed), clearing
 * is a no-op, and only an explicit grant fails, with {@link MEDIA_SPLIT_UNAVAILABLE_MESSAGE}.
 *
 * The only module that names the table; `listing-media-split.ledger.test.ts` pins that.
 */

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export const MEDIA_SPLIT_UNAVAILABLE_MESSAGE =
  'Showing mature media on civitai.red only is not available on this environment yet. Approve with the rating covering all media instead.';

export const MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE =
  'The icon or cover is rated above PG-13, so civitai.com would show a placeholder. A split needs a civitai.com-safe icon and cover; approve with the rating covering all media, or ask the author to change them.';

export async function isListingMediaSplitTableAvailable(
  db: Pick<RawClient, '$queryRaw'>
): Promise<boolean> {
  const rows = await db.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('app_listing_red_media') IS NOT NULL AS present
  `;
  return Array.isArray(rows) && rows[0]?.present === true;
}

/**
 * Whether a moderator has granted `appListingId` a media split. `false` while the table is absent.
 * Read as-is by every path that keeps a split a moderator granted (an image re-rate, a moderator's
 * live edit, an owner republish, the history classifier): a SFW-slot image raised later falls back
 * on civitai.com and is flagged (`sfw-slot-mature`), and the listing stays listed.
 */
export async function readListingMediaSplit(
  db: Pick<RawClient, '$queryRaw'>,
  appListingId: string
): Promise<boolean> {
  if (!(await isListingMediaSplitTableAvailable(db))) return false;
  const rows = await db.$queryRaw<{ split: boolean }[]>`
    SELECT media_split_approved_at IS NOT NULL AS split
    FROM app_listing_red_media
    WHERE app_listing_id = ${appListingId}
  `;
  return Array.isArray(rows) && rows[0]?.split === true;
}

type ListingFace = { iconId: number | null; coverId: number | null };

/** Whether the icon and cover are civitai.com-eligible, which a split requires. */
async function isListingFaceComEligible(
  db: Pick<RawClient, '$queryRaw'>,
  face: ListingFace
): Promise<boolean> {
  const faceIds = [face.iconId, face.coverId].filter((v): v is number => v != null);
  if (faceIds.length === 0) return true;
  const levels = await db.$queryRaw<{ nsfwLevel: number | null }[]>`
    SELECT "nsfwLevel" FROM "Image" WHERE id IN (${Prisma.join(faceIds)})
  `;
  return Array.isArray(levels) && levels.every((l) => isComEligibleLevel(l.nsfwLevel));
}

/**
 * Throws the error a `split` decision would fail with, without writing anything — so a caller
 * whose go-live write cannot surface an error (on-site `approveRequest`) can refuse up front.
 */
export async function assertListingMediaSplitGrantable(
  db: Pick<RawClient, '$queryRaw'>,
  face: ListingFace,
  available?: boolean
): Promise<void> {
  if (!(available ?? (await isListingMediaSplitTableAvailable(db))))
    throw new TRPCError({ code: 'BAD_REQUEST', message: MEDIA_SPLIT_UNAVAILABLE_MESSAGE });
  if (!(await isListingFaceComEligible(db, face)))
    throw new TRPCError({ code: 'BAD_REQUEST', message: MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE });
}

/**
 * Record a moderator's go-live decision on `appListingId` and return whether the listing is
 * split afterwards. `split` stamps the decision with its actor; `rate-mature` and an omitted
 * decision both clear any earlier stamp (default-closed). The review UI always sends an explicit
 * value, preselecting `split` only for a listing that is already split, so re-approving it stamps
 * the moderator who kept it.
 *
 * `face` is the icon and cover going live — for a revision, the shadow's, while `appListingId`
 * is the live listing. A split is refused while civitai.com could not show either (no SFW level),
 * since it would then show a placeholder in its place.
 */
export async function applyListingMediaSplitDecision(
  db: RawClient,
  args: {
    appListingId: string;
    face: ListingFace;
    decision: ListingMediaSplitDecision | null | undefined;
    actorUserId: number;
  }
): Promise<boolean> {
  const available = await isListingMediaSplitTableAvailable(db);
  if (args.decision !== 'split') {
    if (available)
      await db.$executeRaw`
        UPDATE app_listing_red_media
        SET media_split_approved_at = NULL, media_split_approved_by = NULL, updated_at = now()
        WHERE app_listing_id = ${args.appListingId} AND media_split_approved_at IS NOT NULL
      `;
    return false;
  }
  await assertListingMediaSplitGrantable(db, args.face, available);
  await db.$executeRaw`
    INSERT INTO app_listing_red_media (app_listing_id, media_split_approved_at, media_split_approved_by)
    VALUES (${args.appListingId}, now(), ${args.actorUserId})
    ON CONFLICT (app_listing_id) DO UPDATE
      SET media_split_approved_at = now(),
          media_split_approved_by = EXCLUDED.media_split_approved_by,
          updated_at = now()
  `;
  return true;
}
