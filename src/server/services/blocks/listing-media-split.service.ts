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
 * 🔴 THE TABLE IS MANUAL-APPLY, AND MANUALLY GRANTED, SO EVERY STATEMENT HERE IS PRECEDED BY A
 * PROBE THAT CANNOT FAIL: whether the table exists, and what the CURRENT database role may do
 * with it. Callers run inside approve transactions, and PostgreSQL aborts a transaction on any
 * failed statement even when the application catches the error, so issuing a statement that
 * fails (a missing table, a missing grant) and swallowing the error would still take the approve
 * down. So:
 *   - a READ is "no split" unless the table exists AND this role may SELECT it — the rating floor
 *     then reads every asset, exactly as before the split existed, and the author and store reads
 *     that consult it keep working. The moderator's review alone reads the third answer, "cannot
 *     tell" ({@link readListingMediaSplitState}), so it never shows a split listing as unsplit;
 *   - an explicit decision (`split`, `rate-mature`) this role cannot carry out is refused before
 *     anything is written, with a moderator-facing message
 *     ({@link assertListingMediaSplitDecisionApplicable}), never issued and left to fail. With the
 *     table absent, clearing is a no-op and only an explicit grant is refused
 *     ({@link MEDIA_SPLIT_UNAVAILABLE_MESSAGE}). An approve with NO decision on a table this role
 *     cannot read issues nothing against it and proceeds, as before the split existed.
 *
 * The only module that names the table; `listing-media-split.ledger.test.ts` pins that.
 */

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export const MEDIA_SPLIT_UNAVAILABLE_MESSAGE =
  'Showing mature media on civitai.red only is not available on this environment yet. Approve with the rating covering all media instead.';

export const MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE =
  'The icon or cover is rated above PG-13, so civitai.com would show a placeholder. A split needs a civitai.com-safe icon and cover; approve with the rating covering all media, or ask the author to change them.';

export const MEDIA_SPLIT_NOT_WRITABLE_MESSAGE =
  'This environment has the civitai.com / civitai.red media-split record, but the app is not permitted to update it, so this approve cannot record or clear a media split. Nothing was changed. Ask an engineer to grant the app access to it, then approve again.';

/** What the current database role may do with the split table; all `false` while it is absent. */
export type ListingMediaSplitTableAccess = {
  present: boolean;
  select: boolean;
  insert: boolean;
  update: boolean;
};

/**
 * Probe the split table and the current role's privileges on it, in one statement that cannot
 * fail: `has_table_privilege` is strict, so with the table absent (`to_regclass` NULL) every
 * privilege reads NULL, coalesced to `false`.
 */
export async function probeListingMediaSplitTable(
  db: Pick<RawClient, '$queryRaw'>
): Promise<ListingMediaSplitTableAccess> {
  const rows = await db.$queryRaw<
    { present: boolean; can_select: boolean; can_insert: boolean; can_update: boolean }[]
  >`
    SELECT t IS NOT NULL AS present,
           COALESCE(has_table_privilege(t, 'SELECT'), false) AS can_select,
           COALESCE(has_table_privilege(t, 'INSERT'), false) AS can_insert,
           COALESCE(has_table_privilege(t, 'UPDATE'), false) AS can_update
    FROM (SELECT to_regclass('app_listing_red_media') AS t) AS probe
  `;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const present = row?.present === true;
  return {
    present,
    select: present && row?.can_select === true,
    insert: present && row?.can_insert === true,
    update: present && row?.can_update === true,
  };
}

/**
 * Whether a moderator has granted `appListingId` a media split, as this role can see it: `true` or
 * `false`, or `null` when the table exists but this role may not read it. An absent table is
 * `false` — no split can exist without it.
 *
 * `null` is for the moderator's review ({@link readListingMediaSplit} is the fail-safe form for
 * everything else): a split listing must never be shown to the moderator about to approve it as
 * unsplit, because the review then preselects ending the split.
 */
export async function readListingMediaSplitState(
  db: Pick<RawClient, '$queryRaw'>,
  appListingId: string
): Promise<boolean | null> {
  const access = await probeListingMediaSplitTable(db);
  if (!access.present) return false;
  if (!access.select) return null;
  return readStamped(db, appListingId);
}

/**
 * Whether a moderator has granted `appListingId` a media split. `false` while the table is absent
 * or this role may not read it (fail-safe: the rating is then floored by all media, as before the
 * split existed). Read as-is by every path that keeps a split a moderator granted (an image
 * re-rate, a moderator's live edit, an owner republish, the history classifier): a SFW-slot image
 * raised later falls back on civitai.com and is flagged (`sfw-slot-mature`), and the listing stays
 * listed.
 */
export async function readListingMediaSplit(
  db: Pick<RawClient, '$queryRaw'>,
  appListingId: string
): Promise<boolean> {
  return (await readListingMediaSplitState(db, appListingId)) === true;
}

async function readStamped(db: Pick<RawClient, '$queryRaw'>, appListingId: string) {
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

const refuse = (message: string) => new TRPCError({ code: 'BAD_REQUEST', message });

/**
 * Throws the error {@link applyListingMediaSplitDecision} would fail with, without writing
 * anything — so a caller whose go-live write cannot surface an error (on-site `approveRequest`,
 * which logs and continues on a listing failure) can refuse up front, before it writes or builds.
 *
 * - `split` needs the table, SELECT + INSERT + UPDATE on it, and a civitai.com-eligible face.
 * - `rate-mature` CLEARS an earlier split. With the table absent there is nothing to clear. With
 *   it present, this role must be able to read it, and to update it if the listing is stamped.
 * - NO decision also clears an earlier split, with one difference: when this role cannot read
 *   the table it is treated as having nothing to clear, and the approve proceeds exactly as it
 *   did before the split existed — no statement against the table, no refusal. When it CAN read
 *   it and the listing is stamped, it must also be able to update it, or it is refused: that is a
 *   split the moderator can see and this approve would claim to end.
 *
 * Known, accepted limitation of the no-decision case: a stamp this role cannot see stays in
 * place, and takes effect again if SELECT is later granted. A stamp can only exist unseen if it
 * was written by another role, or by this one before it lost SELECT.
 */
export async function assertListingMediaSplitDecisionApplicable(
  db: Pick<RawClient, '$queryRaw'>,
  args: {
    appListingId: string;
    face: ListingFace;
    decision: ListingMediaSplitDecision | null | undefined;
  },
  access?: ListingMediaSplitTableAccess
): Promise<void> {
  const a = access ?? (await probeListingMediaSplitTable(db));
  if (args.decision === 'split') {
    if (!a.present) throw refuse(MEDIA_SPLIT_UNAVAILABLE_MESSAGE);
    if (!(a.select && a.insert && a.update)) throw refuse(MEDIA_SPLIT_NOT_WRITABLE_MESSAGE);
    if (!(await isListingFaceComEligible(db, args.face)))
      throw refuse(MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE);
    return;
  }
  if (!a.present) return;
  if (!a.select) {
    if (args.decision == null) return;
    throw refuse(MEDIA_SPLIT_NOT_WRITABLE_MESSAGE);
  }
  if (!a.update && (await readStamped(db, args.appListingId)))
    throw refuse(MEDIA_SPLIT_NOT_WRITABLE_MESSAGE);
}

/**
 * Record a moderator's go-live decision on `appListingId` and return whether the listing is
 * split afterwards. `split` stamps the decision with its actor; `rate-mature` and an omitted
 * decision both clear any earlier stamp (default-closed). The review UI always sends an explicit
 * value, preselecting `split` only for a listing that is already split, so re-approving it stamps
 * the moderator who kept it. Refused, before any write, exactly when
 * {@link assertListingMediaSplitDecisionApplicable} refuses.
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
  const access = await probeListingMediaSplitTable(db);
  await assertListingMediaSplitDecisionApplicable(db, args, access);
  if (args.decision !== 'split') {
    // Without UPDATE the assertion has established the listing is not stamped; without SELECT
    // (only reachable with no decision) there is nothing this role can see to clear. Either way
    // the UPDATE is not issued: its WHERE needs SELECT, its SET needs UPDATE, and a failed
    // statement aborts the caller's transaction even when it matches no row.
    if (access.select && access.update)
      await db.$executeRaw`
        UPDATE app_listing_red_media
        SET media_split_approved_at = NULL, media_split_approved_by = NULL, updated_at = now()
        WHERE app_listing_id = ${args.appListingId} AND media_split_approved_at IS NOT NULL
      `;
    return false;
  }
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
