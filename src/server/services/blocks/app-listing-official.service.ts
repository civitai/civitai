/**
 * App Store listings — the moderator-set "Official" flag (`app_listings.is_official`).
 *
 * "Official" means the app is made by the Civitai team. It is a PROVENANCE claim, the listing
 * analogue of `Model.isOfficial` / `Article.isOfficial`: only a moderator sets it, through
 * {@link setListingOfficialAsModerator}, and nothing an author submits can reach it. It renders
 * a badge on the store card and the app page, and it is one gate: an Official parent's catalog
 * sync may swap an approved store item's image for one the parent's owner uploaded without
 * review (`writeSubListing` in `app-sub-listing.service.ts`). No ranking, no curation.
 *
 * 🔴 RAW SQL, AND ONLY HERE. The column is marked no-type in `schema.full.prisma`, so it is
 * stripped from the generated client and does not exist on any Prisma delegate — the same
 * posture `visibility` and `forkable` take, for the same reason: as an ordinary field, every
 * `appListing` call that returns rows without an explicit `select` would name it, and would
 * fail with P2022 until a human applies the manual migration. Stripped, nothing outside this
 * module can name it, so the deploy and the migration can land in either order. It also means
 * no author write path (the off-site submit and patch, the manifest sync, the revision apply)
 * can set it: those all write through the Prisma delegate, which has no such field.
 *
 * TWO READ POSTURES, like `app-fork.service.ts`:
 *   - {@link readListingOfficialMany} degrades ONLY on a missing column (migration not
 *     applied) and propagates everything else;
 *   - the `…ForRender` reads degrade on ANY error and log it, because a cosmetic badge must
 *     never take a store page down.
 * The moderator write does not degrade: before the migration it refuses with
 * PRECONDITION_FAILED and writes nothing.
 */

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { dbWrite } from '~/server/db/client';
import type { AppListingModerationAction } from '~/server/schema/blocks/offsite-moderation.schema';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import { noteDegradedRead } from '~/server/services/blocks/degraded-read-log';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';

/** The moderation-event action every flag change records. */
export const SET_OFFICIAL_ACTION = 'set-official' satisfies AppListingModerationAction;

/** Raw-SQL read surface, structurally typed so a replica, a primary, a transaction client and a
 *  test double over an in-process Postgres all satisfy it. Tagged-template calls only. */
export type OfficialReadClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: (query: any, ...values: any[]) => Promise<any>;
};

/** What the moderator write needs inside its transaction. */
export type OfficialWriteTx = OfficialReadClient & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRaw: (query: any, ...values: any[]) => Promise<any>;
  appListingModerationEvent: {
    create: (args: {
      data: {
        id: string;
        appListingId: string;
        slug: string;
        action: string;
        actorUserId: number;
        reason: string;
        before: { isOfficial: boolean };
        after: { isOfficial: boolean };
      };
    }) => Promise<unknown>;
  };
};

/** A client that can open the write transaction (`dbWrite`, or a test double). */
export type OfficialWriteClient = {
  $transaction: <T>(fn: (tx: OfficialWriteTx) => Promise<T>) => Promise<T>;
};

/**
 * The ids, out of `listingIds`, whose listing is marked Official. One query per page; an empty
 * input issues none.
 *
 * Degrades to an EMPTY set when the column is missing (the migration has not been applied
 * here), which reads identically to "none of these is official" — the correct inert answer.
 * Everything else propagates; use {@link readListingOfficialManyForRender} on a page.
 */
export async function readListingOfficialMany(
  listingIds: readonly string[],
  db: OfficialReadClient
): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();
  try {
    const rows = (await db.$queryRaw(
      Prisma.sql`SELECT "id", "is_official" AS "isOfficial" FROM "app_listings"
        WHERE "id" IN (${Prisma.join([...listingIds])}) AND "is_official" = true`
    )) as Array<{ id: string; isOfficial: boolean | null }>;
    // `=== true` on the row as well as in the WHERE: a row is official only when the column
    // itself says so, never because a row came back.
    return new Set(rows.filter((r) => r.isOfficial === true).map((r) => r.id));
  } catch (err) {
    if (isMissingColumnError(err)) return new Set();
    throw err;
  }
}

/** {@link readListingOfficialMany} for a RENDERING path: any error → an empty set, logged. */
export async function readListingOfficialManyForRender(
  listingIds: readonly string[],
  db: OfficialReadClient
): Promise<Set<string>> {
  try {
    return await readListingOfficialMany(listingIds, db);
  } catch (err) {
    noteDegradedRead('app-listing-official-read-degraded', err);
    return new Set();
  }
}

/** One listing, for a RENDERING path: `true` only when the column says so; any error → `false`. */
export async function readListingOfficialForRender(
  listingId: string,
  db: OfficialReadClient
): Promise<boolean> {
  return (await readListingOfficialManyForRender([listingId], db)).has(listingId);
}

/** The refusal a moderator sees before the manual migration has been applied here. Exported
 *  so the tests assert the exact string. */
export const OFFICIAL_UNAVAILABLE_MESSAGE =
  'The Official flag is not available on this environment yet. Try again after the database migration has been applied.';

/** The refusal for an id that is not a live top-level listing (missing, or a revision draft). */
export const OFFICIAL_NOT_FOUND_MESSAGE = 'App listing not found';

/** The owner-facing sentence stored in the event's `reason` (the owner's history shows it). */
export function officialChangeReason(isOfficial: boolean): string {
  return isOfficial
    ? 'Marked as an official Civitai app by a moderator.'
    : 'Official Civitai app mark removed by a moderator.';
}

export type SetListingOfficialResult = {
  appListingId: string;
  isOfficial: boolean;
  /** `false` when the flag already had the requested value: nothing was written. */
  changed: boolean;
};

/**
 * Mark or unmark one listing Official, and record a `set-official` moderation event.
 *
 * The caller is `moderatorProcedure`; this function does not re-check the role, matching the
 * other moderator procs (the router owns the role test). `moderatorUserId` is the session
 * user, never client-supplied.
 *
 * One interactive transaction: the row is read `FOR UPDATE`, written, and the event inserted,
 * so a rejected event rolls the flag back with it. Before the migration the first statement
 * raises 42703; that aborts the transaction, and it is answered with PRECONDITION_FAILED
 * before any further statement runs.
 *
 * `revision_of_id IS NULL`: the flag belongs to the LIVE listing. A shadow revision's own
 * column would be read by nothing, so a shadow id is refused as not found.
 *
 * Setting the value it already has is an idempotent success that records nothing, so the
 * owner's history does not fill with no-ops. `updated_at` is deliberately not touched: this is
 * a label a moderator applies, not a change to the app's content.
 */
export async function setListingOfficialAsModerator(
  args: { appListingId: string; isOfficial: boolean; moderatorUserId: number },
  db: OfficialWriteClient = dbWrite as unknown as OfficialWriteClient
): Promise<SetListingOfficialResult> {
  return db.$transaction(async (tx) => {
    let rows: Array<{ slug: string; isOfficial: boolean }>;
    try {
      rows = (await tx.$queryRaw`SELECT "slug", "is_official" AS "isOfficial"
          FROM "app_listings"
          WHERE "id" = ${args.appListingId} AND "revision_of_id" IS NULL
          FOR UPDATE`) as Array<{ slug: string; isOfficial: boolean }>;
    } catch (err) {
      if (isMissingColumnError(err)) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: OFFICIAL_UNAVAILABLE_MESSAGE });
      }
      throw err;
    }
    const current = rows[0];
    if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: OFFICIAL_NOT_FOUND_MESSAGE });

    const before = current.isOfficial === true;
    if (before === args.isOfficial) {
      return { appListingId: args.appListingId, isOfficial: before, changed: false };
    }

    await tx.$executeRaw`UPDATE "app_listings" SET "is_official" = ${args.isOfficial}
        WHERE "id" = ${args.appListingId} AND "revision_of_id" IS NULL`;

    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: args.appListingId,
        slug: current.slug,
        action: SET_OFFICIAL_ACTION,
        actorUserId: args.moderatorUserId,
        reason: officialChangeReason(args.isOfficial),
        before: { isOfficial: before },
        after: { isOfficial: args.isOfficial },
      },
    });

    return { appListingId: args.appListingId, isOfficial: args.isOfficial, changed: true };
  });
}
