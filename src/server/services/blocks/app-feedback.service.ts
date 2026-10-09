import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { dbRead, dbWrite } from '~/server/db/client';
import { APP_LISTING_OWNER_SQL } from '~/server/notifications/comment.notifications';
import type {
  AppFeedbackOwnerStatusFilter,
  AppFeedbackSurface,
  AppFeedbackTarget,
  CreateAppFeedbackInput,
  FlagAppFeedbackInput,
  HasAnyAppFeedbackForListingInput,
  ListAppFeedbackForListingInput,
  ModListAppFeedbackInput,
  ModSetAppFeedbackHiddenInput,
  SetAppFeedbackOwnerStatusInput,
} from '~/server/schema/app-feedback.schema';
import { APP_FEEDBACK_SURFACES } from '~/server/schema/app-feedback.schema';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { throwIfBlockedByOwners } from '~/server/services/block-check.service';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import {
  listingIdForAppBlock,
  resolveAccessibleListingIds,
  resolveListingAccess,
} from '~/server/services/blocks/app-access.service';
import { isFeedbackAreaEnabled } from '~/server/services/feedback.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { throwRateLimitError } from '~/server/utils/errorHandling';
import type { FeedbackOwnerStatus } from '~/shared/constants/feedback.constants';
import { APP_BLOCK_FEEDBACK_AREA } from '~/shared/constants/feedback.constants';
import type { StoreListingKind } from '~/shared/utils/store-visibility-scope';
import { narrowStoreScope, scopeAdmitsListingKind } from '~/shared/utils/store-visibility-scope';
import type { SessionUser } from '~/types/session';

/**
 * Private per-app feedback (`Feedback.area = 'app-block'`): a signed-in user running an App Block
 * writes to the app's developer; the listing's owner and accepted editors read it and set an owner
 * status; moderators see everything.
 *
 * 🔴 EVERY READ OF `Feedback` HERE NAMES ITS COLUMNS. A Prisma call with no `select` emits
 * `RETURNING`/`SELECT` of every scalar the model declares, so it fails outright against a database
 * that has not had a manual-apply migration yet, and it would hand the moderator-only columns to
 * an owner-facing caller.
 */

export const APP_FEEDBACK_PER_LISTING_DAILY_CAP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AppFeedbackRefusal =
  | 'muted'
  | 'flag_off'
  | 'not_found'
  | 'scope'
  | 'self'
  | 'not_approved'
  | 'blocked';

export type ResolvedAppFeedbackTarget = {
  /** Always the PARENT (seat) listing — never a shadow revision. */
  appListingId: string;
  appName: string;
  appBlockVersion: string | null;
  appBlockSha: string | null;
};

export type AppFeedbackTargetResolution =
  | { ok: true; target: ResolvedAppFeedbackTarget }
  | { ok: false; reason: AppFeedbackRefusal };

async function listingIdForTarget(target: AppFeedbackTarget): Promise<string | null> {
  if ('slug' in target) {
    const row = await dbRead.appListing.findFirst({
      where: { slug: target.slug, revisionOfId: null },
      select: { id: true },
    });
    return row?.id ?? null;
  }
  return listingIdForAppBlock(target.appBlockId);
}

/**
 * May this user send feedback about this app? The ONE predicate behind both `getEligibility` and
 * `create`, so the chrome can never offer the item where the submit would be refused.
 */
export async function resolveAppFeedbackTarget(
  user: SessionUser,
  target: AppFeedbackTarget
): Promise<AppFeedbackTargetResolution> {
  const refuse = (reason: AppFeedbackRefusal) => ({ ok: false as const, reason });

  if (user.muted) return refuse('muted');
  // First of the IO checks: it needs no listing, and while the area is dark it spares every
  // chrome dropdown the listing reads below.
  if (!(await isFeedbackAreaEnabled({ area: APP_BLOCK_FEEDBACK_AREA, user })))
    return refuse('flag_off');

  const listingId = await listingIdForTarget(target);
  if (!listingId) return refuse('not_found');
  const access = await resolveListingAccess(listingId, user.id);
  if (!access) return refuse('not_found');

  const [listing, rawScope] = await Promise.all([
    dbRead.appListing.findUnique({
      where: { id: access.seatListingId },
      select: {
        status: true,
        name: true,
        appBlock: { select: { version: true, currentVersionSha: true } },
      },
    }),
    resolveStoreVisibilityScope({ user }),
  ]);
  if (!listing) return refuse('not_found');

  // Before the owner/status checks, so a caller whose store scope hides this kind cannot tell
  // "yours", "not approved" and "does not exist" apart.
  const scope = narrowStoreScope(rawScope);
  if (!scopeAdmitsListingKind(scope, access.kind as StoreListingKind)) return refuse('scope');

  if (access.role !== null) return refuse('self');
  // 🔴 `status` ONLY — the per-listing `visibility` level (private / moderators / testers) is
  // DELIBERATELY not consulted. Operator decision, 2026-10-08: an approved app that is unlisted
  // or tester-only is still runnable by slug, and the people running it are exactly the ones
  // whose feedback its developer wants. Not an oversight; do not add a visibility gate here
  // without asking. Pinned by the "non-public visibility" test in app-feedback.service.test.ts.
  if (listing.status !== 'approved') return refuse('not_approved');

  try {
    await throwIfBlockedByOwners({
      userId: user.id,
      ownerIds: [access.ownerUserId],
      isModerator: user.isModerator,
    });
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'NOT_FOUND') return refuse('blocked');
    throw err;
  }

  const block = access.kind === 'onsite' ? listing.appBlock : null;
  return {
    ok: true,
    target: {
      appListingId: access.seatListingId,
      appName: listing.name,
      appBlockVersion: block?.version ?? null,
      appBlockSha: block?.currentVersionSha ?? null,
    },
  };
}

export async function getAppFeedbackEligibility(user: SessionUser, target: AppFeedbackTarget) {
  const resolved = await resolveAppFeedbackTarget(user, target);
  if (!resolved.ok) return { eligible: false as const };
  const { appListingId, appName, appBlockVersion } = resolved.target;
  return { eligible: true as const, appListingId, appName, appBlockVersion };
}

export const APP_FEEDBACK_NOT_FOUND_MESSAGE = 'App not found';
export const APP_FEEDBACK_SELF_MESSAGE = 'You cannot send feedback to your own app';
export const APP_FEEDBACK_FLAG_OFF_MESSAGE = 'Feedback is not being collected here right now.';
export const APP_FEEDBACK_MUTED_MESSAGE = 'Your account cannot send feedback right now';
export const APP_FEEDBACK_CAP_MESSAGE =
  'You have sent this app a lot of feedback today — give it a little while.';

/**
 * `scope`, `not_approved` and `blocked` read exactly like a missing app: the caller learns nothing
 * about a listing their scope hides, its moderation state, or a block (the comment posture).
 */
function refusalError(reason: AppFeedbackRefusal): TRPCError {
  switch (reason) {
    case 'muted':
      return new TRPCError({ code: 'FORBIDDEN', message: APP_FEEDBACK_MUTED_MESSAGE });
    case 'flag_off':
      return new TRPCError({ code: 'FORBIDDEN', message: APP_FEEDBACK_FLAG_OFF_MESSAGE });
    case 'self':
      return new TRPCError({ code: 'FORBIDDEN', message: APP_FEEDBACK_SELF_MESSAGE });
    case 'not_found':
    case 'scope':
    case 'not_approved':
    case 'blocked':
      return new TRPCError({ code: 'NOT_FOUND', message: APP_FEEDBACK_NOT_FOUND_MESSAGE });
  }
}

export const APP_FEEDBACK_BLOCKED_CONTENT_MESSAGE =
  'Your feedback includes a link or wording that is not allowed. Remove it and try again.';

export function appFeedbackBlockedLinkMessage(urls: string[]) {
  return `Your feedback links to a site that is not allowed: ${urls.join(
    ', '
  )}. Remove the link and try again.`;
}

/**
 * The comment content filter, with feedback's own refusal text. The shared filter words its
 * refusals for comments ("Comment blocked by content filter", "invalid urls: …"), which reads as a
 * bug inside an app's feedback modal, so its `onBlocked` hook supplies the wording instead:
 *
 * - a LINK hit names the blocked URL(s), handed over as data — never parsed back out of prose — so
 *   the writer can see which link to remove;
 * - a PATTERN hit gets the generic message; the hook is not given the matched text, so there is
 *   nothing to echo.
 *
 * Anything else (a DB or cache failure inside the filter) never reaches the hook and propagates
 * untouched. Moderators are exempt, as on comments.
 */
async function throwOnBlockedFeedbackContent(message: string, isModerator: boolean) {
  await throwOnBlockedCommentContent(message, {
    isModerator,
    onBlocked: (block) => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          block.kind === 'link'
            ? appFeedbackBlockedLinkMessage(block.urls)
            : APP_FEEDBACK_BLOCKED_CONTENT_MESSAGE,
      });
    },
  });
}

export async function createAppFeedback({
  user,
  input,
}: {
  user: SessionUser;
  input: CreateAppFeedbackInput;
}) {
  const resolved = await resolveAppFeedbackTarget(user, input.target);
  if (!resolved.ok) throw refusalError(resolved.reason);
  const { appListingId, appBlockVersion, appBlockSha } = resolved.target;

  await throwOnBlockedFeedbackContent(input.message, !!user.isModerator);

  // Primary: the counted rows are this user's own, written moments ago. Count-then-insert is not
  // atomic; the procedure's per-user rateLimit bounds the overshoot (moderators skip it).
  const recent = await dbWrite.feedback.count({
    where: {
      userId: user.id,
      area: APP_BLOCK_FEEDBACK_AREA,
      appListingId,
      createdAt: { gt: new Date(Date.now() - DAY_MS) },
    },
  });
  if (recent >= APP_FEEDBACK_PER_LISTING_DAILY_CAP) throwRateLimitError(APP_FEEDBACK_CAP_MESSAGE);

  return dbWrite.feedback.create({
    data: {
      userId: user.id,
      area: APP_BLOCK_FEEDBACK_AREA,
      message: input.message,
      context: input.context as Prisma.InputJsonObject,
      appListingId,
      appBlockVersion,
      appBlockSha,
    },
    select: { id: true },
  });
}

export const APP_FEEDBACK_NO_ACCESS_MESSAGE = "You do not have access to this app's feedback";
export const APP_FEEDBACK_STALE_MESSAGE = 'This feedback has changed — refresh and try again.';

/**
 * The seat listing whose inbox this caller may read, or a refusal. A missing listing and a caller
 * with no role get the SAME error, so this is not an existence oracle over listing ids.
 */
async function resolveInboxListingId(
  appListingId: string,
  userId: number,
  db: typeof dbRead = dbRead
): Promise<string> {
  const access = await resolveListingAccess(appListingId, userId, db);
  if (!access || (access.role !== 'owner' && access.role !== 'editor'))
    throw new TRPCError({ code: 'FORBIDDEN', message: APP_FEEDBACK_NO_ACCESS_MESSAGE });
  return access.seatListingId;
}

/**
 * Which rows an owner may see or act on: this listing's app feedback, minus rows a moderator hid
 * and rows from a reporter who has since been banned. The write paths use the same predicate, so
 * an owner can never change a row they cannot see.
 */
export function ownerVisibleWhere(seatListingId: string): Prisma.FeedbackWhereInput {
  return {
    area: APP_BLOCK_FEEDBACK_AREA,
    appListingId: seatListingId,
    hiddenFromOwnerAt: null,
    user: { bannedAt: null },
  };
}

/** The SQL twin of {@link ownerVisibleWhere} for the raw reads; `f` = Feedback, `u` = reporter. */
function ownerVisibleSql(seatListingIds: string[]): Prisma.Sql[] {
  return [
    Prisma.sql`f.area = ${APP_BLOCK_FEEDBACK_AREA}`,
    Prisma.sql`f."appListingId" IN (${Prisma.join(seatListingIds)})`,
    Prisma.sql`f."hiddenFromOwnerAt" IS NULL`,
    Prisma.sql`u."bannedAt" IS NULL`,
  ];
}

/**
 * Keyset continuation for `ORDER BY "createdAt" DESC, id DESC`, keyed by the last row's id. The
 * cursor row is looked up only among app feedback (and, for an owner, only their own listing's),
 * so a probed id says nothing about anyone else's rows.
 */
function cursorSql(cursor: number | undefined, seatListingId?: string): Prisma.Sql[] {
  if (!cursor) return [];
  const listing = seatListingId
    ? Prisma.sql` AND c."appListingId" = ${seatListingId}`
    : Prisma.empty;
  return [
    Prisma.sql`(f."createdAt", f.id) < (SELECT c."createdAt", c.id FROM "Feedback" c WHERE c.id = ${cursor} AND c.area = ${APP_BLOCK_FEEDBACK_AREA}${listing})`,
  ];
}

function ownerStatusSql(filter: AppFeedbackOwnerStatusFilter | undefined): Prisma.Sql[] {
  if (!filter) return [];
  if (filter === 'new') return [Prisma.sql`f."ownerStatus" IS NULL`];
  return [Prisma.sql`f."ownerStatus" = ${filter}`];
}

export type OwnerFeedbackRow = {
  id: number;
  message: string;
  createdAt: Date;
  appBlockVersion: string | null;
  appBlockSha: string | null;
  surface: string | null;
  ownerStatus: string | null;
  ownerStatusAt: Date | null;
  ownerFlaggedAt: Date | null;
  reporterId: number;
  reporterUsername: string | null;
};

export type OwnerFeedbackDto = {
  id: number;
  message: string;
  createdAt: Date;
  reporter: { id: number; username: string | null };
  appBlockVersion: string | null;
  appBlockSha: string | null;
  surface: AppFeedbackSurface | null;
  ownerStatus: FeedbackOwnerStatus | null;
  ownerStatusAt: Date | null;
  ownerFlaggedAt: Date | null;
};

function isSurface(value: unknown): value is AppFeedbackSurface {
  return typeof value === 'string' && (APP_FEEDBACK_SURFACES as readonly string[]).includes(value);
}

/**
 * The owner-facing projection, built key by key from a row rather than spread from it, so a
 * column added to the query later does not reach an owner unless it is added here too.
 */
export function toOwnerFeedbackDto(row: OwnerFeedbackRow): OwnerFeedbackDto {
  return {
    id: row.id,
    message: row.message,
    createdAt: row.createdAt,
    reporter: { id: row.reporterId, username: row.reporterUsername },
    appBlockVersion: row.appBlockVersion,
    appBlockSha: row.appBlockSha,
    // `context` is a client claim; only a value from the closed set is shown, never used for authz.
    surface: isSurface(row.surface) ? row.surface : null,
    ownerStatus: row.ownerStatus as FeedbackOwnerStatus | null,
    ownerStatusAt: row.ownerStatusAt,
    ownerFlaggedAt: row.ownerFlaggedAt,
  };
}

export async function listAppFeedbackForListing({
  userId,
  input,
}: {
  userId: number;
  input: ListAppFeedbackForListingInput;
}): Promise<{ items: OwnerFeedbackDto[]; nextCursor: number | undefined }> {
  const seatListingId = await resolveInboxListingId(input.appListingId, userId);
  const conditions = [
    ...ownerVisibleSql([seatListingId]),
    ...ownerStatusSql(input.ownerStatus),
    ...cursorSql(input.cursor, seatListingId),
  ];
  const rows = await dbRead.$queryRaw<OwnerFeedbackRow[]>(Prisma.sql`
    SELECT
      f.id,
      f.message,
      f."createdAt",
      f."appBlockVersion",
      f."appBlockSha",
      f.context->>'surface' AS surface,
      f."ownerStatus",
      f."ownerStatusAt",
      f."ownerFlaggedAt",
      u.id AS "reporterId",
      u.username AS "reporterUsername"
    FROM "Feedback" f
    JOIN "User" u ON u.id = f."userId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY f."createdAt" DESC, f.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = rows.slice(0, input.limit);
  return {
    items: page.map(toOwnerFeedbackDto),
    nextCursor: rows.length > input.limit ? page[page.length - 1].id : undefined,
  };
}

/**
 * Does this listing have ANY row its owner may see? Decides whether the editor offers a Feedback
 * tab at all (operator decision, 2026-10-09: no tab, and no empty inbox, until the first row).
 *
 * Same authorization as {@link listAppFeedbackForListing} (`resolveInboxListingId`, so a caller
 * with no role gets the same FORBIDDEN and learns nothing about the listing) and the same
 * visibility predicate ({@link ownerVisibleSql}), so the tab appears exactly when the list it
 * opens would return a row. `EXISTS` stops at the first match.
 */
export async function hasAnyAppFeedbackForListing({
  userId,
  input,
}: {
  userId: number;
  input: HasAnyAppFeedbackForListingInput;
}): Promise<{ hasAny: boolean }> {
  const seatListingId = await resolveInboxListingId(input.appListingId, userId);
  const rows = await dbRead.$queryRaw<Array<{ hasAny: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "Feedback" f
      JOIN "User" u ON u.id = f."userId"
      WHERE ${Prisma.join(ownerVisibleSql([seatListingId]), ' AND ')}
    ) AS "hasAny"
  `);
  return { hasAny: rows[0]?.hasAny === true };
}

export async function setAppFeedbackOwnerStatus({
  userId,
  input,
}: {
  userId: number;
  input: SetAppFeedbackOwnerStatusInput;
}) {
  // The primary: a seat revoked a moment ago must not still pass on a lagging replica.
  const seatListingId = await resolveInboxListingId(input.appListingId, userId, dbWrite);
  const { count } = await dbWrite.feedback.updateMany({
    where: {
      ...ownerVisibleWhere(seatListingId),
      id: input.id,
      ownerStatus: input.expectedOwnerStatus,
    },
    data: { ownerStatus: input.ownerStatus, ownerStatusAt: new Date(), ownerStatusById: userId },
  });
  if (count === 0) throw new TRPCError({ code: 'CONFLICT', message: APP_FEEDBACK_STALE_MESSAGE });
  return { id: input.id, ownerStatus: input.ownerStatus };
}

export async function flagAppFeedbackAbusive({
  userId,
  input,
}: {
  userId: number;
  input: FlagAppFeedbackInput;
}) {
  const seatListingId = await resolveInboxListingId(input.appListingId, userId, dbWrite);
  const { count } = await dbWrite.feedback.updateMany({
    where: { ...ownerVisibleWhere(seatListingId), id: input.id, ownerFlaggedAt: null },
    data: { ownerFlaggedAt: new Date() },
  });
  if (count === 0) throw new TRPCError({ code: 'CONFLICT', message: APP_FEEDBACK_STALE_MESSAGE });
  return { id: input.id };
}

/** `{ [appListingId]: count }` of rows still new to the developer, for every listing they can read. */
export async function countNewAppFeedbackForMyListings(
  userId: number
): Promise<Record<string, number>> {
  const { allIds } = await resolveAccessibleListingIds(userId);
  if (!allIds.length) return {};
  const rows = await dbRead.$queryRaw<Array<{ appListingId: string; count: number }>>(Prisma.sql`
    SELECT f."appListingId", COUNT(*)::int AS count
    FROM "Feedback" f
    JOIN "User" u ON u.id = f."userId"
    WHERE ${Prisma.join([...ownerVisibleSql(allIds), ...ownerStatusSql('new')], ' AND ')}
    GROUP BY f."appListingId"
  `);
  return Object.fromEntries(rows.map((r) => [r.appListingId, r.count]));
}

/** The moderator list's filters as SQL; `f` = Feedback. Every filter is optional and AND-ed. */
export function modListConditions(
  input: Omit<ModListAppFeedbackInput, 'limit' | 'cursor'>
): Prisma.Sql[] {
  const conditions = [Prisma.sql`f.area = ${APP_BLOCK_FEEDBACK_AREA}`];
  if (input.listingDeleted) conditions.push(Prisma.sql`f."appListingId" IS NULL`);
  if (input.appListingId) conditions.push(Prisma.sql`f."appListingId" = ${input.appListingId}`);
  conditions.push(...ownerStatusSql(input.ownerStatus));
  if (input.flagged) conditions.push(Prisma.sql`f."ownerFlaggedAt" IS NOT NULL`);
  if (input.hidden === 'hidden') conditions.push(Prisma.sql`f."hiddenFromOwnerAt" IS NOT NULL`);
  if (input.hidden === 'visible') conditions.push(Prisma.sql`f."hiddenFromOwnerAt" IS NULL`);
  return conditions;
}

type ModFeedbackRow = {
  id: number;
  message: string;
  createdAt: Date;
  context: unknown;
  status: string;
  triageNote: string | null;
  appListingId: string | null;
  appBlockVersion: string | null;
  appBlockSha: string | null;
  ownerStatus: string | null;
  ownerStatusAt: Date | null;
  ownerStatusById: number | null;
  ownerStatusByUsername: string | null;
  ownerFlaggedAt: Date | null;
  hiddenFromOwnerAt: Date | null;
  hiddenByModeratorId: number | null;
  hiddenByModeratorUsername: string | null;
  reporterId: number;
  reporterUsername: string | null;
  reporterBanned: boolean;
  reporterMuted: boolean;
  appName: string | null;
  appSlug: string | null;
  appKind: string | null;
  appOwnerId: number | null;
  appOwnerUsername: string | null;
};

function readContext(context: unknown): {
  surface: AppFeedbackSurface | null;
  modelId: number | null;
} {
  const ctx = (context ?? {}) as { surface?: unknown; modelId?: unknown };
  return {
    surface: isSurface(ctx.surface) ? ctx.surface : null,
    modelId: typeof ctx.modelId === 'number' && Number.isInteger(ctx.modelId) ? ctx.modelId : null,
  };
}

export async function modListAppFeedback(input: ModListAppFeedbackInput) {
  const conditions = [...modListConditions(input), ...cursorSql(input.cursor)];
  // The PRIMARY, not a replica: the moderator tab refetches this right after a hide/unhide and must
  // read its own write. Moderator-only, over a small table.
  // LEFT joins from the listing on, so a row whose listing was deleted still lists.
  const rows = await dbWrite.$queryRaw<ModFeedbackRow[]>(Prisma.sql`
    SELECT
      f.id,
      f.message,
      f."createdAt",
      f.context,
      f.status,
      f."triageNote",
      f."appListingId",
      f."appBlockVersion",
      f."appBlockSha",
      f."ownerStatus",
      f."ownerStatusAt",
      f."ownerStatusById",
      s.username AS "ownerStatusByUsername",
      f."ownerFlaggedAt",
      f."hiddenFromOwnerAt",
      hid."userId" AS "hiddenByModeratorId",
      h.username AS "hiddenByModeratorUsername",
      r.id AS "reporterId",
      r.username AS "reporterUsername",
      (r."bannedAt" IS NOT NULL) AS "reporterBanned",
      r.muted AS "reporterMuted",
      al.name AS "appName",
      al.slug AS "appSlug",
      al.kind AS "appKind",
      ${Prisma.raw(APP_LISTING_OWNER_SQL)} AS "appOwnerId",
      ou.username AS "appOwnerUsername"
    FROM "Feedback" f
    JOIN "User" r ON r.id = f."userId"
    LEFT JOIN "User" s ON s.id = f."ownerStatusById"
    -- Who hid it lives only in the audit log; the latest hide, shown while the row is hidden.
    LEFT JOIN LATERAL (
      SELECT ma."userId" FROM "ModActivity" ma
      WHERE ma."entityType" = 'feedback' AND ma."entityId" = f.id AND ma.activity = 'hideFromOwner'
        AND f."hiddenFromOwnerAt" IS NOT NULL
      ORDER BY ma."createdAt" DESC, ma.id DESC
      LIMIT 1
    ) hid ON true
    LEFT JOIN "User" h ON h.id = hid."userId"
    LEFT JOIN "app_listings" al ON al.id = f."appListingId"
    LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"
    LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"
    LEFT JOIN "User" ou ON ou.id = ${Prisma.raw(APP_LISTING_OWNER_SQL)}
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY f."createdAt" DESC, f.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = rows.slice(0, input.limit);
  return {
    items: page.map(({ context, ...row }) => ({ ...row, ...readContext(context) })),
    nextCursor: rows.length > input.limit ? page[page.length - 1].id : undefined,
  };
}

/**
 * The tab badge: reports a developer flagged that no moderator has hidden yet. The primary, for the
 * same read-your-writes reason as `modListAppFeedback` — a hide changes this count.
 */
export async function modCountFlaggedAppFeedback(): Promise<number> {
  return dbWrite.feedback.count({
    where: {
      area: APP_BLOCK_FEEDBACK_AREA,
      ownerFlaggedAt: { not: null },
      hiddenFromOwnerAt: null,
    },
  });
}

/**
 * Hide a report from the developer, or unhide it. Scoped on the current state, so a double-click
 * or a second moderator gets a refusal instead of a silent re-stamp. The ModActivity row is the
 * ONLY record of which moderator acted, so it is written in the same transaction as the hide.
 */
export async function modSetAppFeedbackHidden({
  moderatorId,
  input,
}: {
  moderatorId: number;
  input: ModSetAppFeedbackHiddenInput;
}) {
  return dbWrite.$transaction(async (tx) => {
    const { count } = await tx.feedback.updateMany({
      where: {
        id: input.id,
        area: APP_BLOCK_FEEDBACK_AREA,
        hiddenFromOwnerAt: input.hidden ? null : { not: null },
      },
      data: { hiddenFromOwnerAt: input.hidden ? new Date() : null },
    });
    if (count === 0) throw new TRPCError({ code: 'CONFLICT', message: APP_FEEDBACK_STALE_MESSAGE });
    await trackModActivity(
      moderatorId,
      {
        entityType: 'feedback',
        activity: input.hidden ? 'hideFromOwner' : 'unhideFromOwner',
        entityId: input.id,
      },
      tx
    );
    return { id: input.id, hidden: input.hidden };
  });
}
