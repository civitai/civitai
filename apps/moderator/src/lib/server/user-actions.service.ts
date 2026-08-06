import { env } from '$env/dynamic/private';
import { dbWrite } from './db';
import { getModeratorDb } from './moderator-db';
import { recordModActivity } from './mod-activity';
import { invalidateUserSessions } from './sessions';

// Enforcement actions from User Lookup (Retool's BANAPI / UNBANAPI / ToggleMute / forceLogout, ticket
// 868kkxqpn §1.2).
//
// Split by who owns the side effects:
//   - mute / unmute / force logout are done HERE (Kysely + session revocation), because the spoke owns
//     its mutations and doing it locally keeps the acting moderator in ModActivity.
//   - ban / unban delegates to the main app's /api/mod/ban-user, which also purges media and models,
//     sends notifications and busts caches. Reimplementing that here would be a second source of truth.
//
// Every action logs to ModActivity with the REAL moderator id. The ban endpoint records itself as
// `userId: -1` internally, so without this log a ban would have no attribution at all.

export type ActionResult = { ok: true } | { ok: false; error: string };

async function logAction(activity: string, targetUserId: number, moderatorId: number) {
  await recordModActivity({
    userId: moderatorId,
    entityType: 'user',
    entityId: targetUserId,
    activity,
  });
}

export async function setMuted(input: {
  userId: number;
  muted: boolean;
  moderatorId: number;
}): Promise<ActionResult> {
  const now = new Date();
  await dbWrite
    .updateTable('User')
    .set({ muted: input.muted, mutedAt: input.muted ? now : null })
    .where('id', '=', input.userId)
    .execute();

  // Without this the mute does not take effect until the user's session refreshes.
  await invalidateUserSessions(input.userId);
  await logAction(input.muted ? 'mute' : 'unmute', input.userId, input.moderatorId);
  return { ok: true };
}

export async function forceLogout(input: {
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  await invalidateUserSessions(input.userId);
  await logAction('forceLogout', input.userId, input.moderatorId);
  return { ok: true };
}

// `/api/mod/ban-user` TOGGLES rather than setting a state, and answers 200 before it has done the work.
// Re-reading `bannedAt` and refusing when it already matches the request turns the toggle back into an
// explicit operation: a stale page that thinks the user is unbanned cannot silently unban them. The
// 200-before-work behaviour cannot be fixed from here, so callers must re-read rather than trust it.
export async function setBanned(input: {
  userId: number;
  ban: boolean;
  reasonCode?: string;
  detailsInternal?: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const current = await dbWrite
    .selectFrom('User')
    .select('bannedAt')
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!current) return { ok: false, error: 'User not found.' };

  const isBanned = current.bannedAt !== null;
  if (isBanned === input.ban)
    return { ok: false, error: `User is already ${input.ban ? 'banned' : 'not banned'}. Reload.` };

  const base = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/$/, '');
  const token = env.WEBHOOK_TOKEN;
  if (!token) return { ok: false, error: 'WEBHOOK_TOKEN is not configured.' };

  const params = new URLSearchParams({ token, userId: String(input.userId) });
  if (input.ban && input.reasonCode) params.set('reasonCode', input.reasonCode);
  if (input.ban && input.detailsInternal) params.set('detailsInternal', input.detailsInternal);

  try {
    const res = await fetch(`${base}/api/mod/ban-user?${params}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `Ban endpoint returned ${res.status}.` };
  } catch (e) {
    console.error('[user-actions] ban request failed', e);
    return { ok: false, error: 'Ban request failed.' };
  }

  await logAction(input.ban ? 'ban' : 'unban', input.userId, input.moderatorId);
  return { ok: true };
}

// TIMED MUTES — moderator database. Retool's ActivateSystemMute / RevokeTimedMutes / ViewMutes.
// The table is empty as of 2026-08-06, so this is built to the schema rather than to observed usage.
export type TimedMute = {
  id: number;
  muteStart: Date | null;
  muteEnd: Date | null;
  createdBy: string | null;
  muteReason: string | null;
  isMuted: boolean | null;
};

export async function getTimedMutes(userId: number): Promise<TimedMute[]> {
  return (
    getModeratorDb()
      .selectFrom('TimedMutes')
      .select(['id', 'muteStart', 'muteEnd', 'createdBy', 'muteReason', 'isMuted'])
      // `userId` is TEXT in this table while every sibling uses integer — see moderator-db-types.
      .where('userId', '=', String(userId))
      .orderBy('muteStart', 'desc')
      .execute()
  );
}

export async function addTimedMute(input: {
  userId: number;
  until: Date;
  reason: string;
  author: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const now = new Date();
  await getModeratorDb()
    .insertInto('TimedMutes')
    .values({
      userId: String(input.userId),
      muteStart: now,
      muteEnd: input.until,
      createdBy: input.author,
      createdAt: now,
      muteReason: input.reason,
      isMuted: true,
    })
    .execute();

  // The timed row is the schedule; the mute itself still has to be applied to the account.
  await setMuted({ userId: input.userId, muted: true, moderatorId: input.moderatorId });
  return { ok: true };
}

// Scoped to BOTH id and userId, and acts only if a row actually changed. Filtering on `id` alone would
// let an id/userId mismatch — forged or merely stale — revoke one account's mute while unmuting another,
// revoking their sessions and logging it against them.
export async function revokeTimedMute(input: {
  id: number;
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await getModeratorDb()
    .updateTable('TimedMutes')
    .set({ isMuted: false, muteEnd: new Date() })
    .where('id', '=', input.id)
    .where('userId', '=', String(input.userId))
    .executeTakeFirst();

  if (Number(result.numUpdatedRows ?? 0) === 0)
    return { ok: false, error: 'That timed mute does not belong to this user.' };

  await setMuted({ userId: input.userId, muted: false, moderatorId: input.moderatorId });
  return { ok: true };
}
