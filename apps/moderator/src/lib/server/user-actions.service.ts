import { z } from 'zod';
import {
  HOLD_UNKNOWN_REFUSAL,
  LEGAL_HOLD_REFUSAL,
  LEGAL_HOLD_STOPPED,
  LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE,
  type DeleteHold,
} from '$lib/legal-hold';
import { PURGE_UNCONFIRMED_ACTIVITY } from '$lib/mod-activity';
import { purgeWarning } from '$lib/purge-result';
import { env } from '$env/dynamic/private';
import type { MembershipCodeTier } from '$lib/membership-code';
import { civitaiAppUrl } from './civitai-url';
import { getRequestEvent } from '$app/server';
import type { Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  BOX_OPENING_REWARD_STATUS,
  boxOpenClaimKey,
  MOD_GRANT_SOURCE_PREFIX,
} from '@civitai/shared/mystery-box';
import { dbRead, dbWrite } from './db';
import { getBuzz } from './buzz';
import { bustUserCosmeticCaches } from './cache';
import { logAxiomError } from './axiom';
import { ITEM_HOLDER_BUSY_MESSAGE, isItemHolderBusy, lockItemHolder } from './item-holder-lock';
import { getModeratorDb } from './moderator-db';
import { recordModActivity } from './mod-activity';
import { recordUserActivity } from './user-activity';
import { responseMayHaveLanded, restErrorReason } from './rest-error-reason';
import { invalidateUserSessions } from './sessions';
import { PROFILE_FIELD_KEYS, alwaysRemovesMedia, type ProfileField } from '$lib/enforcement';
import type { HeldSummary } from './removal-hold';

// Enforcement actions from User Lookup (Retool's BANAPI / UNBANAPI / ToggleMute / forceLogout, ticket
// 868kkxqpn §1.2).
//
// Split by who owns the side effects:
//   - mute / unmute / force logout are done HERE (Kysely + session revocation), because the spoke owns
//     its mutations and doing it locally keeps the acting moderator in ModActivity.
//   - ban / unban delegates to the main app's /api/mod/ban-user, which also purges media and models,
//     sends notifications and busts caches. Reimplementing that here would be a second source of truth.
//
// Actions log to ModActivity with the REAL moderator id, except `deleteAccount` and
// `removePlacement`, whose endpoints write their own row, and `voteOnImageTags`, which only the
// endpoint's ClickHouse audit records. The ban endpoint records itself as
// `userId: -1` internally, so without this log a ban would have no attribution at all.

export type ActionResult =
  | {
      ok: true;
      warning?: string;
      /** A minor revert undid the automation; the model stays minor. */ keptMinor?: true;
    }
  | { ok: false; error: string; retryAfterSeconds?: number };

/** Main-app endpoints authenticated by `WEBHOOK_TOKEN` in the query string. The token must never reach
 *  the client, so every one of these is called from a form action, never proxied. */
async function callMainApp(
  path: string,
  params: Record<string, string>,
  label: string
): Promise<ActionResult> {
  const token = env.WEBHOOK_TOKEN;
  if (!token) return { ok: false, error: 'WEBHOOK_TOKEN is not configured.' };

  const base = civitaiAppUrl();
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

/**
 * A failure reports facts rather than a verdict, because only the caller knows whether its own
 * action was mutating and therefore what a lost response means.
 *
 * 🔴 `requestNeverSent` is deliberately NOT the negation of "we got an error". `fetch` rejects with
 * the same `TypeError: fetch failed` whether nothing was listening (`cause.code ECONNREFUSED`) or
 * the socket died mid-request after the server had already acted (`UND_ERR_SOCKET`) — name and
 * message are identical and only `cause.code` separates them. So after a send this is true ONLY for
 * the codes that prove the request never left, and false for everything else including an abort. Getting that
 * default backwards tells an operator a completed, irreversible action failed.
 *
 * `status` is the response status when the far side answered at all — an intermediary's 504 is a
 * lost response, not a refusal, and the caller needs to see it to say so.
 */
export type JsonResult =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      error: string;
      requestNeverSent?: boolean;
      /** No session to forward — no cookie, or no request in scope; the request was never sent. */
      noSession?: true;
      status?: number;
      /** The recovered text alone, without the action label, so a caller that overrides the message
       *  can still carry what the far side said. */
      reason?: string;
      /** A rate-limit refusal's `Retry-After`: the request was refused before the endpoint acted, so
       *  it is safe to send again once this has passed. */
      retryAfterSeconds?: number;
    };

/** The refusal an endpoint wrote for the operator. A rate limit also carries how long is left, which
 *  is the difference between "try later" and a moderator retrying immediately.
 *
 *  The body-shape rule lives in `./rest-error-reason` because the main app emits TWO envelopes and
 *  reading only one drops the reason — see that file. It is kept import-free so the main app's suite
 *  can drive the real emitter into this real reader in one process. */
async function readError(res: Response): Promise<string | null> {
  return restErrorReason(await res.json().catch(() => null), res.status);
}

/** The one JSON poster. Two auth schemes because the endpoint families disagree, not because the
 *  callers do — everything else about them was identical and drifted independently. */
async function postJson(opts: {
  path: string;
  /** Sent as the JSON body, or as the query string when `method` is `GET`. */
  body: Record<string, unknown>;
  /** Always sent in the query string, for endpoints that read their input from it. */
  query?: Record<string, string>;
  method?: 'GET' | 'POST';
  label: string;
  auth: 'webhook' | 'session';
  timeoutMs: number;
  /** `'session'` only: forward this cookie instead of the current request's. */
  cookie?: string;
}): Promise<JsonResult> {
  const base = civitaiAppUrl();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let url = `${base}${opts.path}`;

  if (opts.auth === 'session') {
    // Throws when there is no request in scope (a job, a script). That is a programming error rather
    // than a runtime condition, but it must not surface to the operator as a bare 500.
    let cookie: string | null;
    if (opts.cookie !== undefined) cookie = opts.cookie;
    else
      try {
        cookie = getRequestEvent().request.headers.get('cookie');
      } catch {
        return {
          ok: false,
          error: `${opts.label} must be called while handling a request.`,
          requestNeverSent: true,
          noSession: true,
        };
      }
    if (!cookie)
      return {
        ok: false,
        error: `${opts.label} failed: no session to forward.`,
        requestNeverSent: true,
        noSession: true,
      };
    headers.cookie = cookie;
  } else {
    const token = env.WEBHOOK_TOKEN;
    if (!token)
      return { ok: false, error: 'WEBHOOK_TOKEN is not configured.', requestNeverSent: true };
    url += `?token=${encodeURIComponent(token)}`;
  }

  if (opts.query)
    url += `${url.includes('?') ? '&' : '?'}${new URLSearchParams(opts.query).toString()}`;

  const isGet = opts.method === 'GET';
  if (isGet) {
    const query = new URLSearchParams(
      Object.entries(opts.body)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ).toString();
    if (query) url += `${url.includes('?') ? '&' : '?'}${query}`;
  }

  try {
    const res = await fetch(url, {
      method: isGet ? 'GET' : 'POST',
      headers,
      ...(isGet ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      // The endpoint writes its refusal FOR a human — which permission is missing, how long the rate
      // limit has left. Reducing that to a status code is what makes a moderator retry the same
      // forbidden action, or re-login against a 403 that re-logging in cannot fix.
      const reason = await readError(res);
      const retryAfter = res.status === 429 ? Number(res.headers.get('retry-after')) : NaN;
      const retryAfterSeconds = retryAfter > 0 ? retryAfter : undefined;
      // Recovered = the body parsed as the envelope this app reads. It is NOT proof the app wrote it.
      if (reason)
        return {
          ok: false,
          error: `${opts.label}: ${reason}`,
          status: res.status,
          reason,
          retryAfterSeconds,
        };
      return {
        ok: false,
        error: `${opts.label} returned ${res.status}.`,
        status: res.status,
        retryAfterSeconds,
      };
    }
    return {
      ok: true,
      body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    };
  } catch (e) {
    console.error(`[user-actions] ${opts.label} failed`, e);
    // Fails SAFE: anything not on this list is treated as possibly-delivered. An abort
    // (`TimeoutError`) and a mid-flight socket death both land here and both mean the far side may
    // have acted.
    const code = (e as { cause?: { code?: string } } | null)?.cause?.code;
    const requestNeverSent =
      code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
    return { ok: false, error: `${opts.label} failed.`, requestNeverSent };
  }
}

/**
 * Every `/api/mod/*` route the spoke calls through `callModEndpoint`. A bare string would make a
 * typo a 404 that reads as a failed action; this makes it a compile error. Replaced by the
 * generated client when that lands.
 */
export type ModEndpoint =
  | 'bounty-entry-file/clear-check'
  | 'bounty-entry-file/reblock-check'
  | 'bounty-poi/resolve-appeal'
  | 'comment/bulk-delete'
  | 'comment/remove-as-tos'
  | 'comment/restore-from-tos'
  | 'cosmetic/holdings-removed'
  | 'messages/claim'
  | 'messages/release'
  | 'creator-services/resolve-dispute'
  | 'csam/training-data-report'
  | 'image/tag-vote'
  | 'minor-flag/confirm'
  | 'minor-flag/dismiss'
  | 'minor-flag/resolve-appeal'
  | 'minor-flag/resolve-redetection'
  | 'minor-flag/revert'
  | 'minor-flag/rule'
  | 'minor-flag/set-minor'
  | 'model/bring-back'
  | 'model/republish'
  | 'model/set-sfw-only'
  | 'model/set-poi'
  | 'model/take-down'
  | 'model/unpublish'
  | 'poi-flag/confirm'
  | 'poi-flag/dismiss'
  | 'poi-flag/flag-match'
  | 'poi-flag/revert'
  | 'restriction/resolve'
  | 'review/delete'
  | 'review/set-exclude'
  | 'storyline/lift-title-takedown'
  | 'storyline/resolve-title-appeal'
  | 'strike/create'
  | 'strike/void'
  | 'text-scan'
  | 'text-scan/csam-hold/resolve'
  | 'text-scan/model-rules-hold/resolve'
  | 'training-data/resolve'
  | 'user/creator-score-grant'
  | 'user/creator-score-grant-revoke'
  | 'user/delete'
  | 'user/membership-code'
  | 'user/membership-code-revoke'
  | 'user/message-as-civitai'
  | 'user/remove-reactions'
  | 'user/toggle-moderator'
  | 'user/unmute'
  | 'user/update-identity';

// `/api/mod/*` (defineModeratorEndpoint) authenticates as the MODERATOR who is acting: the spoke is on
// the same registrable domain as the hub, so the session cookie the browser sent here is one the hub
// already accepts, and relaying it server-side attributes the audit row to a person rather than to a
// shared key. This app therefore needs no moderator API key at all.
/** One `/api/mod/*` endpoint per action, called as the acting moderator. With `bustModelVersionCache`,
 *  the only places `auth` becomes `'session'` — a call site that picks its own scheme is how one gets
 *  the wrong one. */
export const callModEndpoint = (
  path: ModEndpoint,
  body: Record<string, unknown>,
  label: string,
  timeoutMs = 30_000
): Promise<JsonResult> =>
  postJson({ path: `/api/mod/${path}`, body, label, auth: 'session', timeoutMs });

/** The read-only `/api/mod/*` routes; kept apart from `ModEndpoint` so a read cannot be sent as a write. */
export type ModReadEndpoint =
  | 'creator-services/deal-file-url'
  | 'creator-services/deal-files'
  | 'creator-services/disputes'
  | 'messages/inbox'
  | 'messages/thread'
  | 'user/legal-hold'
  | 'user/reactions';

/** `callModEndpoint`'s GET twin: `params` ride in the query string, undefined ones are dropped. */
export const readModEndpoint = (
  path: ModReadEndpoint,
  params: Record<string, string | number | undefined>,
  label: string,
  timeoutMs = 15_000
): Promise<JsonResult> =>
  postJson({
    path: `/api/mod/${path}`,
    body: params,
    method: 'GET',
    label,
    auth: 'session',
    timeoutMs,
  });

/** `callModEndpoint` for work that outlives its request, with a cookie read earlier by `requestCookie`. */
export const callModEndpointAs = (
  cookie: string,
  path: ModEndpoint,
  body: Record<string, unknown>,
  label: string,
  timeoutMs = 30_000
): Promise<JsonResult> =>
  postJson({ path: `/api/mod/${path}`, body, label, auth: 'session', timeoutMs, cookie });

/**
 * The session cookie of the request being handled; null outside a request or without one.
 * It is the moderator's session: keep it in memory only, never log or store it.
 */
export function requestCookie(): string | null {
  try {
    return getRequestEvent().request.headers.get('cookie') || null;
  } catch {
    return null;
  }
}

// Best-effort: the resolve already committed, and a missed bust is a stale read that expires with the cache.
export const bustModelVersionCache = (versionIds: number[]): Promise<JsonResult> =>
  postJson({
    path: '/api/v1/model-versions/bust-cache',
    body: { versionIds },
    label: 'Refresh model caches',
    auth: 'session',
    timeoutMs: 3000,
  });

/**
 * Retool's `UpdateUserDeets`, behind the Enable Edits toggle. The endpoint already carries this and
 * gates it on the `retoolUpdateIdentity` permission — the per-capability grant the ticket asks for —
 * so this is a call, not a new write path. Only the fields the moderator changed are sent.
 */
export async function updateUserIdentity(input: {
  userId: number;
  username?: string;
  email?: string;
  name?: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const changed: Record<string, unknown> = {};
  if (input.username !== undefined) changed.username = input.username;
  if (input.email !== undefined) changed.email = input.email;
  if (input.name !== undefined) changed.name = input.name;
  if (!Object.keys(changed).length) return { ok: false, error: 'Nothing to change.' };

  const result = await callModEndpoint(
    'user/update-identity',
    { userId: input.userId, ...changed },
    'Identity update'
  );
  if (!result.ok) return result;

  await logAction(
    `updateIdentity:${Object.keys(changed).join(',')}`,
    input.userId,
    input.moderatorId
  );
  return { ok: true };
}

/** Retool's Make/Remove Moderator, gated on `retoolToggleModerator` at the endpoint. */
export async function toggleModerator(input: {
  userId: number;
  isModerator: boolean;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await callModEndpoint(
    'user/toggle-moderator',
    { userId: input.userId, isModerator: input.isModerator },
    'Moderator toggle'
  );
  if (!result.ok) return result;

  await logAction(`toggleModerator:${input.isModerator}`, input.userId, input.moderatorId);
  return { ok: true };
}

/**
 * Retool's `TagVote`, through `/api/mod/image/tag-vote`. The endpoint applies the moderator vote weight
 * itself, so callers pass a plain ±1 and the number that decides whether a tag is disabled stays in
 * one place — the main app's `addTagVotes`.
 */
export async function voteOnImageTags(
  votes: { imageId: number; tagId: number; vote: -1 | 0 | 1 }[]
): Promise<ActionResult> {
  if (!votes.length) return { ok: false, error: 'No votes to record.' };
  const result = await callModEndpoint('image/tag-vote', { votes }, 'Tag vote');
  return result.ok ? { ok: true } : result;
}

const countOf = (body: Record<string, unknown>, keys: string[]) =>
  keys.reduce((sum, k) => sum + (typeof body[k] === 'number' ? (body[k] as number) : 0), 0);

// BULK COMMENT ACTIONS (Retool's DeleteComments / ToSComments). Both tables in one call, matching the
// endpoint's contract and Retool's Model Comments / Other Comments split.
export async function bulkCommentAction(input: {
  action: 'bulkDelete' | 'removeAsTos' | 'restoreFromTos';
  commentIds: number[];
  commentV2Ids: number[];
  userId: number;
  moderatorId: number;
}): Promise<ActionResult & { affected?: number; retainedHidden?: number }> {
  if (!input.commentIds.length && !input.commentV2Ids.length)
    return { ok: false, error: 'Select at least one comment.' };

  const ENDPOINTS = {
    bulkDelete: ['comment/bulk-delete', 'Comment delete'],
    removeAsTos: ['comment/remove-as-tos', 'Comment ToS'],
    restoreFromTos: ['comment/restore-from-tos', 'Comment ToS restore'],
  } as const;
  const [path, label] = ENDPOINTS[input.action];

  const result = await callModEndpoint(
    path,
    { commentIds: input.commentIds, commentV2Ids: input.commentV2Ids },
    label
  );
  if (!result.ok) return result;

  // `removeAsTos` nests its counts per table; `bulkDelete` returns them flat.
  const nested = (key: string, field = 'count') => {
    const section = result.body[key];
    return section && typeof section === 'object'
      ? countOf(section as Record<string, unknown>, [field])
      : 0;
  };
  // `restoreFromTos` nests per table exactly like `removeAsTos`; only `bulkDelete` is flat.
  const affected =
    input.action === 'bulkDelete'
      ? countOf(result.body, ['commentDeleted', 'commentV2Deleted'])
      : nested('comment') + nested('commentV2');

  // A delete or a restore keeps some comments hidden; the endpoint never says why, and neither does this.
  const retainedHidden =
    input.action === 'bulkDelete'
      ? countOf(result.body, ['retainedHidden'])
      : input.action === 'restoreFromTos'
      ? nested('comment', 'retainedHidden') + nested('commentV2', 'retainedHidden')
      : 0;

  const failed =
    input.action === 'restoreFromTos'
      ? nested('comment', 'failed') + nested('commentV2', 'failed')
      : 0;

  // Reporting success on zero would write a ModActivity row attributing a deletion that did not happen.
  if (affected === 0 && retainedHidden === 0 && failed === 0)
    return {
      ok: false,
      error:
        input.action === 'restoreFromTos'
          ? 'Nothing changed — those comments may not be flagged. Reload.'
          : 'Nothing changed — those comments may already be gone. Reload.',
    };

  if (affected)
    await logAction(`comments:${input.action}:${affected}`, input.userId, input.moderatorId);
  if (retainedHidden)
    await logAction(
      `comments:${input.action}:retainedHidden:${retainedHidden}`,
      input.userId,
      input.moderatorId
    );
  if (failed)
    return {
      ok: false,
      error: `${failed} could not be restored and stay hidden. Restored ${affected}, kept hidden ${retainedHidden}.`,
    };
  // Both endpoints count rows they actually wrote, so a short count is real.
  return { ok: true, affected, retainedHidden };
}

// BULK REVIEW ACTIONS (Retool's DeleteReview / ExcludeOrIncludeReview).
// The main app's review endpoints reject more than 500 ids in one call.
const REVIEW_BATCH = 500;

export async function bulkReviewAction(input: {
  action: 'delete' | 'setExclude';
  reviewIds: number[];
  exclude?: boolean;
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  if (!input.reviewIds.length) return { ok: false, error: 'Select at least one review.' };

  let affected = 0;
  for (let i = 0; i < input.reviewIds.length; i += REVIEW_BATCH) {
    const body: Record<string, unknown> = {
      reviewIds: input.reviewIds.slice(i, i + REVIEW_BATCH),
    };
    if (input.action === 'setExclude') body.exclude = input.exclude ?? true;

    const result = await callModEndpoint(
      input.action === 'delete' ? 'review/delete' : 'review/set-exclude',
      body,
      input.action === 'delete' ? 'Review delete' : 'Review exclude'
    );
    if (!result.ok) {
      if (!affected) return result;
      await logAction(`reviews:${input.action}:${affected}`, input.userId, input.moderatorId);
      return {
        ok: false,
        error: `${affected} of ${input.reviewIds.length} went through, then: ${result.error} Reload.`,
      };
    }
    affected += countOf(result.body, ['count']);
  }

  if (affected === 0)
    return { ok: false, error: 'Nothing changed — those reviews may already be gone. Reload.' };

  await logAction(`reviews:${input.action}:${affected}`, input.userId, input.moderatorId);
  return { ok: true };
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
  /** Set for a TIMED mute. Without it nothing lifts it: `processTimedUnmutes` selects on
   *  `muteExpiresAt`. */
  until?: Date | null;
  /** Why. Stored on `User.meta` beside the mute it describes rather than in `ModActivity`, whose only
   *  free-text column is `activity` — putting prose there is what made `getRetoolActivity` parse
   *  sentences to find an account. */
  reason?: string | null;
}): Promise<ActionResult> {
  if (!input.muted)
    return releaseMute({
      userId: input.userId,
      moderatorId: input.moderatorId,
      activity: 'unmute',
    });

  const now = new Date();
  // `mutedAt` is what marks this as a moderator's decision rather than an automatic one, and strike
  // escalation will neither lift nor shorten a mute carrying it. Nothing extra is needed on `meta` for
  // that — a `manualMute` flag lived here and was read by nobody.
  const metaPatch = { muteReason: input.reason ?? null, mutedBy: input.moderatorId };
  const result = await dbWrite
    .updateTable('User')
    .set({
      muted: true,
      mutedAt: now,
      muteExpiresAt: input.until ?? null,
      meta: sql`COALESCE("meta", '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb`,
    })
    .where('id', '=', input.userId)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows ?? 0) === 0) return { ok: false, error: 'User not found.' };

  // Without this the mute does not take effect until the user's session refreshes.
  await invalidateUserSessions(input.userId);
  await logAction(input.activity ?? 'mute', input.userId, input.moderatorId);
  await recordUserActivity('Muted', input.userId, input.moderatorId);
  return { ok: true };
}

/**
 * Every unmute is the main app's: it dates the unmute for the scam auto-mute, closes the scam cases
 * the unmute lifts and restores what they hid, all under the account row lock. That endpoint also
 * writes the ModActivity row against the acting moderator, so none is written here.
 */
async function releaseMute(input: {
  userId: number;
  moderatorId: number;
  activity: 'unmute' | 'revokeTimedMute';
}): Promise<ActionResult> {
  const result = await callModEndpoint(
    'user/unmute',
    { userId: input.userId, activity: input.activity },
    input.activity === 'revokeTimedMute' ? 'Revoke timed mute' : 'Unmute'
  );
  if (!result.ok) return result;
  await recordUserActivity('Unmuted', input.userId, input.moderatorId);
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

// The ban list lives in $lib/enforcement so the picker and this validator cannot drift apart.
export { BAN_REASONS as BAN_REASON_CODES, type BanReasonCode } from '$lib/enforcement';

// `/api/mod/ban-user` TOGGLES rather than setting a state, and answers 200 before it has done the work.
// Re-reading `bannedAt` and refusing when it already matches the request turns the toggle back into an
// explicit operation: a stale page that thinks the user is unbanned cannot silently unban them. The
// 200-before-work behaviour cannot be fixed from here, so callers must re-read rather than trust it.
/**
 * What a ban would take down, shown before it is confirmed. Predicates copied from HEAD's
 * `getBanContentPreview`: images not already `Blocked`, and models that are live to someone
 * (`Published`/`Scheduled`) — a count of everything they ever uploaded would overstate the blast radius.
 */
export async function getBanContentPreview(
  userId: number
): Promise<{ imageCount: number; modelCount: number }> {
  const [images, models] = await Promise.all([
    dbRead
      .selectFrom('Image')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', userId)
      .where('ingestion', '!=', 'Blocked')
      .executeTakeFirst(),
    dbRead
      .selectFrom('Model')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', userId)
      .where('status', 'in', ['Published', 'Scheduled'])
      .executeTakeFirst(),
  ]);
  return { imageCount: Number(images?.count ?? 0), modelCount: Number(models?.count ?? 0) };
}

/** Returned when the account's state already matches the request. Exported because Bulk Ban has to
 *  tell it apart from a real failure on a retry. */
export const alreadyBannedError = (ban: boolean) =>
  `User is already ${ban ? 'banned' : 'not banned'}. Reload.`;

/**
 * Has the ban actually landed? `/api/mod/ban-user` answers 200 as soon as it has parsed the request and
 * logs its failures rather than returning them, so a 200 means "accepted", never "banned".
 *
 * Polls rather than reading once, and reads the PRIMARY: the write is in flight, so a replica can
 * answer from before it. A false negative withholds a caller's follow-up action; it never bans twice.
 *
 * 🔴 Polls `banDetails.completedAt`, NOT `bannedAt`. `toggleBan` writes `bannedAt` before any of the
 * fan-out — model unpublish, media block, comment flagging, index removal, subscription cancels — so
 * confirming on it returns while every one of those is still running on the primary, and Bulk Ban's
 * checkpoint paced the loop without bounding what overlapped. `completedAt` is stamped as the last
 * statement of the ban branch, so it is the only signal that means the expensive half is done.
 *
 * ⚠️ **Deploy the main app first.** An older `toggleBan` never writes `completedAt`, so this reports
 * every ban unconfirmed and Bulk Ban stops with a 502 after its first checkpoint. There is deliberately
 * no fall back to `bannedAt`: from here a missing stamp is indistinguishable from a fan-out still in
 * flight, and falling back would silently restore the unbounded behaviour this exists to end.
 */
export async function banConfirmed(userId: number, attempts = 20): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const row = await dbWrite
      .selectFrom('User')
      .select(sql<string | null>`meta #>> '{banDetails,completedAt}'`.as('completedAt'))
      .where('id', '=', userId)
      .executeTakeFirst();
    if (row?.completedAt) return true;
  }
  return false;
}

/**
 * Has the unban landed? Same 200-before-work endpoint as `banConfirmed`. The unban branch writes no
 * completion stamp, and `bannedAt` cleared is what lets the account sign in again, so that is the signal.
 */
export async function unbanConfirmed(userId: number, attempts = 10): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const row = await dbWrite
      .selectFrom('User')
      .select('bannedAt')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (row && row.bannedAt === null) return true;
  }
  return false;
}

export async function setBanned(input: {
  userId: number;
  ban: boolean;
  reasonCode?: string;
  detailsInternal?: string;
  /** Read back by the appeal flow. Never emailed, so it is safe to collect here. */
  detailsExternal?: string;
  /** The endpoint blocks media only for minor-safety reasons unless this is set — a Nudify or
   *  Harassment ban otherwise leaves every image up and needs a second, separate purge. */
  removeMedia?: boolean;
  /** Unpublishes their models. The endpoint DEFAULTS THIS ON when the param is absent, so a caller that
   *  never sends it cannot offer the operator a choice. Send it explicitly either way. */
  removeModels?: boolean;
  /** Flags every comment on the account as a ToS violation. Nothing is deleted. */
  removeComments?: boolean;
  moderatorId: number;
}): Promise<ActionResult> {
  const current = await dbWrite
    .selectFrom('User')
    .select('bannedAt')
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!current) return { ok: false, error: 'User not found.' };

  const isBanned = current.bannedAt !== null;
  if (isBanned === input.ban) return { ok: false, error: alreadyBannedError(input.ban) };

  const params: Record<string, string> = { userId: String(input.userId) };
  if (input.ban && input.reasonCode) params.reasonCode = input.reasonCode;
  if (input.ban && input.detailsInternal) params.detailsInternal = input.detailsInternal;
  if (input.ban && input.detailsExternal) params.detailsExternal = input.detailsExternal;
  if (input.ban && (input.removeMedia || alwaysRemovesMedia(input.reasonCode)))
    params.removeMedia = 'true';
  if (input.ban && input.removeModels !== undefined)
    params.removeModels = String(input.removeModels);
  if (input.ban && input.removeComments) params.removeComments = 'true';

  const result = await callMainApp('/api/mod/ban-user', params, 'Ban endpoint');
  if (!result.ok) return result;

  await logAction(input.ban ? 'ban' : 'unban', input.userId, input.moderatorId);
  return { ok: true };
}

// BUZZ SEND / DEDUCT (Retool's BuzzSend → POST buzz.civitai.com/transaction, plus its buzzSendAction
// and buzzType option sets). The canned presets are UI config and live with the panel.
export const BUZZ_TYPES = ['yellow', 'blue', 'green'] as const;

// `type` is the LEDGER LABEL and must be sent explicitly. Omitting it either has the buzz service
// reject the body — the grant silently never happens — or defaults it to 0, which is `Tip`, so a
// moderator's compensation is recorded as a tip from account 0 and counted as one by every downstream
// report.
//
// The WHOLE enum, mirroring the main app's TransactionType (src/shared/constants/buzz.constants.ts).
// Retool's "Reason" picker was `SELECT DISTINCT type FROM buzzTransactions` — every category in live
// use — so a short hand-picked list is a moderator unable to file a transaction as what it actually is.
export const BUZZ_TRANSACTION_TYPES = {
  Tip: 0,
  Dues: 1,
  Generation: 2,
  Boost: 3,
  Incentive: 4,
  Reward: 5,
  Purchase: 6,
  Refund: 7,
  Bounty: 8,
  BountyEntry: 9,
  Training: 10,
  ChargeBack: 11,
  Donation: 12,
  ClubMembership: 13,
  ClubMembershipRefund: 14,
  ClubWithdrawal: 15,
  ClubDeposit: 16,
  Withdrawal: 17,
  Redeemable: 18,
  Sell: 19,
  AuthorizedPurchase: 20,
  Compensation: 21,
  Appeal: 22,
  Bank: 23,
  Extract: 24,
  Fee: 25,
  Bid: 26,
  LicenseFee: 27,
  AppAuthorFee: 28,
  ServiceEscrow: 29,
} as const;

export type BuzzTransactionType = keyof typeof BUZZ_TRANSACTION_TYPES;
export const BUZZ_TRANSACTION_TYPE_KEYS = Object.keys(
  BUZZ_TRANSACTION_TYPES
) as BuzzTransactionType[];
export type BuzzColor = (typeof BUZZ_TYPES)[number];

/** Account 0 is Civitai's own — the counterparty for every moderator grant or deduction. */
const CIVITAI_ACCOUNT_ID = 0;

export async function sendBuzz(input: {
  userId: number;
  amount: number;
  buzzType: BuzzColor;
  action: 'send' | 'deduct';
  transactionType: BuzzTransactionType;
  description: string;
  /** Retool's `EntityType`/`EntityId` on the send form — what the grant or deduction is ABOUT. */
  entityType?: string;
  entityId?: number;
  moderatorId: number;
}): Promise<ActionResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    return { ok: false, error: 'Amount must be a positive whole number.' };

  const toUser = input.action === 'send';
  try {
    await getBuzz().createTransaction({
      fromAccountId: toUser ? CIVITAI_ACCOUNT_ID : input.userId,
      toAccountId: toUser ? input.userId : CIVITAI_ACCOUNT_ID,
      fromAccountType: toUser ? 'yellow' : input.buzzType,
      toAccountType: toUser ? input.buzzType : 'yellow',
      type: BUZZ_TRANSACTION_TYPES[input.transactionType],
      amount: input.amount,
      description: input.description,
      // Entity linkage lives INSIDE `details` — that is where the buzz service reads it back from
      // (`details?.entityId`) and where Retool's own body put it. Sent as top-level fields it is
      // accepted, discarded, and the link a later investigation looks for is silently absent.
      details: {
        moderatorId: input.moderatorId,
        source: 'moderator-app/user-lookup',
        ...(input.entityType && input.entityId
          ? { entityType: input.entityType, entityId: input.entityId }
          : {}),
      },
    });
  } catch (e) {
    console.error('[user-actions] buzz transaction failed', e);
    return { ok: false, error: 'Buzz transaction failed.' };
  }

  await logAction(
    `buzz:${input.action}:${input.buzzType}:${input.transactionType}:${input.amount}`,
    input.userId,
    input.moderatorId
  );
  return { ok: true };
}

// STRIKES. The main app owns them (`UserStrike`), and Retool's own strike buttons called this endpoint
// — so the spoke does too. The moderator database's legacy `UserStrikes` table is Retool-era history:
// still read and shown, never written, because a row there gets none of what a real strike does —
// escalation (>=2 points auto-mutes 3 days, >=3 indefinite + session invalidation), points, expiry,
// the typed `strike-issued` notification and its email, or any way to void it.
//
// `ManualModAction` on purpose: it is the classification for a moderator-issued strike AND the one
// reason the endpoint exempts from the 1-auto-strike-per-day rate limit. Any other value and a
// moderator's second strike on the same account in one day comes back `{ skipped: true }` — a silent
// no-op that reads as success.
export async function issueStrike(input: {
  userId: number;
  /** The user-facing message. Shown to the account, so it is the canned text the moderator picked. */
  description: string;
  internalNotes?: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await callModEndpoint(
    'strike/create',
    {
      userId: input.userId,
      reason: 'ManualModAction',
      description: input.description,
      ...(input.internalNotes ? { internalNotes: input.internalNotes } : {}),
    },
    'Strike endpoint',
    15_000
  );
  if (!result.ok) return result;

  // `{ skipped: true }` is the rate-limit path. It returns 200, so without this a refused strike is
  // indistinguishable from an issued one.
  if (result.body?.skipped === true)
    return { ok: false, error: 'The strike was rate-limited and NOT issued.' };

  await logAction('issueStrike', input.userId, input.moderatorId);
  return { ok: true };
}

/** Voids one strike through the main app, which re-evaluates the account's escalation from the new
 *  point total. `voidedBy` is the acting moderator, from the relayed session. */
export async function voidStrike(input: {
  strikeId: number;
  voidReason: string;
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await callModEndpoint(
    'strike/void',
    { strikeId: input.strikeId, voidReason: input.voidReason },
    'Void strike',
    15_000
  );
  if (!result.ok) return result;

  await logAction('voidStrike', input.userId, input.moderatorId);
  return { ok: true };
}

// GENERATION RESTRICTIONS. A system restriction leaves the account muted with a Pending
// `UserRestriction` row, and the mute toggle beside it resolves NOTHING: the row stays Pending, the
// cancelled subscription stays cancelled, the prohibited-request count stays where it was, and the
// user is never told which way it went. `resolveUserRestriction` in the main app does all of that in
// one write, and this is the only way to reach it from here.
export async function resolveRestriction(input: {
  userRestrictionId: number;
  status: 'Overturned' | 'Upheld';
  resolvedMessage?: string;
  resolvedReason: string;
  internalNotes?: string;
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await callModEndpoint(
    'restriction/resolve',
    {
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      resolvedReason: input.resolvedReason,
      ...(input.resolvedMessage ? { resolvedMessage: input.resolvedMessage } : {}),
      ...(input.internalNotes ? { internalNotes: input.internalNotes } : {}),
    },
    'Restriction ruling'
  );
  if (!result.ok) return result;

  await logAction(`restriction:${input.status.toLowerCase()}`, input.userId, input.moderatorId);
  return { ok: true };
}

// REWARDS ELIGIBILITY (Retool's UpdateBuzzEligible → /api/mod/set-rewards-eligibility).
export async function setRewardsEligibility(input: {
  userId: number;
  eligibility: string;
  moderatorId: number;
}): Promise<ActionResult> {
  // Body, not query string: the endpoint parses `req.body`, and `modId` is required — it is what drives
  // its own ModActivity row, the multiplier cache refresh and the user's notification.
  const result = await postJson({
    path: '/api/mod/set-rewards-eligibility',
    body: {
      userId: input.userId,
      eligibility: input.eligibility,
      modId: input.moderatorId,
    },
    label: 'Rewards eligibility',
    auth: 'webhook',
    timeoutMs: 15_000,
  });
  if (!result.ok) return result;

  await logAction(`rewardsEligibility:${input.eligibility}`, input.userId, input.moderatorId);
  return { ok: true };
}

// SHOP REFUND (Retool's DeleteUserCosmetic + UpdateShopTransaction + LogShopRefund).
//
// Flagging the purchase refunded and taking back what it granted must not half-apply: one without the
// other either leaves the user holding something they were paid back for, or makes the purchase
// refundable twice. Hence one transaction.
//
// Retool deleted by `claimKey` ALONE. `UserCosmetic.claimKey` defaults to the literal 'claimed' for
// anything not bought from the shop, so that statement was one mistyped key away from deleting every
// claimed cosmetic on the site. Scoped by userId here, and to the specific purchase.
//
// The Buzz is NOT returned automatically — Retool did not do it either, and a refund whose amount is
// decided here rather than by the moderator is the wrong default for a money path. Use the Buzz panel.
export async function refundShopPurchase(input: {
  userId: number;
  buzzTransactionId: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const purchase = await dbWrite
    .selectFrom('UserCosmeticShopPurchases as p')
    .innerJoin('CosmeticShopItem as csi', 'csi.id', 'p.shopItemId')
    .select(['p.refunded', 'csi.itemDefinitionId'])
    .where('p.buzzTransactionId', '=', input.buzzTransactionId)
    .where('p.userId', '=', input.userId)
    .executeTakeFirst();

  if (!purchase) return { ok: false, error: 'That purchase does not belong to this user.' };
  if (purchase.refunded) return { ok: false, error: 'That purchase is already refunded.' };

  let removed: RemovedHolding[];
  try {
    removed = await dbWrite.transaction().execute(async (trx) => {
      // A box open reads the held box and writes its opening under this lock; without it the refund
      // could find neither while the open commits.
      await lockItemHolder(trx, input.userId);

      const flagged = await trx
        .updateTable('UserCosmeticShopPurchases')
        .set({ refunded: true })
        .where('buzzTransactionId', '=', input.buzzTransactionId)
        .where('userId', '=', input.userId)
        .where('refunded', '=', false)
        .executeTakeFirst();
      if (Number(flagged.numUpdatedRows) === 0)
        throw new RefundRefused('That purchase is already refunded.');

      // Routed by the listing, not by a NULL `cosmeticId`: a box purchase has none either.
      return purchase.itemDefinitionId != null
        ? takeBackBox(trx, {
            userId: input.userId,
            sourceKey: input.buzzTransactionId,
            boxDefinitionId: purchase.itemDefinitionId,
          })
        : takeBackCosmetics(trx, input);
    });
  } catch (error) {
    if (error instanceof RefundRefused) return { ok: false, error: error.message };
    if (isItemHolderBusy(error)) return { ok: false, error: ITEM_HOLDER_BUSY_MESSAGE };
    throw error;
  }

  // The main app serves equipped cosmetics from a day-TTL cache with no stale-while-revalidate, so
  // without this the refunded badge or frame keeps rendering on their profile, comments and images for
  // up to 24 hours after the panel says it is gone.
  await bustUserCosmeticCaches(input.userId);
  const warning = await refreshRemovedHoldings(removed, 'Refunded');

  await logAction('shopRefund', input.userId, input.moderatorId);
  return { ok: true, warning };
}

/** A refusal found inside the refund transaction; thrown to roll it back. */
class RefundRefused extends Error {}

type RefundTarget = { userId: number; buzzTransactionId: string };

const REMOVED_HOLDING = ['userId', 'cosmeticId', 'equippedToId', 'equippedToType'] as const;
type RemovedHolding = {
  userId: number;
  cosmeticId: number;
  equippedToId: number | null;
  equippedToType: string | null;
};

/**
 * Never a failure: the take-back has already committed and a retry would be refused. Returns a warning
 * for the moderator and logs to Axiom instead.
 */
async function refreshRemovedHoldings(removed: RemovedHolding[], done: string) {
  const equipped = removed.flatMap(({ equippedToId, equippedToType, ...row }) =>
    equippedToId != null && equippedToType != null ? [{ ...row, equippedToId, equippedToType }] : []
  );
  if (!equipped.length) return undefined;

  const result = await callModEndpoint(
    'cosmetic/holdings-removed',
    { removed: equipped },
    'Cosmetic refresh'
  );
  if (result.ok) return undefined;
  void logAxiomError(new Error(result.error), {
    event: 'moderator-holdings-refresh',
    userIds: [...new Set(equipped.map((r) => r.userId))],
    cosmeticIds: [...new Set(equipped.map((r) => r.cosmeticId))],
  });
  return `${done}. The site's caches didn't refresh, so it may keep showing on their profile and content until those expire.`;
}

/**
 * The cosmetics a shelf purchase granted, all under its transaction id as `claimKey`: its one cosmetic,
 * or a pack's components. A pack member the buyer already owned was never granted, so has no such row.
 * Correct only while nothing else grants under a purchase's id.
 */
function takeBackCosmetics(trx: Transaction<DB>, { userId, buzzTransactionId }: RefundTarget) {
  return trx
    .deleteFrom('UserCosmetic')
    .where('userId', '=', userId)
    .where('claimKey', '=', buzzTransactionId)
    .returning(REMOVED_HOLDING)
    .execute();
}

/**
 * The held box, or once opened, its reward. The opening stays as the record of the draw, marked
 * refunded; it still counts as drawn, so the box cannot hand that reward to this user again.
 * `sourceKey` is what granted the box: a purchase's transaction id, or a moderator grant's key.
 */
async function takeBackBox(
  trx: Transaction<DB>,
  {
    userId,
    sourceKey,
    boxDefinitionId,
  }: { userId: number; sourceKey: string; boxDefinitionId: number }
) {
  const held = await trx
    .deleteFrom('Item')
    .where('sourceKey', '=', sourceKey)
    .where('itemDefinitionId', '=', boxDefinitionId)
    .where('holderType', '=', 'user')
    .where('holderId', '=', userId)
    .executeTakeFirst();
  if (Number(held.numDeletedRows) > 0) return [];

  const opening = await trx
    .updateTable('BoxOpening')
    .set({ rewardStatus: BOX_OPENING_REWARD_STATUS.refunded })
    .where('userId', '=', userId)
    .where('boxDefinitionId', '=', boxDefinitionId)
    .where('boxSourceKey', '=', sourceKey)
    .where('rewardStatus', '=', BOX_OPENING_REWARD_STATUS.granted)
    .returning('boxItemId')
    .executeTakeFirst();
  if (!opening) throw new RefundRefused('Neither the box nor what it gave is on this account.');

  return trx
    .deleteFrom('UserCosmetic')
    .where('userId', '=', userId)
    .where('claimKey', '=', boxOpenClaimKey(opening.boxItemId))
    .returning(REMOVED_HOLDING)
    .execute();
}

// TAKE BACK A GRANTED BOX: no purchase to refund, so it is found by sourceKey. No Buzz is returned.
export async function takeBackGrantedBox(input: {
  userId: number;
  sourceKey: string;
  moderatorId: number;
}): Promise<ActionResult> {
  if (!input.sourceKey.startsWith(MOD_GRANT_SOURCE_PREFIX))
    return { ok: false, error: 'That box was not granted by a moderator.' };

  let removed: RemovedHolding[];
  try {
    removed = await dbWrite.transaction().execute(async (trx) => {
      await lockItemHolder(trx, input.userId);
      const held = await trx
        .selectFrom('Item')
        .select('itemDefinitionId')
        .where('sourceKey', '=', input.sourceKey)
        .where('holderType', '=', 'user')
        .where('holderId', '=', input.userId)
        .executeTakeFirst();
      const opened = held
        ? undefined
        : await trx
            .selectFrom('BoxOpening')
            .select('boxDefinitionId')
            .where('boxSourceKey', '=', input.sourceKey)
            .where('userId', '=', input.userId)
            .executeTakeFirst();
      const boxDefinitionId = held?.itemDefinitionId ?? opened?.boxDefinitionId;
      if (boxDefinitionId === undefined)
        throw new RefundRefused('Neither the box nor what it gave is on this account.');
      return takeBackBox(trx, {
        userId: input.userId,
        sourceKey: input.sourceKey,
        boxDefinitionId,
      });
    });
  } catch (error) {
    if (error instanceof RefundRefused) return { ok: false, error: error.message };
    if (isItemHolderBusy(error)) return { ok: false, error: ITEM_HOLDER_BUSY_MESSAGE };
    throw error;
  }

  await bustUserCosmeticCaches(input.userId);
  const warning = await refreshRemovedHoldings(removed, 'Taken back');

  await logAction(`takeBackBox:${input.sourceKey}`, input.userId, input.moderatorId);
  return { ok: true, warning };
}

// GRANT A COSMETIC (Retool's UnlockCosmetics).
export async function grantCosmetic(input: {
  userId: number;
  cosmeticId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const exists = await dbWrite
    .selectFrom('Cosmetic')
    .select('id')
    .where('id', '=', input.cosmeticId)
    .executeTakeFirst();
  if (!exists) return { ok: false, error: 'No such cosmetic.' };

  let result;
  try {
    result = await dbWrite.transaction().execute(async (trx) => {
      await lockItemHolder(trx, input.userId);
      // (userId, cosmeticId, claimKey) is the PK and Retool's plain INSERT threw on a repeat grant.
      return trx
        .insertInto('UserCosmetic')
        .values({ userId: input.userId, cosmeticId: input.cosmeticId, obtainedAt: new Date() })
        .onConflict((oc) => oc.columns(['userId', 'cosmeticId', 'claimKey']).doNothing())
        .executeTakeFirst();
    });
  } catch (error) {
    if (isItemHolderBusy(error)) return { ok: false, error: ITEM_HOLDER_BUSY_MESSAGE };
    throw error;
  }

  if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0)
    return { ok: false, error: 'This account already holds that cosmetic.' };

  await bustUserCosmeticCaches(input.userId);

  await logAction(`grantCosmetic:${input.cosmeticId}`, input.userId, input.moderatorId);
  return { ok: true };
}

// REMOVE A COSMETIC (Retool's RemoveCosmetics).
//
// Scoped to the exact (cosmeticId, claimKey) row the moderator clicked rather than every claim of that
// cosmetic, which is what the main app's `retool/cosmetic → unassign` does — a user who holds the same
// badge twice loses only the claim on screen. That endpoint is also the weaker path here: it refreshes
// the sticker cache alone, leaving the profile-level caches this busts stale for a day, and attributes
// to the shared API key's owner instead of the acting moderator.
export async function removeCosmetic(input: {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const removed = await dbWrite
    .deleteFrom('UserCosmetic')
    .where('userId', '=', input.userId)
    .where('cosmeticId', '=', input.cosmeticId)
    .where('claimKey', '=', input.claimKey)
    .returning(REMOVED_HOLDING)
    .execute();

  if (!removed.length) return { ok: false, error: 'This account does not hold that cosmetic.' };

  await bustUserCosmeticCaches(input.userId);
  const warning = await refreshRemovedHoldings(removed, 'Removed');

  await logAction(`removeCosmetic:${input.cosmeticId}`, input.userId, input.moderatorId);
  return { ok: true, warning };
}

// BULK IMAGE ACTIONS (Retool's RemoveImages / RemoveImages2 / RemoveArrayOfImages / RestoreImages /
// RestoreArrayOfImages). These go to the main app rather than Kysely: `handleBlockImages` and
// `handleUnblockImages` behind them re-sync the search index, recompute nsfwLevel and write ClickHouse
// tracking. A local implementation would be a second source of truth for the destructive path.
//
// Both endpoints take a JSON body, unlike the query-string mod endpoints, so they do not go through
// `callMainApp`.
// A large batch takes real time on the other side; the 30s used elsewhere would abort a removal that
// is actually succeeding, and a retry would then double-notify the owners.
//
// ⚠️ The count THESE two return is rows FOUND, not rows CHANGED: both answer with the length of a
// pre-update `findMany` over the submitted ids. So their zero-affected guards fire only when an id
// does not exist at all — re-removing an already-blocked batch reports full success. The `/api/mod/*`
// endpoints do not share this: their counts are real affected-row counts.
const postMainAppJson = (
  path: string,
  body: Record<string, unknown>,
  label: string
): Promise<JsonResult> => postJson({ path, body, label, auth: 'webhook', timeoutMs: 120_000 });

export type CountResult = { ok: true; count: number } | { ok: false; error: string };

/**
 * Retool chunked these ten at a time; one 5000-id call is a single point of failure. `handleBlockImages`
 * keeps working after the socket drops, so a timeout on one big call renders "failed" over a removal
 * that is in fact completing — and the moderator re-submits, double-writing ModActivity and possibly
 * double-notifying. Chunked, a timeout costs one chunk and the count reports what really landed.
 */
const CHUNK = 100;

async function inChunks(
  imageIds: number[],
  send: (chunk: number[]) => Promise<JsonResult>,
  /** Attribution for the chunk that just landed. Runs INSIDE the loop on purpose: written after it,
   *  a later chunk's timeout returns early and the images already actioned end up with no record of
   *  who actioned them — the exact thing the per-image rows exist to prevent. */
  onSent?: (chunk: number[]) => Promise<void>
): Promise<CountResult> {
  let affected = 0;
  for (let i = 0; i < imageIds.length; i += CHUNK) {
    const chunk = imageIds.slice(i, i + CHUNK);
    const result = await send(chunk);
    if (!result.ok)
      return affected > 0
        ? { ok: false, error: `${result.error} ${affected} images were already actioned — reload.` }
        : result;
    const count = countOf(result.body, ['images']);
    affected += count;
    // A chunk that matched nothing gets no attribution: those ids do not exist.
    if (count > 0) await onSent?.(chunk);
  }
  return { ok: true, count: affected };
}

export type RemoveImagesResult =
  | { ok: true; count: number; held: HeldSummary[] }
  | { ok: false; error: string };

const heldSummarySchema = z.array(
  z.object({
    imageId: z.number(),
    created: z.boolean(),
    approvedAt: z.string(),
    approvedByUsername: z.string().nullable(),
  })
);

export async function removeImages(input: {
  imageIds: number[];
  reason?: string;
  /** The endpoint's `ViolationType` enum. It rides onto the ClickHouse `DeleteTOS` event, so omitting
   *  it files the removal with no classification at all — silent and unrecoverable after the fact. */
  violationType?: string;
  moderatorId: number;
  /** The moderator holds `image.removal.confirm`, so the endpoint holds none of these removals. */
  canConfirmReRemoval?: boolean;
}): Promise<RemoveImagesResult> {
  if (!input.imageIds.length) return { ok: false, error: 'Select at least one image.' };

  // Removals the endpoint held for a second moderator instead of applying (`removal-hold`).
  const held: HeldSummary[] = [];
  const result = await inChunks(
    input.imageIds,
    async (chunk) => {
      const sent = await postMainAppJson(
        '/api/mod/remove-images',
        {
          imageIds: chunk,
          moderatorId: input.moderatorId,
          reason: input.reason,
          ...(input.violationType ? { violationType: input.violationType } : {}),
          ...(input.reason ? { violationDetails: input.reason } : {}),
          ...(input.canConfirmReRemoval ? { canConfirmReRemoval: true } : {}),
        },
        'Image removal'
      );
      if (sent.ok) held.push(...(heldSummarySchema.safeParse(sent.body.held).data ?? []));
      return sent;
    },
    // One row per image: ModActivity keys on content id, so a single "removed 300" row would leave
    // 299 images with no record of who removed them. A held image was not removed.
    (chunk) => {
      const heldIds = new Set(held.map((h) => h.imageId));
      return Promise.all(
        chunk
          .filter((id) => !heldIds.has(id))
          .map((id) =>
            recordModActivity({
              userId: input.moderatorId,
              entityType: 'image',
              entityId: id,
              activity: 'bulkRemove',
            })
          )
      ).then(() => undefined);
    }
  );
  if (!result.ok) return result;

  if (result.count === 0 && !held.length)
    return { ok: false, error: 'Nothing changed — those images may already be gone. Reload.' };
  return { ...result, held };
}

/**
 * Retool's image-only account nuke: `/api/mod/remove-images` with a `userId` and NO id list, which
 * blocks every image the account owns in one call. Distinct from Purge Content, which takes models,
 * posts and articles with it — this is the "their images are the problem" case.
 *
 * Unbounded by design, so it is NOT chunked and cannot report per-image attribution: the ids never
 * reach this side. One `ModActivity` row against the account stands in, and the caller confirms.
 */
export async function removeAllImagesForUser(input: {
  userId: number;
  reason?: string;
  violationType?: string;
  moderatorId: number;
}): Promise<CountResult> {
  const result = await postMainAppJson(
    '/api/mod/remove-images',
    {
      userId: input.userId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      ...(input.violationType ? { violationType: input.violationType } : {}),
      ...(input.reason ? { violationDetails: input.reason } : {}),
    },
    'Account image removal'
  );
  if (!result.ok) return result;

  await logAction('removeAllImages', input.userId, input.moderatorId);
  return { ok: true, count: countOf(result.body, ['images']) };
}

export async function restoreImages(input: {
  imageIds: number[];
  moderatorId: number;
}): Promise<CountResult> {
  if (!input.imageIds.length) return { ok: false, error: 'Select at least one image.' };

  const result = await inChunks(
    input.imageIds,
    (chunk) =>
      postMainAppJson(
        '/api/mod/restore-images',
        // `userId` is the ClickHouse actor on the Restore event; without it the restore is
        // unattributable on that side even though ModActivity records it locally.
        { imageIds: chunk, userId: input.moderatorId },
        'Image restore'
      ),
    (chunk) =>
      Promise.all(
        chunk.map((id) =>
          recordModActivity({
            userId: input.moderatorId,
            entityType: 'image',
            entityId: id,
            activity: 'bulkRestore',
          })
        )
      ).then(() => undefined)
  );
  if (!result.ok) return result;

  if (result.count === 0)
    return { ok: false, error: 'Nothing changed — those images may already be gone. Reload.' };
  return result;
}

// IMAGE FLAGS (Retool's TogglePoIMakeSureToEdit — its name is a warning that it was edited in place
// and easy to get wrong). The endpoint takes `flag=poi|minor`; Retool hardcoded poi and value=true, so
// there was no way to UNSET one from the app. Both are parameters here.
export async function setImageFlag(input: {
  imageIds: number[];
  flag: 'poi' | 'minor';
  value: boolean;
  moderatorId: number;
}): Promise<ActionResult> {
  if (!input.imageIds.length) return { ok: false, error: 'Select at least one image.' };

  // Chunked like remove/restore, and for a harder reason: this endpoint reads `req.query`, so the ids
  // ride in the URL. 5,000 of them is a ~40 KB request line, which the server rejects outright — the
  // Select-all path was the one most likely to fail and the least likely to say so.
  for (let i = 0; i < input.imageIds.length; i += CHUNK) {
    const result = await callMainApp(
      '/api/mod/update-image-flag',
      {
        flag: input.flag,
        value: String(input.value),
        ids: input.imageIds.slice(i, i + CHUNK).join(','),
      },
      'Image flag update'
    );
    if (!result.ok) return result;
  }

  await Promise.all(
    input.imageIds.map((id) =>
      recordModActivity({
        userId: input.moderatorId,
        entityType: 'image',
        entityId: id,
        activity: `${input.flag}:${input.value}`,
      })
    )
  );
  return { ok: true };
}

/** A purge whose answer was lost, most often to the timeout below while it keeps running. */
export const PURGE_MAY_BE_RUNNING =
  'Purge started but not confirmed; it may still be running. Check the account in a few minutes before purging again.';

// PURGE ALL CONTENT (Retool's PURGEAPI). Irreversible from here: the endpoint deletes models, images,
// posts, articles and comments for the account. The confirmation lives in the UI; this only refuses to
// act on an id that does not resolve, so a mistyped id cannot reach the endpoint, and on an account
// under a legal hold. The endpoint refuses a held account too; this answers before anything is sent.
export async function purgeAllContent(input: {
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const exists = await dbWrite
    .selectFrom('User')
    .select('id')
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!exists) return { ok: false, error: 'User not found.' };

  const hold = await deleteAccountHold(input.userId);
  if (hold === 'held') return { ok: false, error: LEGAL_HOLD_REFUSAL };
  if (hold !== 'clear') return { ok: false, error: HOLD_UNKNOWN_REFUSAL };

  const result = await postJson({
    path: '/api/mod/remove-all-content',
    body: {},
    query: { userId: String(input.userId), moderatorId: String(input.moderatorId) },
    label: 'Purge',
    auth: 'webhook',
    timeoutMs: 15_000,
  });
  if (!result.ok) {
    if (result.status === 403 && result.reason === LEGAL_HOLD_REFUSAL)
      return { ok: false, error: LEGAL_HOLD_REFUSAL };
    if (result.status === 403 && result.reason === HOLD_UNKNOWN_REFUSAL)
      return { ok: false, error: HOLD_UNKNOWN_REFUSAL };
    // A hold stopped it part-way, after some of the account was deleted: that is recorded.
    if (
      result.status === 409 &&
      (result.reason === LEGAL_HOLD_STOPPED ||
        result.reason === LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE)
    ) {
      await logAction('purgeAllContent', input.userId, input.moderatorId);
      return { ok: false, error: result.reason };
    }
    // The wipe runs to completion on the main app whether or not this side is still waiting, so a
    // lost answer is reported as started, never as failed: a failure invites a second purge.
    if (!responseMayHaveLanded(result)) return { ok: false, error: result.error };
    await logAction(PURGE_UNCONFIRMED_ACTIVITY, input.userId, input.moderatorId);
    return { ok: false, error: PURGE_MAY_BE_RUNNING };
  }

  await logAction('purgeAllContent', input.userId, input.moderatorId);
  const warning = purgeWarning(result.body);
  return warning ? { ok: true, warning } : { ok: true };
}

/** One sentence for every way this call can fail without proving the deletion did not happen. The
 *  operator's next move is the same in all of them, and it is not "retry". */
const MAY_HAVE_COMPLETED =
  'Account deletion could not be confirmed. It may already have completed — re-check the account before retrying.';

/**
 * Close an account on its owner's behalf — a data-subject erasure request from someone who cannot
 * sign in and use the self-serve path. Calls the same `deleteUser` service that path calls; this
 * function contains no deletion logic and must not grow any.
 *
 * No existence pre-check, unlike `purgeAllContent` above. That one needs its own because
 * `callMainApp` gives it back a bare status code; this endpoint writes a legible refusal for an
 * unknown id and for an already-deleted account, and `readError` surfaces it. A local check would be
 * a second, drifting copy of a rule the endpoint already owns.
 *
 * 🔴 NO `logAction` CALL HERE, AND THAT IS DELIBERATE — do not add one for symmetry with its
 * neighbours. `/api/mod/user/delete` writes its own `deleteAccount` ModActivity row against the
 * acting moderator, because a bearer-token script reaches that endpoint without passing through this
 * app at all. `ModActivity` is append-only in production, so a second call here is a second row in
 * the account history for one deletion, not a deduped one.
 */
const MINT_MAY_HAVE_COMPLETED =
  'Could not confirm the code was minted. Wait a minute, then check this account’s code list before minting again.';

/**
 * Operator-facing error for a failed non-idempotent write. A lost response (5xx, 408, or no answer after
 * the request left) may have written, and a blind retry writes twice, so it gets `mayHaveCompleted`.
 */
function writeFailureError(
  result: Extract<JsonResult, { ok: false }>,
  mayHaveCompleted: string
): string {
  if (result.status !== undefined && (result.status >= 500 || result.status === 408))
    return mayHaveCompleted;
  if (result.status !== undefined || result.requestNeverSent) return result.error;
  return mayHaveCompleted;
}

// MEMBERSHIP CODE (support make-good). The endpoint records the ModActivity row inside the same
// transaction as the code, and its daily cap counts those rows — so no `logAction` here.
export async function mintMembershipCode(input: {
  userId: number;
  tier: MembershipCodeTier;
  months: number;
  reason: string;
}): Promise<{ ok: true; code: string; expiresAt: string } | { ok: false; error: string }> {
  const result = await callModEndpoint(
    'user/membership-code',
    { userId: input.userId, tier: input.tier, months: input.months, reason: input.reason },
    'Mint membership code'
  );
  if (!result.ok) return { ok: false, error: writeFailureError(result, MINT_MAY_HAVE_COMPLETED) };
  const { code, expiresAt } = result.body;
  if (typeof code !== 'string' || !code || typeof expiresAt !== 'string')
    return { ok: false, error: MINT_MAY_HAVE_COMPLETED };
  return { ok: true, code, expiresAt };
}

const REVOKE_MAY_HAVE_COMPLETED =
  'Could not confirm the revoke. Refresh the code list before trying again.';

export async function revokeMembershipCode(input: {
  userId: number;
  code: string;
}): Promise<ActionResult> {
  const result = await callModEndpoint(
    'user/membership-code-revoke',
    { userId: input.userId, code: input.code },
    'Revoke membership code'
  );
  if (result.ok) return { ok: true };
  return { ok: false, error: writeFailureError(result, REVOKE_MAY_HAVE_COMPLETED) };
}

const GRANT_MAY_HAVE_COMPLETED =
  'Could not confirm the grant. Wait a minute, then check this account’s grant list before granting again.';

// The endpoint records the ModActivity row in the grant's transaction, so no `logAction` here.
export async function grantCreatorScore(input: {
  userId: number;
  amount: number;
  reason: string;
}): Promise<{ ok: true; total: number } | { ok: false; error: string }> {
  const result = await callModEndpoint(
    'user/creator-score-grant',
    { userId: input.userId, amount: input.amount, reason: input.reason },
    'Grant Creator Score'
  );
  if (!result.ok) return { ok: false, error: writeFailureError(result, GRANT_MAY_HAVE_COMPLETED) };
  const { total } = result.body;
  if (typeof total !== 'number') return { ok: false, error: GRANT_MAY_HAVE_COMPLETED };
  return { ok: true, total };
}

const GRANT_REVOKE_MAY_HAVE_COMPLETED =
  'Could not confirm the revoke. Refresh the grant list before trying again.';

export async function revokeCreatorScoreGrant(input: {
  userId: number;
  grantId: number;
  reason: string;
}): Promise<{ ok: true; total: number } | { ok: false; error: string }> {
  const result = await callModEndpoint(
    'user/creator-score-grant-revoke',
    { userId: input.userId, grantId: input.grantId, reason: input.reason },
    'Revoke Creator Score grant'
  );
  if (!result.ok)
    return { ok: false, error: writeFailureError(result, GRANT_REVOKE_MAY_HAVE_COMPLETED) };
  // The endpoint's total, not a re-read: the page reloads its scores from a replica that can lag.
  const { total } = result.body;
  if (typeof total !== 'number') return { ok: false, error: GRANT_REVOKE_MAY_HAVE_COMPLETED };
  return { ok: true, total };
}

/** Whether a legal hold blocks deleting the account. Only `held: false` is `clear`; the endpoint
 *  refuses a held account regardless. */
export async function deleteAccountHold(userId: number): Promise<DeleteHold> {
  // Short: the Admin tab waits on this, and a slow answer blocks deletion anyway.
  const result = await readModEndpoint('user/legal-hold', { userId }, 'Legal hold check', 5_000);
  if (!result.ok) return 'unknown';
  if (result.body.held === false) return 'clear';
  return result.body.held === true ? 'held' : 'unknown';
}

export async function deleteAccount(input: {
  userId: number;
  /** The account's current username. **REQUIRED by the endpoint for any account that has one** —
   *  it is the only check that catches a mistyped id which happens to be another LIVE account, and
   *  nothing downstream catches that one. Omitting it for such an account is a legible 400, not a
   *  deletion. Optional only where there is nothing to confirm against: an account whose username
   *  is null, and a row already scrubbed — so it is safe to send on a retry, because the endpoint
   *  answers already-deleted before it compares. */
  username?: string;
  /** Omitted moves their models to the deleted-user sentinel; true deletes the models too. */
  removeModels?: boolean;
  /** True deletes the images now, irrecoverably. Omitted keeps them for the 7-day grace period —
   *  the endpoint defaults this to `false`, so an erasure needing immediate removal must say so. */
  removeImages?: boolean;
}): Promise<ActionResult> {
  const body: Record<string, unknown> = { userId: input.userId };
  // Truthy, not `!== undefined`, and safe ONLY because the endpoint REQUIRES a username for any
  // account that has one. An EMPTY field therefore arrives as an omission and comes back as
  // "confirm the username" rather than the opaque `.min(1)` rejection; a whitespace-only field is
  // truthy, goes on the wire, and still gets the opaque one. Either way it cannot become a silent
  // unverified deletion.
  if (input.username) body.username = input.username;
  if (input.removeModels !== undefined) body.removeModels = input.removeModels;
  if (input.removeImages !== undefined) body.removeImages = input.removeImages;

  // Longer than the 30s default because `deleteUser` cancels Stripe and Paddle subscriptions,
  // reindexes and invalidates every session. 🔴 The number does NOT close the hole below: the
  // deletion commits first and the Paddle client has no timeout of its own, so no value makes an
  // abort mean "nothing happened". Pinned, because a silent revert to the 30s default widens a
  // window the operator reads as a failed deletion.
  const result = await callModEndpoint('user/delete', body, 'Account deletion', 60_000);
  if (!result.ok) {
    if (result.status === 403 && result.reason === LEGAL_HOLD_REFUSAL)
      return { ok: false, error: LEGAL_HOLD_REFUSAL };
    if (result.status === 403 && result.reason === HOLD_UNKNOWN_REFUSAL)
      return { ok: false, error: HOLD_UNKNOWN_REFUSAL };
    // 🔴 ONE QUESTION: could this request have reached the handler?
    //
    // `deleteUser` commits before an unbounded post-commit step, so a lost response does NOT mean
    // nothing happened, and telling an operator a committed deletion failed is what sends them to
    // do it again. Equally, destroying a refusal the endpoint wrote for a human — "already
    // deleted", "wrong username" — leaves them unable to tell a finished job from a broken route.
    //
    // 🔴 5xx AND 408 BEFORE THE REFUSAL BRANCH BELOW, which reads any answered status as a
    // refusal: a gateway's 504, JSON or not, would reach the operator as a failed deletion over one
    // that committed. A 5xx the app authors after committing is near-unreachable — every
    // post-commit step in `deleteUser`, and both audit writes in `/api/mod/user/delete`, are caught
    // individually.
    //
    // A 408 goes with them, envelope or not: this endpoint does not author one before committing
    // (a raw Prisma timeout leaves `handleEndpointError` as a 500), so any 408 is a timeout of a
    // request that may already have been acted on.
    if (result.status !== undefined && (result.status >= 500 || result.status === 408)) {
      // The recovered text is LOGGED, not appended. `handleEndpointError` genericizes every
      // server-fault 5xx, so appending it would give the operator "(An unexpected error
      // occurred)" — and 503 is the one status excluded from that, so its hand-written hint would
      // arrive as "retry" glued to a sentence saying re-check before retrying. One instruction in
      // front of a person; the detail stays recoverable here.
      if (result.reason)
        console.error('[user-actions] account deletion lost its response', {
          userId: input.userId,
          status: result.status,
          reason: result.reason,
        });
      return { ok: false, error: MAY_HAVE_COMPLETED };
    }

    // Below 500 and not 408: a refusal, whoever wrote it — the handler did not act. One written for
    // a human arrives with its text intact.
    if (result.status !== undefined) return { ok: false, error: result.error };

    // NOBODY answered. Only a code proving the request never left is safe to call a failure.
    return result.requestNeverSent
      ? { ok: false, error: result.error }
      : { ok: false, error: MAY_HAVE_COMPLETED };
  }

  // Any 2xx that is not this endpoint's success envelope — a proxy interstitial, an auth layer, a
  // future partial-success shape — would otherwise be reported as a completed erasure. For an
  // erasure the false positive is the expensive direction: the request gets closed and the data is
  // still there. No live path to a non-JSON 200 is known; this is here on that asymmetry. It shares
  // the message above because an abort while the body is being read also lands here, swallowed by
  // `res.json().catch`, and that one genuinely may have completed.
  if (result.body.deleted !== true) return { ok: false, error: MAY_HAVE_COMPLETED };

  // The deletion succeeded but its audit row did not land. Not an error for the operator, who
  // cannot act on it; it belongs in this app's log next to the action it describes.
  if (result.body.auditRecorded === false)
    console.error('[user-actions] account deleted but the ModActivity row failed', {
      userId: input.userId,
    });

  return { ok: true };
}

/** Rows per reaction table, keyed by table name, as the main app reports them. */
export type ReactionCounts = Record<string, number>;

const isCounts = (v: unknown): v is ReactionCounts =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.values(v).every((n) => typeof n === 'number');

export async function countReactions(
  userId: number
): Promise<{ ok: true; counts: ReactionCounts } | { ok: false; error: string }> {
  const result = await readModEndpoint('user/reactions', { userId }, 'Count reactions');
  if (!result.ok) return { ok: false, error: result.error };
  const { counts } = result.body;
  if (!isCounts(counts))
    return { ok: false, error: 'Count reactions returned an unexpected answer.' };
  return { ok: true, counts };
}

// Re-running the removal is safe (it deletes whatever is left), so a lost response sends the operator
// to count again rather than warning them off a retry.
const REMOVE_REACTIONS_MAY_HAVE_COMPLETED =
  'Could not confirm the removal. Count the reactions again to see what is left.';

/** The endpoint writes its own ModActivity row, as `user/delete` does, so no `logAction` here. */
export async function removeReactions(input: {
  userId: number;
  /** REQUIRED by the endpoint for any account that has one, as on `deleteAccount`. */
  username?: string;
}): Promise<
  { ok: true; removed: ReactionCounts; remaining: number } | { ok: false; error: string }
> {
  const body: Record<string, unknown> = { userId: input.userId };
  if (input.username) body.username = input.username;

  const result = await callModEndpoint('user/remove-reactions', body, 'Remove reactions', 60_000);
  if (!result.ok)
    return { ok: false, error: writeFailureError(result, REMOVE_REACTIONS_MAY_HAVE_COMPLETED) };

  const { removed, remaining, auditRecorded } = result.body;
  if (!isCounts(removed) || typeof remaining !== 'number')
    return { ok: false, error: REMOVE_REACTIONS_MAY_HAVE_COMPLETED };
  if (auditRecorded === false)
    console.error('[user-actions] reactions removed but the ModActivity row failed', {
      userId: input.userId,
    });
  return { ok: true, removed, remaining };
}

// PROFILE TEXT (Retool's UpdateUserDeets / UpdateUserProfile). The moderation case is a bio, profile
// message or location used as an advertising or abuse surface: the text has to come off the site
// without banning the account over it.
//
// Only the three free-text fields are writable. Retool's GUI write pointed at the whole `User` row,
// which put username and email one mis-click from being overwritten.

export async function clearProfileText(input: {
  userId: number;
  fields: ProfileField[];
  moderatorId: number;
}): Promise<ActionResult> {
  const fields = input.fields.filter((f) => PROFILE_FIELD_KEYS.includes(f));
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

// TIMED MUTES. A timed mute is `User.muteExpiresAt`, drained hourly by the main app's
// `processTimedUnmutesJob` — not a side table. The moderator DB has a `TimedMutes` table; its model
// comment says why nothing may read it.
export type TimedMute = {
  muteExpiresAt: Date;
  /** Who set it. `strikes` means the escalation engine, and carries no reason or moderator. */
  source: 'moderator' | 'strikes';
  mutedAt: Date | null;
  reason: string | null;
  mutedBy: number | null;
};

/** The account's current timed mute, or null. Permanent mutes (no expiry) are not timed mutes and are
 *  rendered by the account panel, not this one. */
export async function getTimedMute(userId: number): Promise<TimedMute | null> {
  const row = await dbRead
    .selectFrom('User')
    .select(['mutedAt', 'muteExpiresAt', 'meta'])
    .where('id', '=', userId)
    .where('muted', '=', true)
    .where('muteExpiresAt', 'is not', null)
    .executeTakeFirst();
  if (!row?.muteExpiresAt) return null;

  // Read straight through: every unmute path clears `mutedAt` and the two meta keys together
  // (`clearedMuteFields` in the main app's user.service), so what is here describes the mute in force
  // and nothing older. `mutedAt` still decides `source`, because a strike-set mute has no reason or
  // moderator to show and should say so rather than render two blanks.
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  return {
    muteExpiresAt: row.muteExpiresAt as Date,
    source: row.mutedAt !== null ? 'moderator' : 'strikes',
    mutedAt: (row.mutedAt as Date | null) ?? null,
    reason: typeof meta.muteReason === 'string' ? meta.muteReason : null,
    mutedBy: typeof meta.mutedBy === 'number' ? meta.mutedBy : null,
  };
}

export async function addTimedMute(input: {
  userId: number;
  until: Date;
  reason: string;
  moderatorId: number;
}): Promise<ActionResult> {
  return setMuted({
    userId: input.userId,
    muted: true,
    moderatorId: input.moderatorId,
    activity: 'timedMute',
    until: input.until,
    reason: input.reason,
  });
}

/**
 * Lift the timed mute in force now.
 *
 * 🔴 Refuses when there is no TIMED mute, rather than unmuting whatever is there. The panel is fetched
 * once and not revalidated, so its row can be stale: if the mute expired and the strike engine has since
 * escalated to an indefinite, flagged-for-review mute, a plain `setMuted(false)` would lift THAT and
 * report success — the operator believes they cancelled a 24-hour mute and has actually released a
 * review hold. The main app re-checks this under its row lock; the read here only words the refusal.
 */
export async function revokeTimedMute(input: {
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const current = await getTimedMute(input.userId);
  if (!current)
    return { ok: false, error: 'No timed mute is in force on this account — reload the page.' };

  return releaseMute({
    userId: input.userId,
    moderatorId: input.moderatorId,
    activity: 'revokeTimedMute',
  });
}

/**
 * Takes a reported sticker placement down (main app's `/api/mod/remove-placement`).
 *
 * NOT reimplemented locally, and the reason is escrow: `removePlacementByModerator` forfeits a
 * pending placement's escrow and takes an approved one down after the owner has already been paid.
 * A second service writing those tables would be a money path with two implementations.
 *
 * `postJson` rather than `callMainApp`: the endpoint reads `req.body`, and `callMainApp` sends a
 * query string — the mismatch that left `setRewardsEligibility` unable to succeed.
 */
export async function removePlacement(input: {
  placementId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await postJson({
    path: '/api/mod/remove-placement',
    body: { placementId: input.placementId, moderatorId: input.moderatorId },
    label: 'Remove placement',
    auth: 'webhook',
    timeoutMs: 15_000,
  });
  if (!result.ok) return result;

  // The endpoint answers `removed: false` when someone else already settled it. Reporting that as
  // success would put a takedown in the moderator's record for something they did not do.
  if (result.body.removed !== true)
    return { ok: false, error: 'That placement was already settled — reload.' };

  // The endpoint writes its own ModActivity row against the real moderator id, so none here.
  return { ok: true };
}
