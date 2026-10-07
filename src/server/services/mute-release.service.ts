import type { Prisma } from '@prisma/client';
import { invalidateSession } from '~/server/auth/session-invalidation';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { userUpdateCounter } from '~/server/prom/client';
import { trackModActivity } from '~/server/services/moderator.service';
import { clearedMuteFields } from '~/server/services/mute-provenance';
import { closeScamCasesOpenedBefore, restoreScamCases } from '~/server/services/scam-case-ledger';
import { hasOtherPendingRestriction } from '~/server/services/user-restriction.service';

export type MuteReleaseActivity = 'unmute' | 'revokeTimedMute';

export type MuteReleaseArgs = {
  userId: number;
  /** A moderator, or the system actor for a release nobody decided (an expiry, the strike engine). */
  actorId: number;
  activity?: MuteReleaseActivity;
  /** Release only a timed mute; anything else is left in place. */
  onlyIfTimed?: boolean;
  /** Merged into `meta` after the mute's own keys are cleared. */
  metaPatch?: Record<string, unknown>;
};

export type MuteRelease =
  | { released: true; closedCaseIds: number[]; user: Prisma.UserGetPayload<object> }
  | { released: false; reason: 'not-found' | 'not-timed' | 'scam-case'; closedCaseIds: [] };

/**
 * The database half of every unmute, for a caller already inside a transaction. It takes the account
 * row lock that a scam verdict takes before filing, so a verdict either sees this unmute or files
 * first and has its case closed here. Run `afterMuteReleased` once the transaction commits.
 *
 * Only a moderator's unmute closes open scam cases. A system release (an expiry, the strike engine)
 * lifts its own mute despite other open cases, but never one a Pending scam case holds: that mute
 * ends with the ruling.
 */
export async function releaseMuteInTransaction(
  tx: Prisma.TransactionClient,
  { userId, actorId, activity = 'unmute', onlyIfTimed = false, metaPatch }: MuteReleaseArgs
): Promise<MuteRelease> {
  const [locked] = await tx.$queryRaw<{ meta: unknown; muteExpiresAt: Date | null }[]>`
    SELECT meta, "muteExpiresAt" FROM "User" WHERE id = ${userId} FOR UPDATE
  `;
  if (!locked) return { released: false, reason: 'not-found', closedCaseIds: [] };
  if (onlyIfTimed && !locked.muteExpiresAt)
    return { released: false, reason: 'not-timed', closedCaseIds: [] };

  // System callers (expiry, strike engine, ToS acceptance) must pass the system user id: a session
  // user's id here would read as a moderator and bypass the scam-case gate.
  const byModerator = actorId > 0;
  if (!byModerator && (await hasOtherPendingRestriction(tx, userId, undefined, 'scam')))
    return { released: false, reason: 'scam-case', closedCaseIds: [] };
  const cleared = clearedMuteFields(locked.meta);
  const user = await tx.user.update({
    where: { id: userId },
    data: {
      ...cleared,
      ...(metaPatch
        ? { meta: { ...(cleared.meta as object), ...metaPatch } as Prisma.InputJsonValue }
        : {}),
    },
  });
  await trackModActivity(actorId, { entityType: 'user', entityId: userId, activity }, tx);
  const closedCaseIds = byModerator ? await closeScamCasesOpenedBefore(userId, new Date(), tx) : [];
  return { released: true, closedCaseIds, user };
}

/** Post-commit half of an unmute. Never throws: the unmute itself has already happened. */
export async function afterMuteReleased({
  userId,
  closedCaseIds,
  updateSource,
}: {
  userId: number;
  closedCaseIds: number[];
  updateSource: string;
}) {
  userUpdateCounter?.inc({ location: `user.service:${updateSource}` });
  await restoreScamCases(userId, closedCaseIds);
  try {
    await invalidateSession(userId, 'moderation');
  } catch (error) {
    await logToAxiom({
      name: 'unmute-session-invalidate-failed',
      type: 'error',
      message: (error as Error).message,
      details: { userId },
    }).catch(() => undefined);
  }
}

/** Every unmute goes through here, or through `releaseMuteInTransaction` + `afterMuteReleased`. */
export async function releaseUserMute(args: MuteReleaseArgs & { updateSource: string }) {
  const result = await dbWrite.$transaction((tx) => releaseMuteInTransaction(tx, args));
  if (result.released)
    await afterMuteReleased({
      userId: args.userId,
      closedCaseIds: result.closedCaseIds,
      updateSource: args.updateSource,
    });
  return result;
}
