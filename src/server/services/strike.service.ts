import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter, userUpdateCounter } from '~/server/prom/client';
import { invalidateSession, refreshSession } from '~/server/auth/session-invalidation';
import { createNotification } from '~/server/services/notification.service';
import { updateUserById } from '~/server/services/user.service';
import { clearedMuteFields } from '~/server/services/mute-provenance';
import { trackModActivity } from '~/server/services/moderator.service';
import { strikeIssuedEmail } from '~/server/email/templates';
import type {
  CreateStrikeInput,
  GetStrikesInput,
  GetUserStandingsInput,
  UserStandingRow,
  VoidStrikeInput,
} from '~/server/schema/strike.schema';
import type { UserMeta } from '~/server/schema/user.schema';
import { StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';
import { logToAxiom } from '~/server/logging/client';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { STRIKE_MUTE_REASON, tosReacceptanceOffer } from '~/server/common/tos-reacceptance';
import { getStaticContent, resolveTosHash } from '~/server/services/content.service';
import { setUserSetting } from '~/server/services/user.service';
import type { Context } from '~/server/createContext';
import { REVIEW_MUTE_POINTS, MUTE_POINTS } from '~/shared/constants/strike.constants';

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check if an auto-strike should be skipped due to rate limiting.
 * Limits non-manual strikes to max 1 per day per user.
 */
export async function shouldRateLimitStrike(userId: number): Promise<boolean> {
  const [result] = await dbRead.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "createdAt" >= CURRENT_DATE
      AND "reason" != ${StrikeReason.ManualModAction}::"StrikeReason"
  `;
  return Number(result.count) >= 1;
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get the sum of active strike points for a user.
 */
export async function getActiveStrikePoints(userId: number): Promise<number> {
  const [result] = await dbRead.$queryRaw<[{ sum: bigint | null }]>`
    SELECT SUM(points) as sum
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "status" = ${StrikeStatus.Active}::"StrikeStatus"
      AND "expiresAt" > NOW()
  `;
  return Number(result.sum ?? 0);
}

/**
 * Get a lightweight summary of active strikes for a user.
 * Single query returning only the 3 scalar values the summary endpoint needs.
 */
export async function getStrikeSummary(userId: number) {
  const [result] = await dbRead.$queryRaw<
    [{ count: bigint; sum: bigint | null; next_expiry: Date | null }]
  >`
    SELECT
      COUNT(*) as count,
      SUM(points) as sum,
      MIN("expiresAt") as next_expiry
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "status" = ${StrikeStatus.Active}::"StrikeStatus"
      AND "expiresAt" > NOW()
  `;

  return {
    activeStrikes: Number(result.count),
    totalActivePoints: Number(result.sum ?? 0),
    nextExpiry: result.next_expiry,
  };
}

/**
 * Get strikes for a specific user.
 * @param includeInternalNotes - Only true for mod-facing queries. Users must NOT see internal notes.
 */
export async function getStrikesForUser(
  userId: number,
  opts?: { includeExpired?: boolean; includeInternalNotes?: boolean }
) {
  const { includeExpired = false, includeInternalNotes = false } = opts ?? {};

  const [strikes, aggregates] = await Promise.all([
    dbRead.userStrike.findMany({
      where: {
        userId,
        ...(!includeExpired && { status: StrikeStatus.Active }),
      },
      select: {
        id: true,
        userId: true,
        reason: true,
        status: true,
        points: true,
        description: true,
        internalNotes: includeInternalNotes,
        entityType: true,
        entityId: true,
        reportId: true,
        createdAt: true,
        expiresAt: true,
        voidedAt: true,
        voidedBy: true,
        voidReason: true,
        issuedBy: true,
        issuedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    dbRead.userStrike.aggregate({
      where: {
        userId,
        status: StrikeStatus.Active,
        expiresAt: { gt: new Date() },
      },
      _sum: { points: true },
      _min: { expiresAt: true },
    }),
  ]);

  return {
    strikes,
    totalActivePoints: aggregates._sum.points ?? 0,
    nextExpiry: aggregates._min.expiresAt ?? null,
  };
}

/**
 * Get a user's full strike history with profile data for the moderator drawer.
 * Combines strike data + user profile in a single service call.
 */
export async function getStrikeHistoryForMod(userId: number) {
  const [strikeData, user] = await Promise.all([
    getStrikesForUser(userId, {
      includeExpired: true,
      includeInternalNotes: true,
    }),
    dbRead.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        createdAt: true,
        muted: true,
        bannedAt: true,
        deletedAt: true,
        meta: true,
      },
    }),
  ]);

  return { ...strikeData, user };
}

/**
 * Get paginated strikes for moderator dashboard.
 */
export async function getStrikesForMod(input: GetStrikesInput) {
  const { limit, page, userId, username, status, reason } = input;
  const { take, skip } = getPagination(limit, page);

  // If username provided, look up the user first
  let targetUserId = userId;
  if (username && !userId) {
    const user = await dbRead.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });
    targetUserId = user?.id;
    // If username doesn't match any user, return empty results
    if (!targetUserId) {
      return getPagingData({ items: [], count: 0 }, take, page);
    }
  }

  const where: Prisma.UserStrikeWhereInput = {
    ...(targetUserId && { userId: targetUserId }),
    ...(status?.length && { status: { in: status } }),
    ...(reason?.length && { reason: { in: reason } }),
  };

  const [items, count] = await Promise.all([
    dbRead.userStrike.findMany({
      where,
      include: {
        user: {
          select: { id: true, username: true },
        },
        issuedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    }),
    dbRead.userStrike.count({ where }),
  ]);

  return getPagingData({ items, count }, take, page);
}

/**
 * Get paginated user standings for the moderator dashboard.
 * Shows one row per user with aggregated strike data.
 */
export async function getUserStandings(input: GetUserStandingsInput) {
  const {
    limit,
    page,
    userId,
    username,
    hasActiveStrikes,
    isMuted,
    isFlaggedForReview,
    sort,
    sortOrder,
  } = input;
  const { take, skip } = getPagination(limit, page);

  // Use LEFT JOIN when searching by userId/username (find any user),
  // INNER JOIN by default (only users with strike history)
  const joinClause =
    userId || username
      ? Prisma.sql`LEFT JOIN "UserStrike" us ON us."userId" = u."id"`
      : Prisma.sql`INNER JOIN "UserStrike" us ON us."userId" = u."id"`;

  // Build WHERE conditions as Prisma.sql fragments
  const whereConditions: Prisma.Sql[] = [];
  if (userId) {
    whereConditions.push(Prisma.sql`u."id" = ${userId}`);
  }
  if (username) {
    whereConditions.push(Prisma.sql`u."username" ILIKE ${'%' + username + '%'}`);
  }
  if (isMuted) {
    whereConditions.push(Prisma.sql`u."muted" = true`);
  }
  if (isFlaggedForReview) {
    whereConditions.push(Prisma.sql`(u."meta"->>'strikeFlaggedForReview')::boolean = true`);
  }

  const whereClause =
    whereConditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, ' AND ')}`
      : Prisma.empty;

  const havingClause = hasActiveStrikes
    ? Prisma.sql`HAVING COUNT(*) FILTER (WHERE us."status" = 'Active' AND us."expiresAt" > NOW()) > 0`
    : Prisma.empty;

  // Sort mapping — all values are static SQL identifiers, safe to use Prisma.raw
  const sortMap: Record<string, string> = {
    points: '"totalActivePoints"',
    score: '"userScore"',
    lastStrike: '"lastStrikeDate"',
    created: 'u."createdAt"',
  };
  const orderColumn = Prisma.raw(sortMap[sort] ?? '"totalActivePoints"');
  const orderDir = Prisma.raw(sortOrder === 'asc' ? 'ASC' : 'DESC');

  const baseQuery = Prisma.sql`
    SELECT
      u."id",
      u."username",
      u."createdAt",
      u."muted",
      u."bannedAt",
      u."deletedAt",
      (u."meta"->'scores'->>'total')::float AS "userScore",
      COALESCE((u."meta"->>'strikeFlaggedForReview')::boolean, false) AS "flaggedForReview",
      COUNT(*) FILTER (WHERE us."status" = 'Active' AND us."expiresAt" > NOW())::int AS "activeStrikeCount",
      COALESCE(SUM(us."points") FILTER (WHERE us."status" = 'Active' AND us."expiresAt" > NOW()), 0)::int AS "totalActivePoints",
      COUNT(us."id")::int AS "totalStrikeCount",
      MAX(us."createdAt") AS "lastStrikeDate"
    FROM "User" u
    ${joinClause}
    ${whereClause}
    GROUP BY u."id"
    ${havingClause}
    ORDER BY ${orderColumn} ${orderDir} NULLS LAST, u."id" DESC
  `;

  const limitClause = take != null ? Prisma.sql`LIMIT ${take}` : Prisma.empty;
  const offsetClause = skip != null ? Prisma.sql`OFFSET ${skip}` : Prisma.empty;

  const [items, countResult] = await Promise.all([
    dbRead.$queryRaw<UserStandingRow[]>`${baseQuery} ${limitClause} ${offsetClause}`,
    dbRead.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) as count FROM (
      SELECT u."id"
      FROM "User" u
      ${joinClause}
      ${whereClause}
      GROUP BY u."id"
      ${havingClause}
    ) AS sub`,
  ]);

  const count = Number(countResult[0]?.count ?? 0);

  return getPagingData({ items, count }, take, page);
}

// ============================================================================
// Escalation Engine
// ============================================================================

export type EscalationAction = 'none' | 'muted' | 'muted-and-flagged' | 'unmuted';

/**
 * Evaluate strike escalation for a user based on their total active points.
 * Handles both escalation (mute/flag) and de-escalation (unmute when points drop).
 */
export async function evaluateStrikeEscalation(
  userId: number,
  { allowMute = false }: { allowMute?: boolean } = {}
): Promise<{ totalPoints: number; action: EscalationAction }> {
  // The point total and the mute-state write are one atomic unit. `FOR UPDATE` on the strike rows
  // only serializes concurrent evaluations while the transaction is open, so the write has to be
  // inside it — otherwise two callers both read a stale total and the loser's decision lands last.
  // Notifications and session invalidation stay outside: no I/O in a transaction.
  const { totalPoints, action, notify } = await dbWrite.$transaction(
    async (tx): Promise<{ totalPoints: number; action: EscalationAction; notify: boolean }> => {
      // The lock has to sit at a different query level from the aggregate: Postgres rejects
      // `FOR UPDATE` on an aggregate query outright (0A000), so `SUM(points) ... FOR UPDATE` throws
      // on every call. `MATERIALIZED` is load-bearing — inlining the CTE would collapse the two
      // levels back into one.
      const [pointsResult] = await tx.$queryRaw<[{ sum: bigint | null }]>`
        WITH locked AS MATERIALIZED (
          SELECT points
          FROM "UserStrike"
          WHERE "userId" = ${userId}
            AND "status" = ${StrikeStatus.Active}::"StrikeStatus"
            AND "expiresAt" > NOW()
          FOR UPDATE
        )
        SELECT SUM(points) as sum FROM locked
      `;
      const totalPoints = Number(pointsResult?.sum ?? 0);

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { muted: true, mutedAt: true, muteExpiresAt: true, meta: true },
      });
      if (!user) return { totalPoints, action: 'none', notify: false };

      const currentMeta = (user.meta as UserMeta) ?? {};
      // A mute this system applied, as opposed to the scam job or a generation restriction — all three
      // leave `mutedAt` null, so the reason is the only thing that tells them apart.
      const strikeMuted =
        user.muted && (currentMeta as { muteReason?: string }).muteReason === STRIKE_MUTE_REASON;

      // `mutedAt` is set ONLY by a moderator decision — a restriction uphold, the mod mute toggle, or
      // the moderator app. Every automatic path (prompt auditing, scam auto-mute, and this file) leaves
      // it null; `confirm-mutes`, `entity-moderation`, `prepare-leaderboard` and the generation notice
      // all already read it that way. So it is what separates "a person decided this" from "we did",
      // and strike escalation must not overwrite or lift the former.
      // `!= null`, not `!== null`: an absent field must not confer protection. A caller that does not
      // select `mutedAt` would otherwise make every mute look moderator-set and freeze de-escalation.
      const moderatorMuted = user.muted && user.mutedAt != null;

      // Label the mute only when it is ours: either we are applying it, or we already were. An account
      // muted by something else — the scam job and generation restrictions both mute without writing a
      // reason — must not acquire the strike label, because that label is what the ToS gate reads to
      // decide it may release the account.
      const mayLabelMute = !user.muted || currentMeta.muteReason === STRIKE_MUTE_REASON;

      if (totalPoints >= REVIEW_MUTE_POINTS) {
        // Only a strike being issued may mute — same rule as the tier below, and it also stops the
        // daily sweep re-flagging an account a moderator has just released.
        if (!allowMute) return { totalPoints, action: 'none', notify: false };

        const alreadyFlagged = user.muted && currentMeta.strikeFlaggedForReview;

        await tx.user.update({
          where: { id: userId },
          data: {
            muted: true,
            // A null expiry is what makes a mute indefinite. Escalating past a moderator's timed mute
            // only ever tightens it, so the expiry goes either way — but see the timed branch below,
            // where dropping it would LOOSEN one.
            muteExpiresAt: null,
            meta: {
              ...currentMeta,
              // Carried at this tier as well: without it an account that decays from 3 to 2 has no reason
              // stamped, so neither the ToS gate nor the release job recognises it and it sits muted.
              ...(mayLabelMute ? { muteReason: STRIKE_MUTE_REASON } : {}),
              strikeFlaggedForReview: true,
              strikeFlaggedAt: new Date(),
            },
          },
        });

        // Only notify on a new escalation, not a duplicate
        return { totalPoints, action: 'muted-and-flagged', notify: !alreadyFlagged };
      }

      if (totalPoints >= MUTE_POINTS) {
        // Muting happens ONLY when a strike is issued. Voiding, expiry and the daily sweep re-evaluate
        // to RELEASE, never to re-apply — otherwise a moderator's manual unmute is silently undone by
        // the next job run, which is what happened before this flag existed.
        if (!allowMute) return { totalPoints, action: 'none', notify: false };

        const alreadyHeld = user.muted && !moderatorMuted;

        await tx.user.update({
          where: { id: userId },
          data: {
            muted: true,
            // No expiry: this tier ends when the points fall below two or the user accepts, not on a
            // timer. A moderator's own expiry is left ALONE — nulling it would quietly turn their
            // 30-day mute into a permanent one.
            ...(moderatorMuted ? {} : { muteExpiresAt: null }),
            meta: {
              ...currentMeta,
              // What separates this from the scam auto-mute and the restriction mute, which also leave
              // `mutedAt` null. The ToS gate offers itself on THIS reason only: accepting the Terms
              // must not release an account muted for something else.
              ...(mayLabelMute ? { muteReason: STRIKE_MUTE_REASON } : {}),
              ...(currentMeta.strikeFlaggedForReview && totalPoints < REVIEW_MUTE_POINTS
                ? { strikeFlaggedForReview: false }
                : {}),
            },
          },
        });

        return { totalPoints, action: 'muted', notify: !alreadyHeld };
      }

      // Logged when the guard FIRES, because holding the mute is otherwise unobservable: correct
      // behaviour here is an account staying muted, which looks exactly like nothing happening.
      if (
        user.muted &&
        moderatorMuted &&
        (user.muteExpiresAt !== null || currentMeta.strikeFlaggedForReview)
      ) {
        logToAxiom({
          type: 'info',
          name: 'strike-de-escalation-skipped',
          message: `Kept moderator mute on user ${userId} — strike de-escalation does not lift it`,
          userId,
          totalPoints,
          muteExpiresAt: user.muteExpiresAt?.toISOString() ?? null,
        });
      }

      // De-escalation: release a mute STRIKES applied, once the points no longer justify it. Two ways
      // out of the 2-point tier and this is the backstop one — the strikes expire, the daily job
      // re-evaluates, the mute goes. The other is the user accepting the Terms early
      // (`acceptTosAfterMute`). `moderatorMuted` is the guard that keeps a person's mute out of both.
      if (
        user.muted &&
        !moderatorMuted &&
        (user.muteExpiresAt !== null || currentMeta.strikeFlaggedForReview || strikeMuted)
      ) {
        // `clearedMuteFields` owns the whole "why was this muted" set — see its docstring. The review
        // flag is this file's own, so it is layered on top of the meta the helper returns.
        const cleared = clearedMuteFields(currentMeta);
        await tx.user.update({
          where: { id: userId },
          data: {
            ...cleared,
            ...(currentMeta.strikeFlaggedForReview && {
              meta: { ...(cleared.meta as object), strikeFlaggedForReview: false },
            }),
          },
        });

        return { totalPoints, action: 'unmuted', notify: true };
      }

      return { totalPoints, action: 'none', notify: false };
    }
  );

  if (action === 'none') return { totalPoints, action };

  userUpdateCounter?.inc({ location: 'strike.service:evaluateStrikeEscalation' });

  if (notify) {
    await createNotification(
      action === 'unmuted'
        ? {
            type: 'strike-de-escalation-unmuted',
            category: NotificationCategory.System,
            key: `strike-de-escalation-unmuted:${userId}:${Date.now()}`,
            userId,
            details: {},
          }
        : {
            type: 'strike-escalation-muted',
            category: NotificationCategory.System,
            key: `strike-escalation-muted:${userId}:${Date.now()}`,
            userId,
            // No number for the 2-point tier: it ends on acceptance, not after N days.
            details: { muteDays: action === 'muted-and-flagged' ? 'indefinite' : 'until-accepted' },
          }
    );
  }

  if (action === 'unmuted') await refreshSession(userId, { caller: 'strike' });
  else await invalidateSession(userId, 'strike');

  return { totalPoints, action };
}

/**
 * Lift the 2-point mute after the user has re-read and accepted the Terms.
 *
 * Writes the acceptance timestamp ITSELF: the modal fires its own settings write without awaiting it,
 * so acceptance is not guaranteed recorded by the time this returns.
 *
 * The release re-reads and re-decides INSIDE a write transaction. Deciding on the replica and then
 * writing by id alone loses whatever happened in between — a third strike landing mid-call would have
 * its `strikeFlaggedForReview` erased by a stale `meta` write, leaving the account unmuted at three
 * points and absent from the review queue.
 */
export async function acceptTosAfterMute({
  userId,
  domain,
}: {
  userId: number;
  domain?: string;
}): Promise<{ unmuted: boolean; reason?: string }> {
  const tos = await getStaticContent({ slug: ['tos'], ctx: { domain } as Context });
  const now = new Date();
  await setUserSetting(userId, {
    ...(domain === 'green'
      ? { tosGreenLastSeenDate: now, tosGreenAcceptedHash: resolveTosHash(tos.hash) }
      : domain === 'red'
      ? { tosRedLastSeenDate: now, tosRedAcceptedHash: resolveTosHash(tos.hash) }
      : { tosLastSeenDate: now, tosAcceptedHash: resolveTosHash(tos.hash) }),
  });

  const result = await dbWrite.$transaction(
    async (tx): Promise<{ unmuted: boolean; reason?: string }> => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { muted: true, mutedAt: true, meta: true },
      });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      const currentMeta = (user.meta as UserMeta) ?? {};
      const [pointsResult] = await tx.$queryRaw<[{ sum: bigint | null }]>`
        SELECT SUM(points) as sum
        FROM "UserStrike"
        WHERE "userId" = ${userId}
          AND "status" = ${StrikeStatus.Active}::"StrikeStatus"
          AND "expiresAt" > NOW()
      `;
      const totalPoints = Number(pointsResult?.sum ?? 0);

      // The SAME predicate the mute guard uses to decide whether to OFFER the Terms — deliberately,
      // not a second set of checks that happen to agree today. This mutation is `protectedProcedure`,
      // so any signed-in account can call it directly: the reason check is the control, and the modal
      // never being shown is not.
      const eligible = tosReacceptanceOffer({
        muted: user.muted,
        mutedAt: user.mutedAt,
        muteReason: currentMeta.muteReason ?? null,
        activePoints: totalPoints,
      });
      if (!eligible) {
        if (user.mutedAt != null) return { unmuted: false, reason: 'moderator' };
        if (totalPoints >= REVIEW_MUTE_POINTS) return { unmuted: false, reason: 'review' };
        if (!user.muted) return { unmuted: false, reason: 'not-muted' };
        return { unmuted: false, reason: 'not-eligible' };
      }

      await tx.user.update({ where: { id: userId }, data: clearedMuteFields(currentMeta) });
      return { unmuted: true };
    }
  );

  if (!result.unmuted) return result;

  userUpdateCounter?.inc({ location: 'strike.service:acceptTosAfterMute' });
  await refreshSession(userId, { caller: 'strike' });
  return result;
}

// ============================================================================
// CRUD Functions
// ============================================================================

/**
 * Create a new strike for a user.
 */
export async function createStrike(input: CreateStrikeInput & { issuedBy?: number }) {
  const {
    userId,
    reason,
    points,
    description,
    internalNotes,
    entityType,
    entityId,
    reportId,
    expiresInDays,
    issuedBy,
  } = input;

  // Validate user exists
  const userExists = await dbRead.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!userExists) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `User ${userId} not found` });
  }

  // Rate limit check for non-manual strikes
  if (reason !== StrikeReason.ManualModAction) {
    const shouldLimit = await shouldRateLimitStrike(userId);
    if (shouldLimit) {
      logToAxiom({
        type: 'info',
        name: 'strike-rate-limited',
        message: `Skipped auto-strike for user ${userId} — rate limited`,
        userId,
        reason,
      });
      return null;
    }
  }

  // Calculate expiration date
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // Create the strike record
  const strike = await dbWrite.userStrike.create({
    data: {
      userId,
      reason,
      points,
      description,
      internalNotes,
      entityType,
      entityId,
      reportId,
      expiresAt,
      issuedBy,
    },
  });

  // Deliberately not fatal: the strike row is already committed, so throwing here would report a
  // failure for a strike that landed — and a moderator retrying a manual strike issues a second one,
  // since `ManualModAction` skips the rate limit.
  try {
    await trackModActivity(issuedBy ?? -1, {
      entityType: 'user',
      entityId: userId,
      activity: 'strike',
    });
  } catch (error) {
    const err = error as Error;
    logToAxiom({
      type: 'error',
      name: 'strike-mod-activity-failed',
      message: err.message,
      stack: err.stack,
      userId,
      strikeId: strike.id,
    });
  }

  await evaluateStrikeEscalation(userId, { allowMute: true });

  // Get updated active points for notification/email
  const activePoints = await getActiveStrikePoints(userId);

  // Send notification — createNotification handles its own error logging
  await createNotification({
    type: 'strike-issued',
    category: NotificationCategory.System,
    key: `strike-issued:${userId}:${strike.id}`,
    userId,
    details: {
      description,
      points,
    },
  });

  try {
    const user = await dbRead.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true },
    });

    if (user?.email) {
      await strikeIssuedEmail.send({
        to: user.email,
        username: user.username ?? 'User',
        reason,
        description,
        points,
        activePoints,
        expiresAt,
      });
    }
  } catch (error) {
    const err = error as Error;
    logToAxiom({
      type: 'error',
      name: 'strike-email-failed',
      message: err.message,
      stack: err.stack,
      userId,
      strikeId: strike.id,
    });
  }

  return strike;
}

/**
 * Void an existing strike.
 * Uses atomic updateMany with status guard to prevent race conditions.
 */
export async function voidStrike(input: VoidStrikeInput & { voidedBy: number }) {
  const { strikeId, voidReason, voidedBy } = input;

  // Atomic update: only void if currently Active (prevents race conditions)
  const { count } = await dbWrite.userStrike.updateMany({
    where: { id: strikeId, status: StrikeStatus.Active },
    data: {
      status: StrikeStatus.Voided,
      voidedAt: new Date(),
      voidedBy,
      voidReason,
    },
  });

  if (count === 0) {
    // Determine why: not found vs wrong status
    const existing = await dbRead.userStrike.findUnique({
      where: { id: strikeId },
      select: { status: true },
    });
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Strike not found' });
    }
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot void a strike with status "${existing.status}". Only active strikes can be voided.`,
    });
  }

  // Fetch the updated strike for return value and userId
  const strikeFindArgs = {
    where: { id: strikeId },
  } as const;
  const strike = await dbRead.userStrike.findUniqueOrThrow(strikeFindArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'userStrike', caller: 'voidStrike' });
    return dbWrite.userStrike.findUniqueOrThrow(strikeFindArgs);
  });

  // Send notification — createNotification handles its own error logging
  await createNotification({
    type: 'strike-voided',
    category: NotificationCategory.System,
    key: `strike-voided:${strike.userId}:${strike.id}`,
    userId: strike.userId,
    details: {
      voidReason,
    },
  });

  // Re-evaluate escalation (may de-escalate)
  try {
    await evaluateStrikeEscalation(strike.userId);
  } catch (error) {
    const err = error as Error;
    logToAxiom({
      type: 'error',
      name: 'strike-void-escalation-failed',
      message: err.message,
      stack: err.stack,
      userId: strike.userId,
      strikeId: strike.id,
    });
  }

  return strike;
}

// ============================================================================
// Job Functions
// ============================================================================

/**
 * Expire strikes that have passed their expiration date.
 */
export async function expireStrikes(): Promise<{ expiredCount: number }> {
  // Get strikes that need to expire (for notifications)
  const strikesToExpire = await dbRead.userStrike.findMany({
    where: {
      status: StrikeStatus.Active,
      expiresAt: { lte: new Date() },
    },
    select: { id: true, userId: true },
  });

  if (strikesToExpire.length === 0) {
    return { expiredCount: 0 };
  }

  // Batch update all expired strikes
  await dbWrite.userStrike.updateMany({
    where: {
      status: StrikeStatus.Active,
      expiresAt: { lte: new Date() },
    },
    data: {
      status: StrikeStatus.Expired,
    },
  });

  // Send notifications and re-evaluate escalation for affected users
  const uniqueUserIds = [...new Set(strikesToExpire.map((s) => s.userId))];

  // Batch notifications
  await Promise.all(
    uniqueUserIds.map((userId) =>
      createNotification({
        type: 'strike-expired',
        category: NotificationCategory.System,
        key: `strike-expired:${userId}:${Date.now()}`,
        userId,
        details: {},
      })
    )
  );

  // Re-evaluate escalation for each user — must be sequential since each
  // uses a transaction with FOR UPDATE locks
  for (const userId of uniqueUserIds) {
    try {
      await evaluateStrikeEscalation(userId);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'strike-expired-escalation-failed',
        message: err.message,
        stack: err.stack,
        userId,
      });
    }
  }

  return { expiredCount: strikesToExpire.length };
}

/**
 * Release mutes that have run their course. Only ever UNMUTES — muting happens when a strike is
 * issued, so a moderator's manual unmute is not undone the next time this runs.
 *
 * Two kinds, and they end differently:
 *
 * - **A moderator's timed mute** (`mutedAt` set, `muteExpiresAt` passed) is released outright. The
 *   expiry is that moderator's own decision, so honouring it is not strike de-escalation lifting
 *   someone else's mute — and nothing else in the system will do it.
 * - **A strike mute** has no expiry at all; it is handed to `evaluateStrikeEscalation`, which releases
 *   it once the points no longer justify it.
 *
 * Daily rather than hourly because strikes expire on a day boundary, so nothing finer changes anything.
 */
export async function processTimedUnmutes(): Promise<{ unmutedCount: number }> {
  const [strikeMuted, expiredModeratorMutes] = await Promise.all([
    dbRead.$queryRaw<{ id: number }[]>`
      SELECT u."id"
      FROM "User" u
      WHERE u."muted" = true
        AND u."mutedAt" IS NULL
        AND (u."meta"->>'muteReason' = ${STRIKE_MUTE_REASON} OR u."muteExpiresAt" <= NOW())
    `,
    dbRead.$queryRaw<{ id: number }[]>`
      SELECT u."id"
      FROM "User" u
      WHERE u."muted" = true
        AND u."mutedAt" IS NOT NULL
        AND u."muteExpiresAt" <= NOW()
    `,
  ]);

  let unmutedCount = 0;

  for (const { id } of strikeMuted) {
    try {
      // Cannot mute: `allowMute` is not passed, so the worst case is declining to release.
      const { action } = await evaluateStrikeEscalation(id);
      if (action === 'unmuted') unmutedCount++;
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'strike-timed-unmute-failed',
        message: err.message,
        stack: err.stack,
        userId: id,
      });
    }
  }

  for (const { id } of expiredModeratorMutes) {
    try {
      const existing = await dbRead.user.findUnique({ where: { id }, select: { meta: true } });
      await updateUserById({
        id,
        data: clearedMuteFields(existing?.meta as UserMeta | null),
        updateSource: 'timed-unmute',
      });
      await refreshSession(id, { caller: 'strike' });
      unmutedCount++;
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'strike-timed-unmute-failed',
        message: err.message,
        stack: err.stack,
        userId: id,
      });
    }
  }

  return { unmutedCount };
}
