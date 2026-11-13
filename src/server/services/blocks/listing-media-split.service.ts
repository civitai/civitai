import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import {
  isModerationFlagSet,
  type ListingMediaImage,
} from '~/server/services/blocks/listing-media-audience';
import { RED_SLOTS_UNAVAILABLE_MESSAGE } from '~/shared/constants/listing-media-split.constants';
import {
  isComEligibleLevel,
  type ListingMediaSplitDecision,
} from '~/shared/utils/listing-media-split';

/**
 * Reads and writes a listing's media-split decision (`~/shared/utils/listing-media-split`) and
 * its civitai.red icon / cover overrides (the second section below), both stored in
 * `app_listing_red_media`.
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
  /**
   * The civitai.red icon / cover columns (`red_icon_id`, `red_cover_id`) both exist — a second,
   * later manual migration than the table itself, so the table can be present without them.
   */
  redSlots: boolean;
};

/**
 * Probe the split table, its civitai.red slot columns and the current role's privileges on it,
 * in one statement that cannot fail: `has_table_privilege` is strict, so with the table absent
 * (`to_regclass` NULL) every privilege reads NULL, coalesced to `false`; and `pg_attribute`
 * (readable by every role) matches no row for a NULL relation, so the column count is 0.
 */
export async function probeListingMediaSplitTable(
  db: Pick<RawClient, '$queryRaw'>
): Promise<ListingMediaSplitTableAccess> {
  const rows = await db.$queryRaw<
    {
      present: boolean;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      red_slots: boolean;
    }[]
  >`
    SELECT t IS NOT NULL AS present,
           COALESCE(has_table_privilege(t, 'SELECT'), false) AS can_select,
           COALESCE(has_table_privilege(t, 'INSERT'), false) AS can_insert,
           COALESCE(has_table_privilege(t, 'UPDATE'), false) AS can_update,
           (SELECT count(*) FROM pg_attribute a
             WHERE a.attrelid = t AND NOT a.attisdropped
               AND a.attname IN ('red_icon_id', 'red_cover_id')) = 2 AS red_slots
    FROM (SELECT to_regclass('app_listing_red_media') AS t) AS probe
  `;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const present = row?.present === true;
  return {
    present,
    select: present && row?.can_select === true,
    insert: present && row?.can_insert === true,
    update: present && row?.can_update === true,
    redSlots: present && row?.red_slots === true,
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
 * split afterwards. `split` stamps the decision with its actor. `rate-mature` clears any earlier
 * stamp. An omitted decision clears it only when this role may SELECT and UPDATE the table; when
 * it may not SELECT it, nothing is issued against the table, any stamp stays in place, and the
 * listing reads as unsplit. The review UI sends an explicit value when it can read the split
 * (preselecting `split` only for a listing that is already split, so re-approving it stamps the
 * moderator who kept it), and omits the decision when it reads the split as unreadable
 * (`mediaSplitApproved: null`). Refused, before any write, exactly when
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

// ---------------------------------------------------------------------------
// The civitai.red icon / cover OVERRIDE SLOTS (`red_icon_id`, `red_cover_id`).
//
// Optional per-listing images shown INSTEAD of the listing's own icon / cover on a red-capable
// host only, each gated per image by the store rule (`listing-media-audience`); anywhere else,
// and whenever the slot is empty or its image may not be shown to the viewer, the listing's own
// icon / cover is used. They live in this table (not on `app_listings`) so a non-red request
// never reads them: the store reads them only for a red-capable host.
//
// The columns arrive by a SECOND manual migration, so every statement is preceded by the probe
// ({@link probeListingMediaSplitTable} `redSlots`): while they are absent every read is "no
// slots" and a write is refused with {@link RED_SLOTS_UNAVAILABLE_MESSAGE} before anything is
// issued. A read also needs SELECT on the table (as the split's own read does): the read client's
// role may not have it, and the store then shows the listing's own icon and cover. An owner's
// slot write and a revision apply are not probed for INSERT / UPDATE: the role that writes the
// table must hold all three (the migration's GRANTS step). The one exception is the clone a
// revision open runs ({@link cloneListingRedSlots}): it runs for every listing, so without INSERT
// and UPDATE it is skipped rather than allowed to fail the open, or to stage a row the approve
// could not apply.
// ---------------------------------------------------------------------------

/** One of the two override slots. */
export type ListingRedSlot = 'icon' | 'cover';

export type ListingRedSlotIds = { redIconId: number | null; redCoverId: number | null };

/**
 * A listing's slots as this role reads them; `available: false` = the columns cannot be read.
 * `staged` = the listing HAS an overrides row. For a revision that is the difference between
 * "staged no change" (no row: the apply leaves the live overrides alone) and "staged both slots
 * empty" (a row of nulls: the apply clears them) — `applyRevisionRedSlots`.
 */
export type ListingRedSlotsRead = ListingRedSlotIds & { available: boolean; staged: boolean };

const NO_RED_SLOTS_READ: ListingRedSlotsRead = Object.freeze({
  available: false,
  staged: false,
  redIconId: null,
  redCoverId: null,
});

export { RED_SLOTS_UNAVAILABLE_MESSAGE };

const canReadRedSlots = (a: ListingMediaSplitTableAccess) => a.present && a.redSlots && a.select;

const asImageId = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;

async function readSlotRow(
  db: Pick<RawClient, '$queryRaw'>,
  appListingId: string
): Promise<ListingRedSlotIds | null> {
  const rows = await db.$queryRaw<{ red_icon_id: number | null; red_cover_id: number | null }[]>`
    SELECT red_icon_id, red_cover_id
    FROM app_listing_red_media
    WHERE app_listing_id = ${appListingId}
  `;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  return { redIconId: asImageId(row.red_icon_id), redCoverId: asImageId(row.red_cover_id) };
}

/**
 * `appListingId`'s two override slots. Both `null`, with `available: false`, while the columns
 * are absent or this role may not read the table — the listing then has no civitai.red icon or
 * cover, exactly as before the slots existed.
 */
export async function readListingRedSlots(
  db: Pick<RawClient, '$queryRaw'>,
  appListingId: string
): Promise<ListingRedSlotsRead> {
  const access = await probeListingMediaSplitTable(db);
  if (!canReadRedSlots(access)) return NO_RED_SLOTS_READ;
  const row = await readSlotRow(db, appListingId);
  return {
    available: true,
    staged: row != null,
    redIconId: row?.redIconId ?? null,
    redCoverId: row?.redCoverId ?? null,
  };
}

/**
 * One filled override slot with its image's current level and scan state (absent image: null),
 * marked `redSlot` — the mark `ratingFloorAssets` reads, so every rating floor can take these
 * rows as they come.
 */
export type ListingRedSlotAsset = {
  slot: ListingRedSlot;
  imageId: number;
  nsfwLevel: number | null;
  ingestion: string | null;
  redSlot: true;
};

/**
 * The FILLED override slots of `appListingId` with each image's level and scan state — what the
 * rating floors read, every one of them through this function. Empty while the slots cannot be
 * read. Marked as red slots (`ratingFloorAssets`): without a moderator's split they floor the
 * rating like any other image; with one, never.
 */
export async function readListingRedSlotAssets(
  db: Pick<RawClient, '$queryRaw'>,
  appListingId: string
): Promise<ListingRedSlotAsset[]> {
  const access = await probeListingMediaSplitTable(db);
  if (!canReadRedSlots(access)) return [];
  const rows = await db.$queryRaw<
    { slot: string; image_id: number; nsfw_level: number | null; ingestion: string | null }[]
  >`
    SELECT s.slot, s.image_id, i."nsfwLevel" AS nsfw_level, i.ingestion::text AS ingestion
    FROM (
      SELECT 'icon' AS slot, red_icon_id AS image_id
        FROM app_listing_red_media WHERE app_listing_id = ${appListingId}
      UNION ALL
      SELECT 'cover' AS slot, red_cover_id AS image_id
        FROM app_listing_red_media WHERE app_listing_id = ${appListingId}
    ) AS s
    LEFT JOIN "Image" i ON i.id = s.image_id
    WHERE s.image_id IS NOT NULL
    ORDER BY s.slot DESC
  `;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const imageId = asImageId(r.image_id);
    if (imageId == null || (r.slot !== 'icon' && r.slot !== 'cover')) return [];
    return [
      {
        slot: r.slot,
        imageId,
        nsfwLevel: r.nsfw_level ?? null,
        ingestion: r.ingestion ?? null,
        redSlot: true as const,
      },
    ];
  });
}

/**
 * Every listing whose override slot holds `imageId` — live listings, drafts and revision shadows
 * alike: the table carries no status, so this does not filter. A moderator's re-rate of that image
 * passes them to `reDeriveListingRatingInTx`, which skips any that is not a live, non-shadow
 * listing. Empty while the slots cannot be read.
 */
export async function listListingIdsWithRedSlotImage(
  db: Pick<RawClient, '$queryRaw'>,
  imageId: number
): Promise<string[]> {
  const access = await probeListingMediaSplitTable(db);
  if (!canReadRedSlots(access)) return [];
  const rows = await db.$queryRaw<{ app_listing_id: string }[]>`
    SELECT app_listing_id
    FROM app_listing_red_media
    WHERE red_icon_id = ${imageId} OR red_cover_id = ${imageId}
  `;
  return Array.isArray(rows) ? rows.map((r) => r.app_listing_id) : [];
}

/** An override slot's image with the columns the store gate reads, plus its id. */
export type ListingRedMediaImage = ListingMediaImage & { id: number };
export type ListingRedMediaImages = {
  icon: ListingRedMediaImage | null;
  cover: ListingRedMediaImage | null;
};

type RedMediaRenderRow = { app_listing_id: string; slot: string } & Record<string, unknown>;

function redMediaImageFromRow(row: RedMediaRenderRow): ListingRedMediaImage | null {
  const id = asImageId(row.image_id);
  // A LEFT JOIN miss (the image is gone) has no ingestion: nothing to show.
  if (id == null || typeof row.url !== 'string' || row.ingestion == null) return null;
  return {
    id,
    url: row.url,
    nsfwLevel: typeof row.nsfw_level === 'number' ? row.nsfw_level : 0,
    ingestion: String(row.ingestion),
    needsReview: typeof row.needs_review === 'string' ? row.needs_review : null,
    poi: isModerationFlagSet(row.poi),
    minor: isModerationFlagSet(row.minor),
    tosViolation: isModerationFlagSet(row.tos_violation),
    acceptableMinor: isModerationFlagSet(row.acceptable_minor),
    blockedFor: typeof row.blocked_for === 'string' ? row.blocked_for : null,
  };
}

/**
 * The override slots of a page of listings, each image with the columns the store gate reads
 * (`listingMediaImageSelect`), keyed by listing id. Listings without a filled slot are absent.
 *
 * 🔴 CALL IT ONLY FOR A RED-CAPABLE REQUEST — the store and its tests pin that a non-red request
 * never reaches it — and gate every image it returns per viewer (`projectListingMedia`): a slot
 * is never shown just because it is filled.
 *
 * NEVER THROWS. It backs public store reads, which must not fail because a manual-apply column
 * or a grant is missing, so any error (outside a transaction, where it is harmless) reads as "no
 * slots", the listing's own icon and cover. Pass the READ client: without SELECT for its role the
 * store simply shows no override.
 */
export async function readListingRedMediaManyForRender(
  db: Pick<RawClient, '$queryRaw'>,
  appListingIds: readonly string[]
): Promise<Map<string, ListingRedMediaImages>> {
  const out = new Map<string, ListingRedMediaImages>();
  const ids = [...new Set(appListingIds)];
  if (ids.length === 0) return out;
  try {
    const access = await probeListingMediaSplitTable(db);
    if (!canReadRedSlots(access)) return out;
    const rows = await db.$queryRaw<RedMediaRenderRow[]>`
      SELECT s.app_listing_id, s.slot, i.id AS image_id, i.url,
             i."nsfwLevel" AS nsfw_level, i.ingestion::text AS ingestion,
             i."needsReview" AS needs_review, i.poi, i.minor,
             i."tosViolation" AS tos_violation, i."acceptableMinor" AS acceptable_minor,
             i."blockedFor" AS blocked_for
      FROM (
        SELECT app_listing_id, 'icon' AS slot, red_icon_id AS image_id
          FROM app_listing_red_media WHERE app_listing_id IN (${Prisma.join(ids)})
        UNION ALL
        SELECT app_listing_id, 'cover' AS slot, red_cover_id AS image_id
          FROM app_listing_red_media WHERE app_listing_id IN (${Prisma.join(ids)})
      ) AS s
      JOIN "Image" i ON i.id = s.image_id
    `;
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
      const image = redMediaImageFromRow(row);
      if (!image || (row.slot !== 'icon' && row.slot !== 'cover')) continue;
      const entry = out.get(row.app_listing_id) ?? { icon: null, cover: null };
      entry[row.slot] = image;
      out.set(row.app_listing_id, entry);
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[listing-media-split] civitai.red slot read failed; showing each listing’s own icon and cover: ' +
        (err instanceof Error ? err.message : String(err))
    );
    return new Map();
  }
}

/**
 * Throws the error {@link writeListingRedSlot} would refuse with, without writing anything — so a
 * caller can refuse before a side effect it would otherwise take first (opening a revision).
 */
export async function assertListingRedSlotsWritable(db: Pick<RawClient, '$queryRaw'>) {
  assertRedSlotsWritable(await probeListingMediaSplitTable(db));
}

function assertRedSlotsWritable(access: ListingMediaSplitTableAccess) {
  if (!access.present || !access.redSlots) throw refuse(RED_SLOTS_UNAVAILABLE_MESSAGE);
}

/**
 * Set (`imageId`) or clear (`null`) one override slot of `appListingId`, leaving the other slot
 * and any split decision as they are. The caller has already validated the image (owned, the
 * right format, not `Blocked`) and resolved the listing an owner's edit targets (a revision).
 *
 * Refused before anything is issued while the columns are absent
 * ({@link RED_SLOTS_UNAVAILABLE_MESSAGE}).
 *
 * Takes a KEY SHARE lock on the listing row first, so a moderator's image re-rate of this
 * listing (which locks the row `FOR UPDATE` before reading its media) never reads the slots
 * half-way through this change. Run it inside the caller's transaction for that to hold.
 */
export async function writeListingRedSlot(
  db: RawClient,
  args: { appListingId: string; slot: ListingRedSlot; imageId: number | null }
): Promise<void> {
  assertRedSlotsWritable(await probeListingMediaSplitTable(db));
  await db.$queryRaw`
    SELECT id FROM app_listings WHERE id = ${args.appListingId} FOR KEY SHARE
  `;
  if (args.slot === 'icon')
    await db.$executeRaw`
      INSERT INTO app_listing_red_media (app_listing_id, red_icon_id)
      VALUES (${args.appListingId}, ${args.imageId})
      ON CONFLICT (app_listing_id) DO UPDATE
        SET red_icon_id = EXCLUDED.red_icon_id, updated_at = now()
    `;
  else
    await db.$executeRaw`
      INSERT INTO app_listing_red_media (app_listing_id, red_cover_id)
      VALUES (${args.appListingId}, ${args.imageId})
      ON CONFLICT (app_listing_id) DO UPDATE
        SET red_cover_id = EXCLUDED.red_cover_id, updated_at = now()
    `;
}

/**
 * Carry the live listing's override slots onto the revision (shadow) being opened for it, so a
 * revision that does not touch them leaves them in place when it is applied. Copies only a row
 * with a filled slot, never the split decision (that belongs to the live listing alone).
 *
 * A no-op while the slots cannot be read, or this role may not both INSERT into and UPDATE the
 * table: the shadow then carries no slots row, which {@link applyRevisionRedSlots} reads as
 * "nothing staged" and leaves the live slots alone.
 *
 * 🔴 BOTH PROBES ARE LOAD-BEARING. INSERT: this runs on EVERY revision open, not only for a
 * listing with overrides, and PostgreSQL checks INSERT privilege before it looks for rows, so
 * without the grant even the zero-row `INSERT … SELECT` below raises "permission denied" and
 * fails the open. UPDATE: a staged row is applied back on approve by an upsert
 * (`ON CONFLICT … DO UPDATE`), which PostgreSQL refuses without UPDATE even when no row
 * conflicts. Staging a row this role cannot apply would fail that approve, so it stages none.
 */
export async function cloneListingRedSlots(
  db: RawClient,
  args: { fromListingId: string; toListingId: string }
): Promise<void> {
  const access = await probeListingMediaSplitTable(db);
  if (!canReadRedSlots(access) || !access.insert || !access.update) return;
  await db.$executeRaw`
    INSERT INTO app_listing_red_media (app_listing_id, red_icon_id, red_cover_id)
    SELECT ${args.toListingId}, red_icon_id, red_cover_id
    FROM app_listing_red_media
    WHERE app_listing_id = ${args.fromListingId}
      AND (red_icon_id IS NOT NULL OR red_cover_id IS NOT NULL)
    ON CONFLICT (app_listing_id) DO NOTHING
  `;
}

/**
 * Apply a revision's override slots to its live listing: the shadow's slots REPLACE the live
 * ones, both of them, cleared slots included (the reviewed revision is what goes live), and the
 * live listing's split decision is left as it is. Call it before the shadow is deleted (its row
 * goes with it).
 *
 * A shadow with NO slots row staged nothing — {@link cloneListingRedSlots} creates one whenever
 * the live listing had a slot, and setting or clearing a slot on the shadow creates one — so the
 * live slots are left alone.
 */
export async function applyRevisionRedSlots(
  db: RawClient,
  args: { shadowId: string; parentId: string }
): Promise<void> {
  const access = await probeListingMediaSplitTable(db);
  if (!canReadRedSlots(access)) return;
  const staged = await readSlotRow(db, args.shadowId);
  if (!staged) return;
  await db.$executeRaw`
    INSERT INTO app_listing_red_media (app_listing_id, red_icon_id, red_cover_id)
    VALUES (${args.parentId}, ${staged.redIconId}, ${staged.redCoverId})
    ON CONFLICT (app_listing_id) DO UPDATE
      SET red_icon_id = EXCLUDED.red_icon_id,
          red_cover_id = EXCLUDED.red_cover_id,
          updated_at = now()
  `;
}
