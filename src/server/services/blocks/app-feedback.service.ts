import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  appFeedbackStatusKey,
  isReporterNotifiedOwnerStatus,
} from '~/server/notifications/app-feedback.notifications';
import { APP_LISTING_OWNER_SQL } from '~/server/notifications/comment.notifications';
import type {
  AppFeedbackEnvironment,
  AppFeedbackOwnerStatusFilter,
  AppFeedbackRecentError,
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
import {
  APP_FEEDBACK_RECENT_ERRORS_MAX,
  APP_FEEDBACK_SURFACES,
  appFeedbackEnvironmentSchema,
  appFeedbackRecentErrorSchema,
} from '~/server/schema/app-feedback.schema';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { throwIfBlockedByOwners } from '~/server/services/block-check.service';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import {
  listingIdForAppBlock,
  resolveAccessibleListingIds,
  resolveListingAccess,
} from '~/server/services/blocks/app-access.service';
import { notifyAppFeedbackReporter } from '~/server/services/blocks/app-feedback-notify';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import { readListingVisibility } from '~/server/services/blocks/app-listing-visibility.service';
import { noteDegradedRead } from '~/server/services/blocks/degraded-read-log';
import {
  OWNER_NEW_FEEDBACK_SQL,
  OWNER_VISIBLE_FEEDBACK_SQL,
} from '~/server/services/blocks/app-feedback-visibility';
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
  | 'not_approved'
  | 'blocked';

export type ResolvedAppFeedbackTarget = {
  /** Always the PARENT (seat) listing — never a shadow revision. */
  appListingId: string;
  appName: string;
  appBlockVersion: string | null;
  appBlockSha: string | null;
  /** The running AppBlock's row id; `null` for an off-site app. */
  appBlockId: string | null;
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
  // chrome mount (the feedback button asks on mount) the listing reads below.
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
        appBlock: { select: { id: true, version: true, currentVersionSha: true } },
      },
    }),
    resolveStoreVisibilityScope({ user }),
  ]);
  if (!listing) return refuse('not_found');

  // Before the status and block checks. Every refusal after it reads as NOT_FOUND today
  // (`refusalError`); keeping scope ahead of them means a distinguishable refusal added later
  // still tells a caller whose store scope hides this kind nothing about the listing.
  const scope = narrowStoreScope(rawScope);
  if (!scopeAdmitsListingKind(scope, access.kind as StoreListingKind)) return refuse('scope');

  // 🔴 `access.role` is DELIBERATELY not consulted. Operator decision, 2026-10-11: the owner and
  // accepted collaborators may send feedback like anyone else; it lands in their own inbox.
  // Pinned by the "admits the canonical owner" / "admits an accepted collaborator" tests.
  //
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
      appBlockId: block?.id ?? null,
    },
  };
}

export type AppSourceCommit = { appSourceCommit: string | null; appSourceDirty: boolean | null };

const UNKNOWN_SOURCE: AppSourceCommit = { appSourceCommit: null, appSourceDirty: null };

/**
 * The developer's own `sourceCommit` / `sourceDirty` for the build that is serving: the approved
 * publish request whose platform commit is the block's current one, the same link the git-push
 * webhook uses. No current sha, or no request carrying it, is unknown: a guess from the version
 * string could name a different submission of the same version.
 */
export async function resolveLiveSourceCommit(target: {
  appBlockId: string | null;
  appBlockSha: string | null;
}): Promise<AppSourceCommit> {
  if (!target.appBlockId || !target.appBlockSha) return UNKNOWN_SOURCE;
  const row = await dbRead.appBlockPublishRequest.findFirst({
    where: {
      appBlockId: target.appBlockId,
      status: 'approved',
      forgejoCommitSha: target.appBlockSha,
    },
    orderBy: { reviewedAt: 'desc' },
    select: { sourceCommit: true, sourceDirty: true },
  });
  return row
    ? { appSourceCommit: row.sourceCommit, appSourceDirty: row.sourceDirty }
    : UNKNOWN_SOURCE;
}

/**
 * 🔴 `appSourceCommit` / `appSourceDirty` ARE MANUAL-APPLY, NO-TYPE COLUMNS, written and read only
 * here, in raw SQL, each degrading when the column is not there yet. As Prisma fields they would
 * be named by the feedback create's RETURNING and by every read, and app feedback would fail
 * outright between this deploy and the migration. So a report is always created first and the
 * source commit added to it best-effort; until the migration is applied it is simply not kept.
 */
async function writeFeedbackSourceCommit(id: number, source: AppSourceCommit): Promise<void> {
  if (source.appSourceCommit === null && source.appSourceDirty === null) return;
  try {
    await dbWrite.$executeRaw`
      UPDATE "Feedback"
      SET "appSourceCommit" = ${source.appSourceCommit}, "appSourceDirty" = ${source.appSourceDirty}
      WHERE "id" = ${id}
    `;
  } catch (err) {
    if (!isMissingColumnError(err))
      noteDegradedRead('app-feedback-source-commit-write-failed', err);
  }
}

/** The source commit of each row, by id; a row missing from the map is unknown. Never throws. */
export async function readFeedbackSourceCommits(
  ids: readonly number[],
  db: typeof dbRead = dbRead
): Promise<Map<number, AppSourceCommit>> {
  if (ids.length === 0) return new Map();
  try {
    const rows = await db.$queryRaw<
      Array<{ id: number; appSourceCommit: string | null; appSourceDirty: boolean | null }>
    >(Prisma.sql`
      SELECT f.id, f."appSourceCommit", f."appSourceDirty"
      FROM "Feedback" f
      WHERE f.id IN (${Prisma.join([...ids])})
    `);
    return new Map(
      rows.map((r) => [
        r.id,
        { appSourceCommit: r.appSourceCommit ?? null, appSourceDirty: r.appSourceDirty ?? null },
      ])
    );
  } catch (err) {
    if (!isMissingColumnError(err))
      noteDegradedRead('app-feedback-source-commit-read-degraded', err);
    return new Map();
  }
}

const withSource = <T extends { id: number }>(rows: T[], sources: Map<number, AppSourceCommit>) =>
  rows.map((row) => ({ ...row, ...(sources.get(row.id) ?? UNKNOWN_SOURCE) }));

export async function getAppFeedbackEligibility(user: SessionUser, target: AppFeedbackTarget) {
  const resolved = await resolveAppFeedbackTarget(user, target);
  if (!resolved.ok) return { eligible: false as const };
  const { appListingId, appName, appBlockVersion } = resolved.target;
  return { eligible: true as const, appListingId, appName, appBlockVersion };
}

export const APP_FEEDBACK_NOT_FOUND_MESSAGE = 'App not found';
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

  // Stamped now: the live submission changes on the next approve, so it cannot be recovered later.
  const source = await resolveLiveSourceCommit(resolved.target);

  const created = await dbWrite.feedback.create({
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
  await writeFeedbackSourceCommit(created.id, source);
  return created;
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
 * an owner can never change a row they cannot see. Prisma's form of `OWNER_VISIBLE_FEEDBACK_SQL`
 * (the raw reads' and the digest's); a test holds the two to the same rules.
 */
export function ownerVisibleWhere(seatListingId: string): Prisma.FeedbackWhereInput {
  return {
    area: APP_BLOCK_FEEDBACK_AREA,
    appListingId: seatListingId,
    hiddenFromOwnerAt: null,
    user: { bannedAt: null },
  };
}

/**
 * {@link ownerVisibleWhere} for the raw reads, from the shared {@link OWNER_VISIBLE_FEEDBACK_SQL}
 * that the owner digest also reads; `f` = Feedback, `u` = reporter.
 */
function ownerVisibleSql(seatListingIds: string[]): Prisma.Sql[] {
  return [
    Prisma.raw(OWNER_VISIBLE_FEEDBACK_SQL),
    Prisma.sql`f."appListingId" IN (${Prisma.join(seatListingIds)})`,
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

/** The owner-status filter of the inbox and the moderator list; `new` is the digest's too. */
function ownerStatusSql(filter: AppFeedbackOwnerStatusFilter | undefined): Prisma.Sql[] {
  if (!filter) return [];
  if (filter === 'new') return [Prisma.raw(OWNER_NEW_FEEDBACK_SQL)];
  return [Prisma.sql`f."ownerStatus" = ${filter}`];
}

export type OwnerFeedbackRow = {
  id: number;
  message: string;
  createdAt: Date;
  appBlockVersion: string | null;
  appBlockSha: string | null;
  appSourceCommit: string | null;
  appSourceDirty: boolean | null;
  surface: string | null;
  recentErrors: unknown;
  environment: unknown;
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
  /** The developer's commit for the live build, as their CLI claimed it at submit. */
  appSourceCommit: string | null;
  /** `null` = unknown, which is not `false` (clean). */
  appSourceDirty: boolean | null;
  surface: AppFeedbackSurface | null;
  /** Failed replies to the app's SDK calls before the report, oldest first. Untrusted text. */
  recentErrors: AppFeedbackRecentError[];
  /** Browser family/major, window size, app route. Client-reported. */
  environment: AppFeedbackEnvironment | null;
  ownerStatus: FeedbackOwnerStatus | null;
  ownerStatusAt: Date | null;
  ownerFlaggedAt: Date | null;
};

/**
 * The upstream of an app that is a fork. `upstreamSlug` / `upstreamVersion` are named only while
 * the parent is an approved, publicly visible listing, so a hidden or removed parent reads the
 * same as an unknown one; `forkedAtCommit` is the parent commit the fork's own repo started at.
 */
export type AppFeedbackForkOrigin = {
  upstreamSlug: string | null;
  upstreamVersion: string | null;
  forkedAtCommit: string | null;
};

export type OwnerFeedbackListItem = OwnerFeedbackDto & { forkOf: AppFeedbackForkOrigin | null };

/**
 * Fork provenance never changes once written, so it is read with the list rather than stamped on
 * each row. Cosmetic: any failure (an unapplied fork migration included) reads as "not a fork".
 */
export async function readFeedbackForkOrigin(
  seatListingId: string
): Promise<AppFeedbackForkOrigin | null> {
  try {
    const rows = await dbRead.$queryRaw<
      Array<{
        parentBlockId: string | null;
        forkedAtCommit: string | null;
        parentListingId: string | null;
      }>
    >(Prisma.sql`
      SELECT ab."fork_of_app_block_id" AS "parentBlockId",
             ab."fork_of_commit_sha" AS "forkedAtCommit",
             al."fork_of_listing_id" AS "parentListingId"
      FROM "app_listings" al
      LEFT JOIN "app_blocks" ab ON ab."id" = al."app_block_id"
      WHERE al."id" = ${seatListingId}
      LIMIT 1
    `);
    const row = rows[0];
    if (!row || (!row.parentBlockId && !row.forkedAtCommit && !row.parentListingId)) return null;
    const unnamed: AppFeedbackForkOrigin = {
      upstreamSlug: null,
      upstreamVersion: null,
      forkedAtCommit: row.forkedAtCommit,
    };
    if (!row.parentListingId) return unnamed;
    const [parent, visibility] = await Promise.all([
      dbRead.appListing.findUnique({
        where: { id: row.parentListingId },
        select: { slug: true, status: true },
      }),
      readListingVisibility(row.parentListingId, dbRead),
    ]);
    const isPublic =
      parent?.status === 'approved' &&
      visibility.available &&
      (visibility.visibility === null || visibility.visibility === 'public');
    if (!parent || !isPublic) return unnamed;
    const version =
      row.parentBlockId && row.forkedAtCommit
        ? await dbRead.appBlockPublishRequest.findFirst({
            where: {
              appBlockId: row.parentBlockId,
              status: 'approved',
              forgejoCommitSha: row.forkedAtCommit,
            },
            orderBy: { reviewedAt: 'desc' },
            select: { version: true },
          })
        : null;
    return { ...unnamed, upstreamSlug: parent.slug, upstreamVersion: version?.version ?? null };
  } catch (err) {
    noteDegradedRead('app-feedback-fork-origin-degraded', err);
    return null;
  }
}

function isSurface(value: unknown): value is AppFeedbackSurface {
  return typeof value === 'string' && (APP_FEEDBACK_SURFACES as readonly string[]).includes(value);
}

/**
 * `context.recentErrors` re-validated on the way out: it was written by a client, so a row is read
 * entry by entry and anything outside the schema (or past the cap) is dropped, not shown.
 */
export function readRecentErrors(value: unknown): AppFeedbackRecentError[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, APP_FEEDBACK_RECENT_ERRORS_MAX).flatMap((entry) => {
    const parsed = appFeedbackRecentErrorSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** `context.environment` re-validated on the way out; anything outside the schema reads as none. */
export function readEnvironment(value: unknown): AppFeedbackEnvironment | null {
  const parsed = appFeedbackEnvironmentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
    appSourceCommit: row.appSourceCommit,
    appSourceDirty: row.appSourceDirty,
    // `context` is a client claim; only a value from the closed set is shown, never used for authz.
    surface: isSurface(row.surface) ? row.surface : null,
    recentErrors: readRecentErrors(row.recentErrors),
    environment: readEnvironment(row.environment),
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
}): Promise<{ items: OwnerFeedbackListItem[]; nextCursor: number | undefined }> {
  const seatListingId = await resolveInboxListingId(input.appListingId, userId);
  const conditions = [
    ...ownerVisibleSql([seatListingId]),
    ...ownerStatusSql(input.ownerStatus),
    ...cursorSql(input.cursor, seatListingId),
  ];
  const rows = await dbRead.$queryRaw<Omit<OwnerFeedbackRow, keyof AppSourceCommit>[]>(Prisma.sql`
    SELECT
      f.id,
      f.message,
      f."createdAt",
      f."appBlockVersion",
      f."appBlockSha",
      f.context->>'surface' AS surface,
      f.context->'recentErrors' AS "recentErrors",
      f.context->'environment' AS "environment",
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
  const sources = await readFeedbackSourceCommits(page.map((r) => r.id));
  const forkOf = page.length ? await readFeedbackForkOrigin(seatListingId) : null;
  return {
    items: withSource(page, sources).map((row) => ({ ...toOwnerFeedbackDto(row), forkOf })),
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
  if (isReporterNotifiedOwnerStatus(input.ownerStatus))
    await notifyReporterOfOwnerStatus(seatListingId, input.id, input.ownerStatus, userId);
  return { id: input.id, ownerStatus: input.ownerStatus };
}

/**
 * Tell the reporter the developer marked their feedback `resolved` / `wont_fix`. Best-effort, after
 * the UPDATE commits: a failure is logged and never fails the status change. Re-read on the
 * primary under `ownerVisibleWhere` plus the status just written, so a row hidden, or moved to
 * another status, since the write sends nothing.
 *
 * Nothing is sent when the reporter IS the person who set the status: an owner or collaborator may
 * file feedback on their own app, and closing your own row is not news to you. A different member
 * of the app's team closing it still notifies the reporter.
 */
async function notifyReporterOfOwnerStatus(
  seatListingId: string,
  feedbackId: number,
  ownerStatus: FeedbackOwnerStatus,
  actorUserId: number
) {
  try {
    const row = await dbWrite.feedback.findFirst({
      where: { ...ownerVisibleWhere(seatListingId), id: feedbackId, ownerStatus },
      select: { userId: true, appListing: { select: { name: true, slug: true } } },
    });
    if (!row || row.userId === actorUserId) return;
    await notifyAppFeedbackReporter({
      userId: row.userId,
      key: appFeedbackStatusKey(feedbackId, ownerStatus),
      details: {
        feedbackId,
        ownerStatus,
        appName: row.appListing?.name ?? null,
        appSlug: row.appListing?.slug ?? null,
      },
    });
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'warning',
      name: 'app-feedback-status-notify-failed',
      details: { feedbackId, ownerStatus },
      message: error.message,
    }).catch(() => undefined);
  }
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
  appSourceCommit: string | null;
  appSourceDirty: boolean | null;
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
  recentErrors: AppFeedbackRecentError[];
  environment: AppFeedbackEnvironment | null;
} {
  const ctx = (context ?? {}) as {
    surface?: unknown;
    modelId?: unknown;
    recentErrors?: unknown;
    environment?: unknown;
  };
  return {
    surface: isSurface(ctx.surface) ? ctx.surface : null,
    modelId: typeof ctx.modelId === 'number' && Number.isInteger(ctx.modelId) ? ctx.modelId : null,
    recentErrors: readRecentErrors(ctx.recentErrors),
    environment: readEnvironment(ctx.environment),
  };
}

export async function modListAppFeedback(input: ModListAppFeedbackInput) {
  const conditions = [...modListConditions(input), ...cursorSql(input.cursor)];
  // The PRIMARY, not a replica: the moderator tab refetches this right after a hide/unhide and must
  // read its own write. Moderator-only, over a small table.
  // LEFT joins from the listing on, so a row whose listing was deleted still lists.
  const rows = await dbWrite.$queryRaw<Omit<ModFeedbackRow, keyof AppSourceCommit>[]>(Prisma.sql`
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
  // The replica is enough here: the source commit is written once, with the row, and never moves.
  const sources = await readFeedbackSourceCommits(page.map((r) => r.id));
  return {
    items: withSource(page, sources).map(({ context, ...row }) => ({
      ...row,
      ...readContext(context),
    })),
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

export type AppFeedbackForRefund = {
  id: number;
  area: string;
  userId: number;
  /** The app block the report was filed on, when its listing still exists and hosts one. */
  appBlockId: string | null;
};

/** The columns the moderator App refund checks before it moves money against a report. */
export async function getAppFeedbackForRefund(id: number): Promise<AppFeedbackForRefund | null> {
  const rows = await dbWrite.$queryRaw<AppFeedbackForRefund[]>`
    SELECT f."id", f."area", f."userId", al."app_block_id" AS "appBlockId"
    FROM "Feedback" f
    LEFT JOIN "app_listings" al ON al."id" = f."appListingId"
    WHERE f."id" = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * Record a moderator App refund on its report: append the note, and with `resolve` set moderator status
 * `actioned`. `ownerStatus` is left alone because changing it notifies the reporter in the
 * developer's name; the note is appended because an overwritten note cannot be recovered.
 */
export async function modResolveAppFeedbackWithRefund({
  moderatorId,
  feedbackId,
  reporterUserId,
  note,
  resolve,
}: {
  moderatorId: number;
  feedbackId: number;
  reporterUserId: number;
  note: string;
  resolve: boolean;
}): Promise<boolean> {
  return dbWrite.$transaction(async (tx) => {
    const close = resolve
      ? Prisma.sql`"status" = 'actioned', "handledById" = ${moderatorId}, "handledAt" = now(),`
      : Prisma.empty;
    const count = await tx.$executeRaw`
      UPDATE "Feedback"
      SET ${close}
          "triageNote" = CASE
            WHEN COALESCE("triageNote", '') = '' THEN ${note}
            ELSE "triageNote" || E'\n' || ${note}
          END
      WHERE "id" = ${feedbackId}
        AND "area" = ${APP_BLOCK_FEEDBACK_AREA}
        AND "userId" = ${reporterUserId}
    `;
    if (count === 0) return false;
    await trackModActivity(
      moderatorId,
      { entityType: 'feedback', activity: 'refundAppBuzz', entityId: feedbackId },
      tx
    );
    return true;
  });
}
