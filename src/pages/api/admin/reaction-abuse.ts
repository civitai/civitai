/**
 * Debug / ops endpoint for reaction-abuse exclusion.
 * =============================================================================
 *
 * Hidden route. Guarded by WEBHOOK_TOKEN via `?token=` (see WebhookEndpoint).
 * No public UI. Designed so an out-of-loop agent can PULL suspect reactor data,
 * apply judgment, and COMMIT excluded users to the `metricExcludedUsers` ClickHouse
 * table. Two things filter it: the ClickHouse metric aggregates, and apps/event-engine,
 * which mirrors the list into memory so the Redis metric cache and the live metric
 * signals stop counting excluded users too. Forward-only, within ~5 min on the current
 * day — and that number is load-bearing in a second place: event-engine's
 * METRIC_EXCLUSION_REFRESH_MS default was chosen to match it.
 *
 * NOTE: lives under /api/admin (NOT /api/testing) on purpose — it is called by a
 * scheduled agent in PRODUCTION, and `route-guards.middleware.ts` hard-blocks
 * /api/testing/* in prod (`canAccess: () => !isProd` → 307 to /login before the
 * token check ever runs). /api/admin is the home for WEBHOOK_TOKEN-secured ops
 * endpoints that must run in prod.
 *
 * Usage:
 *   POST /api/admin/reaction-abuse?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   candidates    - {hours?=24, minReactions?=50, minRatio?=15, minPeers?=5, limit?=200}
 *                   READ-ONLY. Ranked suspect reactor accounts with evidence:
 *                   reactions given, distinct owners, top-owner concentration,
 *                   reactions from shared "farm" IPs, distinct farm IPs used.
 *   inspect-owner - {ownerId, hours?=168}
 *                   READ-ONLY. Per-reactor breakdown of who reacted to one owner
 *                   (count, distinct IPs, share from farm IPs) — for drill-in.
 *   exclude       - {userIds: number[], reason, actorUserId?}
 *                   Add users to metricExcludedUsers (active=1). Idempotent.
 *                   Also writes a `ModActivity` row per user so the action is visible to a
 *                   moderator — see `recordModAction`. Response carries `auditRecorded`.
 *   unexclude     - {userIds: number[], actorUserId?}
 *                   Reverse an exclusion (insert active=0; latest row wins). Audited the same way.
 *                   Pass `actorUserId` when a HUMAN runs this — it is the reversal of a false
 *                   positive, and without it the row is attributed to the system sentinel.
 *   list          - {limit?=500}
 *                   Currently-excluded users (active=1), newest first.
 *
 * Detection signals (validated in docs/plans/reaction-abuse-investigation.md):
 *   - high top-owner concentration (account exists to boost one creator)
 *   - reactions originating from shared farm IPs (many accounts per IP)
 *   - high reactions-per-distinct-owner ratio
 * No auto-action here: this endpoint surfaces evidence + commits decisions.
 * Excluding is reversible and ranking-only (never a ban).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * `ModActivity.userId` when the caller asserts no acting moderator — the same sentinel
 * `autoMuteScam` uses (`~/server/jobs/entity-moderation.ts`). The moderator app's board filters
 * `userId > 0`, so a sentinel row can never be mistaken for a person working a queue.
 */
const SYSTEM_ACTOR_ID = -1;

/**
 * How long the audit write may take before it is abandoned as failed.
 *
 * 🔴 Bounding a REJECTION is not bounding a HANG, and the hang is the case that reaches the outcome
 * the design below is built to avoid. The scheduled caller wraps this endpoint in a 30s timeout with
 * retries; a wedged `dbWrite` with no bound here would burn that budget, turn a SUCCESSFUL exclusion
 * into a client-side timeout, and have each retry re-insert into ClickHouse and write another audit
 * row. Well under the caller's own timeout so this fails first, visibly, and the response still lands.
 *
 * Because the slow write is abandoned rather than cancelled, `auditRecorded: false` means "not
 * confirmed within the bound", NOT "no row" — a write landing at 6s produces both a row and a
 * failure log. Reporting a row that exists is the safe direction of that trade.
 */
const AUDIT_WRITE_TIMEOUT_MS = 5_000;

/**
 * The moderator-visible record of an action this endpoint just committed.
 *
 * The activity says WHAT happened; `actorUserId` says WHO. They are deliberately not welded
 * together: `exclude` has only ever had an automated caller, but `unexclude` is a human reversing a
 * false positive, and naming the activity `auto…` would have recorded that human action as a cron's.
 *
 * 🔴 The ClickHouse write is what actually excludes; this is only its record. So a failure here is
 * REPORTED, never thrown: throwing would 500 a request whose exclusion had already applied, telling
 * the caller nothing happened when it did, and inviting a retry that re-inserts. Swallowing it
 * silently is the opposite failure and is the very gap this trail exists to close — so it goes to
 * Axiom (matching the sibling automated path) AND rides back as `auditRecorded`.
 */
async function recordModAction(
  activity: 'reactionAbuseExclude' | 'reactionAbuseUnexclude',
  userIds: number[],
  actorUserId: number | undefined
): Promise<boolean> {
  try {
    await Promise.race([
      // One row per user: `trackModActivity` UNNESTs the array. Production sends a single id per
      // request (the poller loops, ~25-35/day), so this is one round-trip in practice — the array
      // path exists because the schema permits a batch, not because anything sends one today.
      trackModActivity(actorUserId ?? SYSTEM_ACTOR_ID, {
        entityType: 'user',
        entityId: userIds,
        activity,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`audit write exceeded ${AUDIT_WRITE_TIMEOUT_MS}ms`)),
          AUDIT_WRITE_TIMEOUT_MS
        ).unref?.()
      ),
    ]);
    return true;
  } catch (e) {
    logToAxiom(
      {
        type: 'error',
        name: 'reaction-abuse audit write failed',
        message: (e as Error).message,
        details: { activity, userIds, actorUserId: actorUserId ?? SYSTEM_ACTOR_ID },
      },
      'moderation'
    );
    return false;
  }
}

const actionSchema = z.enum(['candidates', 'inspect-owner', 'exclude', 'unexclude', 'list']);

const schema = z
  .object({
    action: actionSchema,
    hours: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 90)
      .optional(),
    minReactions: z.coerce.number().int().positive().optional(),
    minRatio: z.coerce.number().positive().optional(),
    minPeers: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(5000).optional(),
    ownerId: z.coerce.number().int().positive().optional(),
    userIds: z.array(z.coerce.number().int().positive()).max(5000).optional(),
    reason: z.string().max(500).optional(),
    // The acting moderator, for the audit row on a write. ASSERTED by the caller and not verified —
    // the token is the only gate here and there is no user behind it, the same trust model the
    // cross-app mod-action registry uses. Omitted by the scheduled poller, which is genuinely not a
    // person; supply it when a human runs `unexclude` so the reversal names them.
    //
    // 🔴 Preprocessed, not bare `.optional()`. `null` is the natural JSON for "no acting moderator",
    // and under `.optional()` it is a ZodError — so the request 400s and THE EXCLUSION NEVER
    // HAPPENS. An optional audit-attribution field must never be able to fail the write it
    // annotates; an absent actor is exactly the sentinel case. `''` is folded in for the same reason
    // (a shell recipe interpolating an unset variable) — and `.nullish()` alone would NOT have
    // covered that one, which is why this is a preprocess rather than a looser modifier.
    //
    // What this does NOT do is make the field type-safe: `z.coerce` still turns `true` into 1 and
    // `[7]` into 7, so a malformed actor can land a wrong-but-plausible id on a moderation row.
    // Tolerated because the caller is trusted and token-gated; `0`, negatives and fractions are
    // rejected outright.
    actorUserId: z.preprocess(
      (v) => (v === null || v === '' ? undefined : v),
      z.coerce.number().int().positive().optional()
    ),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'inspect-owner' && !data.ownerId)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ownerId required', path: ['ownerId'] });
    if ((data.action === 'exclude' || data.action === 'unexclude') && !data.userIds?.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'userIds required', path: ['userIds'] });
    if (data.action === 'exclude' && !data.reason)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reason required', path: ['reason'] });
  });

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse not configured' });

  const parsed = schema.safeParse({ ...req.query, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = parsed.data;

  try {
    switch (input.action) {
      case 'candidates': {
        const hours = input.hours ?? 24;
        const minReactions = input.minReactions ?? 50;
        const minRatio = input.minRatio ?? 15;
        const minPeers = input.minPeers ?? 5;
        const limit = input.limit ?? 200;

        // farm_ips: IPs hosting many distinct reactor accounts in the window.
        // per_reactor: each reactor's volume + how much rides on farm IPs.
        // top_owner: each reactor's most-boosted owner + concentration.
        const rows = await clickhouse.$query<{
          userId: number;
          reactionsGiven: number;
          distinctOwners: number;
          topOwner: number;
          toTopOwner: number;
          topConcentration: number;
          farmIpReactions: number;
          farmIpsUsed: number;
        }>(`
          WITH
          farm_ips AS (
            SELECT ip FROM reactions
            WHERE type LIKE '%_Create' AND time > now() - INTERVAL ${hours} HOUR AND ip != '' AND userId != 0
            GROUP BY ip HAVING uniqExact(userId) >= ${minPeers}
          ),
          per_reactor AS (
            SELECT
              userId,
              count() AS reactionsGiven,
              uniqExact(ownerId) AS distinctOwners,
              countIf(ip IN (SELECT ip FROM farm_ips)) AS farmIpReactions,
              uniqExactIf(ip, ip IN (SELECT ip FROM farm_ips)) AS farmIpsUsed
            FROM reactions
            WHERE type LIKE '%_Create' AND time > now() - INTERVAL ${hours} HOUR AND userId != 0
            GROUP BY userId
          ),
          top_owner AS (
            SELECT userId, ownerId AS topOwner, count() AS toTopOwner
            FROM reactions
            WHERE type LIKE '%_Create' AND time > now() - INTERVAL ${hours} HOUR AND userId != 0
            GROUP BY userId, ownerId
            ORDER BY toTopOwner DESC
            LIMIT 1 BY userId
          )
          SELECT
            r.userId AS userId,
            r.reactionsGiven AS reactionsGiven,
            r.distinctOwners AS distinctOwners,
            t.topOwner AS topOwner,
            t.toTopOwner AS toTopOwner,
            round(t.toTopOwner / r.reactionsGiven, 2) AS topConcentration,
            r.farmIpReactions AS farmIpReactions,
            r.farmIpsUsed AS farmIpsUsed
          FROM per_reactor r
          LEFT JOIN top_owner t ON t.userId = r.userId
          WHERE r.reactionsGiven >= ${minReactions}
            AND (r.farmIpReactions > 0
                 OR (r.reactionsGiven / greatest(r.distinctOwners, 1)) >= ${minRatio})
          ORDER BY r.farmIpReactions DESC, topConcentration DESC
          LIMIT ${limit}
        `);

        return res.status(200).json({
          window: `${hours}h`,
          thresholds: { minReactions, minRatio, minPeers },
          count: rows.length,
          candidates: rows,
        });
      }

      case 'inspect-owner': {
        const hours = input.hours ?? 168;
        const rows = await clickhouse.$query<{
          userId: number;
          reactions: number;
          distinctIps: number;
          farmIpReactions: number;
        }>(`
          WITH farm_ips AS (
            SELECT ip FROM reactions
            WHERE type LIKE '%_Create' AND time > now() - INTERVAL ${hours} HOUR AND ip != '' AND userId != 0
            GROUP BY ip HAVING uniqExact(userId) >= 5
          )
          SELECT
            userId,
            count() AS reactions,
            uniqExact(ip) AS distinctIps,
            countIf(ip IN (SELECT ip FROM farm_ips)) AS farmIpReactions
          FROM reactions
          WHERE type LIKE '%_Create' AND time > now() - INTERVAL ${hours} HOUR
            AND ownerId = ${input.ownerId} AND userId != 0
          GROUP BY userId
          ORDER BY reactions DESC
          LIMIT 1000
        `);
        return res
          .status(200)
          .json({ ownerId: input.ownerId, window: `${hours}h`, reactors: rows });
      }

      case 'exclude': {
        // updatedAt is left to the column DEFAULT now() — it's the ReplacingMergeTree
        // version, so the latest write wins. (Second-resolution; a daily agent never
        // flips a user twice in the same second, so the tiebreak edge is moot.)
        const values = input.userIds!.map((userId) => ({
          userId,
          reason: input.reason!,
          active: 1,
        }));
        await clickhouse.insert({ table: 'metricExcludedUsers', values, format: 'JSONEachRow' });
        const auditRecorded = await recordModAction(
          'reactionAbuseExclude',
          input.userIds!,
          input.actorUserId
        );
        return res
          .status(200)
          .json({ excluded: values.length, userIds: input.userIds, auditRecorded });
      }

      case 'unexclude': {
        const values = input.userIds!.map((userId) => ({
          userId,
          reason: 'unexclude',
          active: 0,
        }));
        await clickhouse.insert({ table: 'metricExcludedUsers', values, format: 'JSONEachRow' });
        const auditRecorded = await recordModAction(
          'reactionAbuseUnexclude',
          input.userIds!,
          input.actorUserId
        );
        return res
          .status(200)
          .json({ unexcluded: values.length, userIds: input.userIds, auditRecorded });
      }

      case 'list': {
        const limit = input.limit ?? 500;
        const rows = await clickhouse.$query<{
          userId: number;
          reason: string;
          updatedAt: string;
        }>(`
          SELECT userId, reason, updatedAt
          FROM metricExcludedUsers FINAL
          WHERE active = 1
          ORDER BY updatedAt DESC
          LIMIT ${limit}
        `);
        return res.status(200).json({ count: rows.length, excluded: rows });
      }

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    const error = e as Error;
    // Log full detail server-side; the $query wrapper appends the generated SQL to
    // the message, so don't echo it back to the caller.
    console.error('reaction-abuse endpoint error:', error.message);
    return res.status(500).json({ error: 'Request failed' });
  }
});
