import { env } from '$env/dynamic/private';
import { dbWrite } from './db';
import { getModeratorDb } from './moderator-db';
import { recordModActivity } from './mod-activity';
import { recordUserActivity } from './user-activity';
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

/** Main-app endpoints authenticated by `WEBHOOK_TOKEN` in the query string. The token must never reach
 *  the client, so every one of these is called from a form action, never proxied. */
async function callMainApp(
  path: string,
  params: Record<string, string>,
  label: string
): Promise<ActionResult> {
  const token = env.WEBHOOK_TOKEN;
  if (!token) return { ok: false, error: 'WEBHOOK_TOKEN is not configured.' };

  const base = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/$/, '');
  const query = new URLSearchParams({ ...params, token });
  try {
    const res = await fetch(`${base}${path}?${query}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `${label} returned ${res.status}.` };
    return { ok: true };
  } catch (e) {
    console.error(`[user-actions] ${label} failed`, e);
    return { ok: false, error: `${label} failed.` };
  }
}

// CACHE / SESSION REFRESH (Retool's ClearCache + RefreshSession). Both were recorded as blocked on an
// API key; they are plain webhook-token endpoints and were never blocked at all. The recurring support
// case is a user who paid and whose tier has not taken effect — this is the fix for it, and without it
// the moderator has to ask an engineer.
export async function resetSubscriptionCaches(input: {
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await callMainApp(
    '/api/mod/reset-user-subscription-caches',
    { userId: String(input.userId) },
    'Cache reset'
  );
  if (!result.ok) return result;

  await logAction('resetSubscriptionCaches', input.userId, input.moderatorId);
  return { ok: true };
}

export async function refreshSessionCache(input: {
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await callMainApp(
    '/api/admin/cache-check',
    { userId: String(input.userId), reset: 'true' },
    'Session refresh'
  );
  if (!result.ok) return result;

  await logAction('refreshSession', input.userId, input.moderatorId);
  return { ok: true };
}

async function logAction(activity: string, targetUserId: number, moderatorId: number) {
  await recordModActivity({
    userId: moderatorId,
    entityType: 'user',
    entityId: targetUserId,
    activity,
  });
}

// `activity` is a parameter because the timed-mute paths apply the same account change for a different
// reason. Letting them reuse the default would record a 24-hour mute as a plain `mute`, and a revoke as a
// manual `unmute` — the audit panel could no longer tell them apart.
export async function setMuted(input: {
  userId: number;
  muted: boolean;
  moderatorId: number;
  activity?: string;
}): Promise<ActionResult> {
  const now = new Date();
  const result = await dbWrite
    .updateTable('User')
    .set({ muted: input.muted, mutedAt: input.muted ? now : null })
    .where('id', '=', input.userId)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows ?? 0) === 0) return { ok: false, error: 'User not found.' };

  // Without this the mute does not take effect until the user's session refreshes.
  await invalidateUserSessions(input.userId);
  await logAction(
    input.activity ?? (input.muted ? 'mute' : 'unmute'),
    input.userId,
    input.moderatorId
  );
  await recordUserActivity(input.muted ? 'Muted' : 'Unmuted', input.userId, input.moderatorId);
  return { ok: true };
}

/** Unmute AND retire every open timed mute, so the account state and the schedule cannot disagree. */
export async function unmuteAndClearTimed(input: {
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await setMuted({ userId: input.userId, muted: false, moderatorId: input.moderatorId });
  if (!result.ok) return result;

  await getModeratorDb()
    .updateTable('TimedMutes')
    .set({ isMuted: false, muteEnd: new Date() })
    .where('userId', '=', String(input.userId))
    .where('isMuted', 'is not', false)
    .execute();
  return { ok: true };
}

export async function forceLogout(input: {
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const exists = await dbWrite
    .selectFrom('User')
    .select('id')
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!exists) return { ok: false, error: 'User not found.' };

  await invalidateUserSessions(input.userId);
  await logAction('forceLogout', input.userId, input.moderatorId);
  return { ok: true };
}

// `/api/mod/ban-user` parses `reasonCode` as `z.enum(BanReasonCode)` BEFORE it answers, and the endpoint
// has no catch — so anything outside this list is a 500 and no ban. Authority is the main app's
// `BanReasonCode` in `src/server/common/enums.ts`; kept here rather than in `@civitai/shared` because this
// is the only spoke that bans. Promote it if a second one appears.
//
// `SexualMinor` additionally drives the main app's default media purge, which free text could never reach.
export const BAN_REASON_CODES = [
  'SexualMinor',
  'SexualMinorGenerator',
  'SexualMinorTraining',
  'SexualPOI',
  'Bestiality',
  'Scat',
  'Nudify',
  'Harassment',
  'LeaderboardCheating',
  'BuzzCheating',
  'RRDViolation',
  'Other',
] as const;

export type BanReasonCode = (typeof BAN_REASON_CODES)[number];

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

  const params: Record<string, string> = { userId: String(input.userId) };
  if (input.ban && input.reasonCode) params.reasonCode = input.reasonCode;
  if (input.ban && input.detailsInternal) params.detailsInternal = input.detailsInternal;

  const result = await callMainApp('/api/mod/ban-user', params, 'Ban endpoint');
  if (!result.ok) return result;

  await logAction(input.ban ? 'ban' : 'unban', input.userId, input.moderatorId);
  return { ok: true };
}

// PROFILE TEXT (Retool's UpdateUserDeets / UpdateUserProfile). The moderation case is a bio, profile
// message or location used as an advertising or abuse surface: the text has to come off the site
// without banning the account over it.
//
// Only the three free-text fields are writable. Retool's GUI write pointed at the whole `User` row,
// which put username and email one mis-click from being overwritten.
export type ProfileField = 'bio' | 'message' | 'location';
const PROFILE_FIELDS: ProfileField[] = ['bio', 'message', 'location'];

export async function clearProfileText(input: {
  userId: number;
  fields: ProfileField[];
  moderatorId: number;
}): Promise<ActionResult> {
  const fields = input.fields.filter((f) => PROFILE_FIELDS.includes(f));
  if (!fields.length) return { ok: false, error: 'Nothing selected to clear.' };

  const result = await dbWrite
    .updateTable('UserProfile')
    .set(Object.fromEntries(fields.map((f) => [f, null])))
    .where('userId', '=', input.userId)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows ?? 0) === 0)
    return { ok: false, error: 'This account has no profile row to edit.' };

  await logAction(`clearProfile:${fields.join('+')}`, input.userId, input.moderatorId);
  return { ok: true };
}

// SOCIAL LINKS (Retool's InsertNewSocial / NullSelectedSocial). Removal is the moderation action —
// the shared-link panel is how a spam ring is found, and taking the link down is the follow-up.
const LINK_TYPES = ['Sponsorship', 'Social', 'Other'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export async function removeSocial(input: {
  id: number;
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  // Scoped by userId as well as id: filtering on id alone would let a stale or forged value delete
  // another account's link and log it against this one.
  const result = await dbWrite
    .deleteFrom('UserLink')
    .where('id', '=', input.id)
    .where('userId', '=', input.userId)
    .executeTakeFirst();

  if (Number(result.numDeletedRows ?? 0) === 0)
    return { ok: false, error: 'That link does not belong to this user.' };

  await logAction('removeSocial', input.userId, input.moderatorId);
  return { ok: true };
}

export async function addSocial(input: {
  userId: number;
  url: string;
  type: LinkType;
  moderatorId: number;
}): Promise<ActionResult> {
  const exists = await dbWrite
    .selectFrom('User')
    .select('id')
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!exists) return { ok: false, error: 'User not found.' };

  await dbWrite
    .insertInto('UserLink')
    .values({ userId: input.userId, url: input.url, type: input.type })
    .execute();

  await logAction('addSocial', input.userId, input.moderatorId);
  return { ok: true };
}

// MODERATION FLAGS on the moderator database's UserNotes row (Retool's RemoveDeserveMute).
// `spamWhitelist` exempts an account from spam heuristics and `deservedMute` marks a mute as earned;
// both have been in the schema and readable by nothing, so a whitelisted account looked identical to
// an un-whitelisted one.
//
// The row is per-user but `UserNotes` holds MANY rows per user, so the flags are set across all of
// them — matching how Retool's GUI write behaved, and keeping the flag a property of the account
// rather than of whichever note happened to be edited last.
export type ModerationFlag = 'spamWhitelist' | 'deservedMute';

export async function setModerationFlag(input: {
  userId: number;
  flag: ModerationFlag;
  value: boolean;
  author: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const db = getModeratorDb();
  const result = await db
    .updateTable('UserNotes')
    .set({ [input.flag]: input.value })
    .where('userId', '=', input.userId)
    .executeTakeFirst();

  // No note row yet — create one carrying the flag, or the toggle silently does nothing on exactly
  // the accounts no moderator has written about.
  if (Number(result.numUpdatedRows ?? 0) === 0) {
    await db
      .insertInto('UserNotes')
      .values({
        userId: input.userId,
        notes: null,
        lastUpdate: new Date(),
        lastUpdateBy: input.author,
        [input.flag]: input.value,
      })
      .execute();
  }

  await logAction(`${input.flag}:${input.value}`, input.userId, input.moderatorId);
  return { ok: true };
}

// TIMED MUTES — moderator database. Retool's ActivateSystemMute / RevokeTimedMutes / ViewMutes.
// The table is empty as of 2026-08-06, so this is built to the schema rather than to observed usage.
//
// RETOOL AND THIS APP DISAGREE ABOUT WHAT AN ACTIVE MUTE IS, and both are live. Retool's model is "row
// exists = mute exists": `ViewMutes` never selects `isMuted`, and `RevokeTimedMutes` DELETEs the row.
// `isMuted` defaults to FALSE, so a mute created through Retool's GUI write lands with `isMuted = false`.
// Reading `isMuted` alone would therefore render a live Retool mute as "ended".
//
// So active is derived from BOTH: the row has not been explicitly revoked AND its end is in the future.
// That reads a Retool-created row correctly and a spoke-created one correctly, and it finally uses
// `muteEnd`, which is the whole point of a timed mute and which nothing previously consulted.
export type TimedMute = {
  id: number;
  muteStart: Date | null;
  muteEnd: Date | null;
  createdBy: string | null;
  muteReason: string | null;
  active: boolean;
};

const isActive = (row: { muteEnd: Date | null; isMuted: boolean | null }, now: Date) =>
  row.isMuted !== false && (row.muteEnd === null || row.muteEnd > now);

export async function getTimedMutes(userId: number): Promise<TimedMute[]> {
  const rows = await getModeratorDb()
    .selectFrom('TimedMutes')
    .select(['id', 'muteStart', 'muteEnd', 'createdBy', 'muteReason', 'isMuted'])
    // `userId` is TEXT in this table while every sibling uses integer — see moderator-db-types.
    .where('userId', '=', String(userId))
    .orderBy('muteStart', 'desc')
    .execute();

  const now = new Date();
  return rows.map(({ isMuted, ...row }) => ({ ...row, active: isActive({ ...row, isMuted }, now) }));
}

/** Does the user still have any timed mute in force? Used to decide whether lifting one should lift the
 *  account mute — revoking one row must not unmute someone who is under a second mute, or who was
 *  permanently muted before a timed one was layered on top. */
async function hasOtherActiveTimedMute(userId: number, excludeId: number): Promise<boolean> {
  const rows = await getModeratorDb()
    .selectFrom('TimedMutes')
    .select(['muteEnd', 'isMuted'])
    .where('userId', '=', String(userId))
    .where('id', '!=', excludeId)
    .execute();
  const now = new Date();
  return rows.some((r) => isActive(r, now));
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
  return setMuted({
    userId: input.userId,
    muted: true,
    moderatorId: input.moderatorId,
    activity: 'timedMute',
  });
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

  // Lifting the account mute is only correct when nothing else is holding it down.
  if (await hasOtherActiveTimedMute(input.userId, input.id)) return { ok: true };

  return setMuted({
    userId: input.userId,
    muted: false,
    moderatorId: input.moderatorId,
    activity: 'revokeTimedMute',
  });
}
