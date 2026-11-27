/**
 * Staff platform updates: which ones no approved version has SHIPPED yet, and marking them shipped.
 * What the submit and approve checks read and write (`platform-update-bundle-check.ts`), over the
 * columns of migration `20271206120000_app_platform_updates_shipped` (applied by hand).
 *
 * Kept apart from `app-platform-update.service.ts` on purpose: the submit and approve paths load
 * this, and it imports nothing that leads back into them (`no-import-cycle-growth.test.ts`).
 */
import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { isMissingTableError } from '~/server/services/blocks/missing-table-error';
import type { PlatformUpdatePath } from '~/server/services/blocks/app-platform-update.service';

/**
 * The update's author is Civitai staff NOW: a moderator, not banned, not deleted. The only source
 * of "verified staff" (`ownerView` in `app-platform-update.service.ts` reads it too).
 */
export function isVerifiedStaff(row: {
  staffIsModerator: boolean | null;
  staffBannedAt: Date | null;
  staffDeletedAt: Date | null;
}): boolean {
  return row.staffIsModerator === true && !row.staffBannedAt && !row.staffDeletedAt;
}

/** A missing column: the `shipped` migration is not applied yet (Postgres 42703). */
function isMissingColumnError(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (e?.code === '42703' || e?.meta?.code === '42703') return true;
  return typeof e?.message === 'string' && /\bcolumn\b.*\bdoes not exist\b/i.test(e.message);
}

/** An update every submit of the app must carry, until a version that contains it is approved. */
export type UnshippedPlatformUpdate = {
  id: string;
  slug: string;
  reason: string;
  commitSha: string;
  baseCommitSha: string;
  paths: PlatformUpdatePath[];
  /** The staff account's username now; `null` when it no longer exists. */
  by: string | null;
};

/**
 * The most unshipped updates one check reads: the OLDEST (they have waited longest), and the
 * check says `truncated` past it (`platform-update-bundle-check.ts`).
 */
export const PLATFORM_UPDATE_CHECK_CAP = 100;

/** The oldest unshipped updates, at most the cap; `truncated` when the app has more. */
export type UnshippedPlatformUpdates = { updates: UnshippedPlatformUpdate[]; truncated: boolean };

type UnshippedRow = {
  id: string;
  slug: string;
  reason: string;
  commitSha: string;
  baseCommitSha: string;
  paths: unknown;
  staffUsername: string | null;
  staffIsModerator: boolean | null;
  staffBannedAt: Date | null;
  staffDeletedAt: Date | null;
};

/**
 * The app's updates no approved version has shipped yet, oldest first: every status but
 * `superseded` (`merged` included: a client's report is not proof the bundle holds it), and only
 * those whose author is staff now ({@link isVerifiedStaff}), the updates a client is offered to
 * merge. ONE query, on the primary (an update pushed moments ago counts). At most
 * `PLATFORM_UPDATE_CHECK_CAP` rows, the oldest (the longest unshipped); one more is read only to
 * say `truncated`. `null` when the table or the `shipped` columns are missing: the check is off.
 */
export async function listUnshippedPlatformUpdates(
  appBlockId: string
): Promise<UnshippedPlatformUpdates | null> {
  let rows: UnshippedRow[];
  try {
    rows = (await dbWrite.$queryRaw(
      Prisma.sql`SELECT u."id", u."slug", u."reason", u."commit_sha" AS "commitSha",
          u."base_commit_sha" AS "baseCommitSha", u."paths",
          s."username" AS "staffUsername", s."isModerator" AS "staffIsModerator",
          s."bannedAt" AS "staffBannedAt", s."deletedAt" AS "staffDeletedAt"
        FROM "app_platform_updates" u LEFT JOIN "User" s ON s."id" = u."staff_user_id"
        WHERE u."app_block_id" = ${appBlockId}
          AND u."status" <> 'superseded'
          AND u."shipped_in_publish_request_id" IS NULL
        ORDER BY u."created_at" ASC, u."id" ASC LIMIT ${PLATFORM_UPDATE_CHECK_CAP + 1}`
    )) as UnshippedRow[];
  } catch (err) {
    if (isMissingTableError(err) || isMissingColumnError(err)) return null;
    throw err;
  }
  const truncated = rows.length > PLATFORM_UPDATE_CHECK_CAP;
  const updates = rows.slice(0, PLATFORM_UPDATE_CHECK_CAP).flatMap((row) =>
    isVerifiedStaff(row)
      ? [
          {
            id: row.id,
            slug: row.slug,
            reason: row.reason,
            commitSha: row.commitSha,
            baseCommitSha: row.baseCommitSha,
            paths: Array.isArray(row.paths) ? (row.paths as PlatformUpdatePath[]) : [],
            by: row.staffUsername ?? null,
          },
        ]
      : []
  );
  return { updates, truncated };
}

/**
 * Marks `ids` shipped by the approved request `publishRequestId`. An update already shipped keeps
 * the request that shipped it first. Returns how many rows changed.
 */
export async function markPlatformUpdatesShipped(
  ids: string[],
  publishRequestId: string
): Promise<number> {
  if (!ids.length) return 0;
  const changed = Number(
    await dbWrite.$executeRaw`UPDATE "app_platform_updates"
        SET "shipped_in_publish_request_id" = ${publishRequestId}, "shipped_at" = now(),
            "updated_at" = now()
      WHERE "id" = ANY(${ids}) AND "shipped_in_publish_request_id" IS NULL`
  );
  logToAxiom(
    {
      name: 'app-platform-update',
      type: 'info',
      message: 'shipped',
      updateIds: ids,
      publishRequestId,
      changed,
    },
    'webhooks'
  );
  return changed;
}
