import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { keepUpdatedAt } from './infra/updated-at-plugin';

// NsfwLevel.Blocked — the browsing-level bit for blocked content. Inlined (was NsfwLevel.Blocked in the
// moderator source) so this module carries no shared-enum runtime dependency; passed as a bound param.
const NSFW_LEVEL_BLOCKED = 32;

// The reason string a moderator-block stamps into Image.blockedFor.
const BLOCKED_REASON_MODERATED = 'moderated';

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────

// The image row acceptImage reads before deciding the accept SET clause. `needsReview` drives the clause;
// `pHash`/`postId` are the fields the caller's dropped side effects use.
export function getImageForModeration(db: Kysely<DB>, imageId: number) {
  return db
    .selectFrom('Image')
    .select(['needsReview', 'pHash', 'postId'])
    .where('id', '=', imageId)
    .executeTakeFirst();
}

// The image row blockImage reads before blocking. `needsReview` drives the SET (remixSource stamp); the rest
// (pHash/blockedFor/postId/nsfwLevel/userId) are the pre-block snapshot the caller's dropped side effects use.
export function getImageForBlock(db: Kysely<DB>, imageId: number) {
  return db
    .selectFrom('Image')
    .select(['needsReview', 'pHash', 'blockedFor', 'postId', 'nsfwLevel', 'userId'])
    .where('id', '=', imageId)
    .executeTakeFirst();
}

// Just the image's postId — resolveImageAppeal reads it for the caller's visibility side effect.
export function getImagePostId(db: Kysely<DB>, imageId: number) {
  return db.selectFrom('Image').select('postId').where('id', '=', imageId).executeTakeFirst();
}

// The moderation review tags flagged on an image (accept disables + clears these).
export function getImageTagsForReview(db: Kysely<DB>, imageId: number) {
  return db
    .selectFrom('ImageTagForReview')
    .select('tagId')
    .where('imageId', '=', imageId)
    .execute();
}

// The pending Image appeal for one image (appellant + buzz txn), read BEFORE the row is closed so the
// caller's dropped refund/notify/email cascade can use them.
export function getImageAppeal(db: Kysely<DB>, imageId: number) {
  return db
    .selectFrom('Appeal')
    .select(['id', 'userId', 'buzzTransactionId'])
    .where('entityType', '=', 'Image')
    .where('entityId', '=', imageId)
    .where('status', '=', 'Pending')
    .executeTakeFirst();
}

// Snapshot the appellants (userId per image) of the pending Image appeals in `imageIds`, read BEFORE a bulk
// resolution closes the rows. Guards the empty-array case (no `IN ()`).
export async function getPendingImageAppealAppellants(
  db: Kysely<DB>,
  imageIds: number[]
): Promise<{ userId: number; imageId: number }[]> {
  if (!imageIds.length) return [];
  const rows = await db
    .selectFrom('Appeal')
    .select(['userId', 'entityId'])
    .where('entityType', '=', 'Image')
    .where('entityId', 'in', imageIds)
    .where('status', '=', 'Pending')
    .execute();
  return rows.map((r) => ({ userId: r.userId, imageId: r.entityId }));
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────────────

// ACCEPT (unblock): clear the review flag, restore visibility (Scanned), strip the rule keys from metadata,
// and — per needsReview kind — clear poi / auto-clear the minor gate for mature content / stamp scannedAt.
// `needsReview` is the value the caller read via getImageForModeration. `removeMinorFlag` force-clears the
// minor gate even for SFW. The raw jsonb `-`/`||` merges and the `CASE nsfwLevel` are preserved exactly.
// The source ran this as raw `$queryRaw` (no `@updatedAt` bump) — keepUpdatedAt preserves that.
export function setImageAccepted(
  db: Kysely<DB>,
  {
    imageId,
    needsReview,
    removeMinorFlag = false,
  }: {
    imageId: number;
    needsReview: string | null;
    removeMinorFlag?: boolean;
  }
) {
  const metadataExpr =
    needsReview === 'remixSource'
      ? sql`(COALESCE("metadata", '{}'::jsonb) - 'ruleId' - 'ruleReason') || '{"remixSourceReviewed": true}'::jsonb`
      : sql`"metadata" - 'ruleId' - 'ruleReason'`;

  return db
    .updateTable('Image')
    .set({
      needsReview: null,
      blockedFor: null,
      ingestion: 'Scanned',
      metadata: metadataExpr,
      ...(needsReview === 'poi' ? { poi: false } : {}),
      ...(needsReview === 'minor'
        ? {
            minor: removeMinorFlag
              ? false
              : sql<boolean>`CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END`,
          }
        : {}),
      ...(needsReview && ['minor', 'poi', 'newUser', 'bestiality'].includes(needsReview)
        ? { scannedAt: sql`now()` }
        : {}),
      updatedAt: keepUpdatedAt,
    })
    .where('id', '=', imageId)
    .execute();
}

// Disable + delete the moderation review tags that flagged an image (the accept path clears them).
export function deleteImageTagsForReview(db: Kysely<DB>, imageId: number) {
  return db.deleteFrom('ImageTagForReview').where('imageId', '=', imageId).execute();
}

// BLOCK (TOS): soft-hide — Blocked ingestion + Blocked nsfwLevel + blockedFor, does NOT delete the row. On a
// remixSource image also stamp remixSourceReviewed (COALESCE — metadata is usually NULL and `||`
// NULL-propagates). `updatedAt` is set because the source did.
export function setImageBlocked(
  db: Kysely<DB>,
  {
    imageId,
    needsReview,
  }: {
    imageId: number;
    needsReview: string | null;
  }
) {
  return db
    .updateTable('Image')
    .set({
      needsReview: null,
      ingestion: 'Blocked',
      nsfwLevel: NSFW_LEVEL_BLOCKED,
      blockedFor: BLOCKED_REASON_MODERATED,
      ...(needsReview === 'remixSource'
        ? {
            metadata: sql`COALESCE("metadata", '{}'::jsonb) || '{"remixSourceReviewed": true}'::jsonb`,
          }
        : {}),
    })
    .where('id', '=', imageId)
    .execute();
}

// Recompute an image's real nsfwLevel via the stored proc. Preserves the `ARRAY[...::int]` call exactly. The
// caller owns the thumbnail-cache bust that the legacy recompute paired with this.
export function recomputeImageNsfwLevel(db: Kysely<DB>, imageId: number) {
  return sql`SELECT update_nsfw_levels_new(ARRAY[${imageId}::int])`.execute(db);
}

// Approved-appeal branch: restore the image (clear review flag + blockedFor, back to Scanned). Pair with
// recomputeImageNsfwLevel in the caller.
export function setImageAppealRestored(db: Kysely<DB>, imageId: number) {
  return db
    .updateTable('Image')
    .set({ needsReview: null, blockedFor: null, ingestion: 'Scanned' })
    .where('id', '=', imageId)
    .execute();
}

// Pin an image's nsfwLevel and lock it — the moderator's manual rating verdict.
export function setImageNsfwLevel(
  db: Kysely<DB>,
  { id, nsfwLevel }: { id: number; nsfwLevel: number }
) {
  return db
    .updateTable('Image')
    .set({ nsfwLevel, nsfwLevelLocked: true })
    .where('id', '=', id)
    .execute();
}

// The boolean moderation-gate columns a moderator can flip on an Image (matches toggleImageFlagSchema).
type ImageFlagColumn = 'minor' | 'poi';

// Flip one image's `minor`/`poi` gate. The source read the current value then wrote its negation across two
// statements; this is the equivalent single atomic `SET flag = NOT flag` (also race-free). `updatedAt` is
// auto-stamped by the @updatedAt plugin (Prisma `.update` auto-bumped `@updatedAt`). The not-found throw +
// cache/search side effects are the caller's. Ported from image.service `toggleImageFlag`.
export function toggleImageFlag(
  db: Kysely<DB>,
  { id, flag }: { id: number; flag: ImageFlagColumn }
) {
  return db
    .updateTable('Image')
    .set(flag, sql<boolean>`NOT ${sql.ref(flag)}`)
    .where('id', '=', id)
    .execute();
}
