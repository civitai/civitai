import { env } from '$env/dynamic/private';
import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { getBuzz } from './buzz';
import { bustUserCosmeticCaches } from './cache';
import { getModeratorDb } from './moderator-db';
import { recordModActivity } from './mod-activity';
import { recordUserActivity } from './user-activity';
import { invalidateUserSessions } from './sessions';
import { PROFILE_FIELD_KEYS, type ProfileField } from '$lib/enforcement';

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

// The `/api/mod/retool/*` family authenticates with a moderator API key as a Bearer token, NOT the
// webhook token — a different auth scheme from every other main-app call here. Retool held the key in
// its own config; the spoke needs `CIVITAI_MOD_API_KEY` set or these actions refuse rather than fail
// obscurely at the endpoint.
type JsonResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** The one JSON poster. Two auth schemes because the endpoint families disagree, not because the
 *  callers do — everything else about them was identical and drifted independently. */
async function postJson(opts: {
  path: string;
  body: Record<string, unknown>;
  label: string;
  auth: 'webhook' | 'modKey';
  timeoutMs: number;
}): Promise<JsonResult> {
  const base = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let url = `${base}${opts.path}`;

  if (opts.auth === 'modKey') {
    const key = env.CIVITAI_MOD_API_KEY;
    if (!key) return { ok: false, error: 'CIVITAI_MOD_API_KEY is not configured.' };
    headers.authorization = `Bearer ${key}`;
  } else {
    const token = env.WEBHOOK_TOKEN;
    if (!token) return { ok: false, error: 'WEBHOOK_TOKEN is not configured.' };
    url += `?token=${encodeURIComponent(token)}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `${opts.label} returned ${res.status}.` };
    // ⚠️ The count in the body is rows FOUND, not rows CHANGED — `remove-images` and `restore-images`
    // both return the length of a pre-update `findMany` over the submitted ids. So the zero-affected
    // guards below fire only when an id does not exist at all: re-removing an already-blocked batch
    // reports full success. Do not read these counts as proof a mutation happened.
    return {
      ok: true,
      body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    };
  } catch (e) {
    console.error(`[user-actions] ${opts.label} failed`, e);
    return { ok: false, error: `${opts.label} failed.` };
  }
}

const callRetoolEndpoint = (
  resource: string,
  body: Record<string, unknown>,
  label: string
): Promise<JsonResult> =>
  postJson({ path: `/api/mod/retool/${resource}`, body, label, auth: 'modKey', timeoutMs: 30_000 });

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

  const result = await callRetoolEndpoint(
    'user',
    { action: 'updateIdentity', userId: input.userId, ...changed },
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
  const result = await callRetoolEndpoint(
    'user',
    { action: 'toggleModerator', userId: input.userId, isModerator: input.isModerator },
    'Moderator toggle'
  );
  if (!result.ok) return result;

  await logAction(`toggleModerator:${input.isModerator}`, input.userId, input.moderatorId);
  return { ok: true };
}

/**
 * Retool's `TagVote`, through `/api/mod/retool/image`. The endpoint applies the moderator vote weight
 * itself, so callers pass a plain ±1 and the number that decides whether a tag is disabled stays in
 * one place — the main app's `addTagVotes`.
 */
export async function voteOnImageTags(
  votes: { imageId: number; tagId: number; vote: -1 | 0 | 1 }[]
): Promise<ActionResult> {
  if (!votes.length) return { ok: false, error: 'No votes to record.' };
  const result = await callRetoolEndpoint('image', { action: 'tagVote', votes }, 'Tag vote');
  return result.ok ? { ok: true } : result;
}

const countOf = (body: Record<string, unknown>, keys: string[]) =>
  keys.reduce((sum, k) => sum + (typeof body[k] === 'number' ? (body[k] as number) : 0), 0);

// BULK COMMENT ACTIONS (Retool's DeleteComments / ToSComments). Both tables in one call, matching the
// endpoint's contract and Retool's Model Comments / Other Comments split.
export async function bulkCommentAction(input: {
  action: 'bulkDelete' | 'removeAsTos';
  commentIds: number[];
  commentV2Ids: number[];
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  if (!input.commentIds.length && !input.commentV2Ids.length)
    return { ok: false, error: 'Select at least one comment.' };

  const result = await callRetoolEndpoint(
    'comment',
    {
      action: input.action,
      commentIds: input.commentIds,
      commentV2Ids: input.commentV2Ids,
    },
    input.action === 'bulkDelete' ? 'Comment delete' : 'Comment ToS'
  );
  if (!result.ok) return result;

  // `removeAsTos` nests its counts per table; `bulkDelete` returns them flat.
  const nested = (key: string) => {
    const section = result.body[key];
    return section && typeof section === 'object'
      ? countOf(section as Record<string, unknown>, ['count'])
      : 0;
  };
  const affected =
    input.action === 'bulkDelete'
      ? countOf(result.body, ['commentDeleted', 'commentV2Deleted'])
      : nested('comment') + nested('commentV2');

  // Reporting success on zero would write a ModActivity row attributing a deletion that did not happen.
  if (affected === 0)
    return { ok: false, error: 'Nothing changed — those comments may already be gone. Reload.' };

  await logAction(`comments:${input.action}:${affected}`, input.userId, input.moderatorId);
  return { ok: true };
}

// BULK REVIEW ACTIONS (Retool's DeleteReview / ExcludeOrIncludeReview).
export async function bulkReviewAction(input: {
  action: 'delete' | 'setExclude';
  reviewIds: number[];
  exclude?: boolean;
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  if (!input.reviewIds.length) return { ok: false, error: 'Select at least one review.' };

  const body: Record<string, unknown> = { action: input.action, reviewIds: input.reviewIds };
  if (input.action === 'setExclude') body.exclude = input.exclude ?? true;

  const result = await callRetoolEndpoint(
    'review',
    body,
    input.action === 'delete' ? 'Review delete' : 'Review exclude'
  );
  if (!result.ok) return result;

  const affected = countOf(result.body, ['count']);
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
  /** Set for a TIMED mute. Without it a timed mute never lifts: `processTimedUnmutes` selects on
   *  `muteExpiresAt`, so a 24-hour mute that only wrote the moderator-DB row was permanent while this
   *  panel rendered it as expiring. */
  until?: Date | null;
}): Promise<ActionResult> {
  const now = new Date();
  // `meta.manualMute` separates "a moderator set this expiry" from "strikes set it". The main app's
  // strike de-escalation clears any mute with a non-null muteExpiresAt, so without this flag a
  // moderator's 72-hour mute is lifted early the moment the account's strike points decay.
  const manualMute = input.muted && !!input.until;
  const result = await dbWrite
    .updateTable('User')
    .set({
      muted: input.muted,
      mutedAt: input.muted ? now : null,
      muteExpiresAt: input.muted ? input.until ?? null : null,
      meta: sql`COALESCE("meta", '{}'::jsonb) || ${JSON.stringify({ manualMute })}::jsonb`,
    })
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
  const result = await setMuted({
    userId: input.userId,
    muted: false,
    moderatorId: input.moderatorId,
  });
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

// The ban list lives in $lib/enforcement so the picker and this validator cannot drift apart.
export { BAN_REASONS as BAN_REASON_CODES, type BanReasonCode } from '$lib/enforcement';

// `/api/mod/ban-user` TOGGLES rather than setting a state, and answers 200 before it has done the work.
// Re-reading `bannedAt` and refusing when it already matches the request turns the toggle back into an
// explicit operation: a stale page that thinks the user is unbanned cannot silently unban them. The
// 200-before-work behaviour cannot be fixed from here, so callers must re-read rather than trust it.
export async function setBanned(input: {
  userId: number;
  ban: boolean;
  reasonCode?: string;
  detailsInternal?: string;
  /** Read back by the appeal flow. Never emailed, so it is safe to collect here. */
  detailsExternal?: string;
  /** The endpoint blocks media only for `SexualMinor` unless this is set — a Nudify or Harassment ban
   *  otherwise leaves every image up and needs a second, separate purge. */
  removeMedia?: boolean;
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
  if (input.ban && input.detailsExternal) params.detailsExternal = input.detailsExternal;
  if (input.ban && input.removeMedia) params.removeMedia = 'true';

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
  const result = await postJson({
    path: '/api/mod/retool/strike',
    body: {
      action: 'create',
      userId: input.userId,
      reason: 'ManualModAction',
      description: input.description,
      ...(input.internalNotes ? { internalNotes: input.internalNotes } : {}),
    },
    label: 'Strike endpoint',
    auth: 'modKey',
    timeoutMs: 15_000,
  });
  if (!result.ok) return result;

  // `{ skipped: true }` is the rate-limit path. It returns 200, so without this a refused strike is
  // indistinguishable from an issued one.
  if (result.body?.skipped === true)
    return { ok: false, error: 'The strike was rate-limited and NOT issued.' };

  await logAction('issueStrike', input.userId, input.moderatorId);
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
  userId: number;
  moderatorId: number;
}): Promise<ActionResult> {
  const result = await callRetoolEndpoint(
    'restriction',
    {
      action: 'resolve',
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      ...(input.resolvedMessage ? { resolvedMessage: input.resolvedMessage } : {}),
    },
    'Restriction ruling'
  );
  if (!result.ok) return result;

  await logAction(`restriction:${input.status.toLowerCase()}`, input.userId, input.moderatorId);
  return { ok: true };
}

// PADDLE ACCOUNT LINKING (Retool's three-step wizard behind the Membership panel's Paddle button:
// find the account holding a customer id, unlink it, link this one).
//
// Written here rather than through the main app: `paddleCustomerId` has no mod endpoint, and the
// column is a plain pointer — the billing side effects belong to Paddle's own webhooks, which resolve
// the account BY this column. That is also why a mis-link is worth fixing: until it is, the wrong
// account receives another account's subscription events.

/** Who currently holds a customer id, so a link cannot silently move it off another account. */
export async function findPaddleCustomerOwner(
  paddleCustomerId: string
): Promise<{ id: number; username: string | null } | null> {
  const row = await dbRead
    .selectFrom('User')
    .select(['id', 'username'])
    .where('paddleCustomerId', '=', paddleCustomerId)
    .executeTakeFirst();
  return row ?? null;
}

export async function setPaddleCustomer(input: {
  userId: number;
  /** `null` unlinks. */
  paddleCustomerId: string | null;
  /** Clear the id off whichever account currently holds it first — Retool's "unlink an old one" step. */
  takeFrom?: number;
  moderatorId: number;
}): Promise<ActionResult> {
  if (input.takeFrom && input.takeFrom !== input.userId) {
    await dbWrite
      .updateTable('User')
      .set({ paddleCustomerId: null })
      .where('id', '=', input.takeFrom)
      .execute();
    await logAction('paddleUnlink', input.takeFrom, input.moderatorId);
  }

  const result = await dbWrite
    .updateTable('User')
    .set({ paddleCustomerId: input.paddleCustomerId })
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0) === 0) return { ok: false, error: 'User not found.' };

  await logAction(input.paddleCustomerId ? 'paddleLink' : 'paddleUnlink', input.userId, input.moderatorId);

  // The membership the page renders is read through caches keyed on the account, so without this the
  // panel keeps showing the pre-link subscription and the moderator re-links a second time.
  await resetSubscriptionCaches({ userId: input.userId, moderatorId: input.moderatorId }).catch(
    () => undefined
  );
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
// Two writes that must not half-apply: flagging the purchase refunded while the cosmetic stays
// equipped leaves the user holding something they were paid back for, and deleting the cosmetic
// without the flag makes the purchase eligible to be refunded twice. Hence one transaction.
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
    .selectFrom('UserCosmeticShopPurchases')
    .select(['cosmeticId', 'refunded'])
    .where('buzzTransactionId', '=', input.buzzTransactionId)
    .where('userId', '=', input.userId)
    .executeTakeFirst();

  if (!purchase) return { ok: false, error: 'That purchase does not belong to this user.' };
  if (purchase.refunded) return { ok: false, error: 'That purchase is already refunded.' };

  await dbWrite.transaction().execute(async (trx) => {
    await trx
      .updateTable('UserCosmeticShopPurchases')
      .set({ refunded: true })
      .where('buzzTransactionId', '=', input.buzzTransactionId)
      .where('userId', '=', input.userId)
      .execute();

    // The purchase id is the claimKey on the granted row — that is how a shop grant is distinguished
    // from every other way of holding the same cosmetic.
    await trx
      .deleteFrom('UserCosmetic')
      .where('userId', '=', input.userId)
      .where('cosmeticId', '=', purchase.cosmeticId)
      .where('claimKey', '=', input.buzzTransactionId)
      .execute();
  });

  // The main app serves equipped cosmetics from a day-TTL cache with no stale-while-revalidate, so
  // without this the refunded badge or frame keeps rendering on their profile, comments and images for
  // up to 24 hours after the panel says it is gone.
  await bustUserCosmeticCaches(input.userId);

  await logAction('shopRefund', input.userId, input.moderatorId);
  return { ok: true };
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

  // (userId, cosmeticId, claimKey) is the PK and Retool's plain INSERT threw on a repeat grant.
  const result = await dbWrite
    .insertInto('UserCosmetic')
    .values({ userId: input.userId, cosmeticId: input.cosmeticId, obtainedAt: new Date() })
    .onConflict((oc) => oc.columns(['userId', 'cosmeticId', 'claimKey']).doNothing())
    .executeTakeFirst();

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
  const result = await dbWrite
    .deleteFrom('UserCosmetic')
    .where('userId', '=', input.userId)
    .where('cosmeticId', '=', input.cosmeticId)
    .where('claimKey', '=', input.claimKey)
    .executeTakeFirst();

  if (Number(result.numDeletedRows ?? 0) === 0)
    return { ok: false, error: 'This account does not hold that cosmetic.' };

  await bustUserCosmeticCaches(input.userId);

  await logAction(`removeCosmetic:${input.cosmeticId}`, input.userId, input.moderatorId);
  return { ok: true };
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

export async function removeImages(input: {
  imageIds: number[];
  reason?: string;
  /** The endpoint's `ViolationType` enum. It rides onto the ClickHouse `DeleteTOS` event, so omitting
   *  it files the removal with no classification at all — silent and unrecoverable after the fact. */
  violationType?: string;
  moderatorId: number;
}): Promise<CountResult> {
  if (!input.imageIds.length) return { ok: false, error: 'Select at least one image.' };

  const result = await inChunks(
    input.imageIds,
    (chunk) =>
      postMainAppJson(
        '/api/mod/remove-images',
        {
          imageIds: chunk,
          moderatorId: input.moderatorId,
          reason: input.reason,
          ...(input.violationType ? { violationType: input.violationType } : {}),
          ...(input.reason ? { violationDetails: input.reason } : {}),
        },
        'Image removal'
      ),
    // One row per image: ModActivity keys on content id, so a single "removed 300" row would leave
    // 299 images with no record of who removed them.
    (chunk) =>
      Promise.all(
        chunk.map((id) =>
          recordModActivity({
            userId: input.moderatorId,
            entityType: 'image',
            entityId: id,
            activity: 'bulkRemove',
          })
        )
      ).then(() => undefined)
  );
  if (!result.ok) return result;

  if (result.count === 0)
    return { ok: false, error: 'Nothing changed — those images may already be gone. Reload.' };
  return result;
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

// PURGE ALL CONTENT (Retool's PURGEAPI). Irreversible from here: the endpoint deletes models, images,
// posts, articles and comments for the account. The confirmation lives in the UI; this only refuses to
// act on an id that does not resolve, so a mistyped id cannot reach the endpoint.
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

  const result = await callMainApp(
    '/api/mod/remove-all-content',
    { userId: String(input.userId) },
    'Purge'
  );
  if (!result.ok) return result;

  await logAction('purgeAllContent', input.userId, input.moderatorId);
  return { ok: true };
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
  return rows.map(({ isMuted, ...row }) => ({
    ...row,
    active: isActive({ ...row, isMuted }, now),
  }));
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

  // The timed row is the schedule; the mute itself still has to be applied to the account — WITH the
  // expiry, or nothing ever lifts it.
  return setMuted({
    userId: input.userId,
    muted: true,
    moderatorId: input.moderatorId,
    activity: 'timedMute',
    until: input.until,
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
