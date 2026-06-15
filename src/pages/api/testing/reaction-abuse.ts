/**
 * Debug / ops endpoint for reaction-abuse exclusion.
 * =============================================================================
 *
 * Hidden route. Guarded by WEBHOOK_TOKEN via `?token=` (see WebhookEndpoint).
 * No public UI. Designed so an out-of-loop agent can PULL suspect reactor data,
 * apply judgment, and COMMIT excluded users — the same `metricExcludedUsers`
 * ClickHouse table the `entityMetricDaily_mv` materialized view filters on, so
 * excluded users stop counting toward reaction metrics/ranking (forward-only,
 * within ~5 min on the current day).
 *
 * Usage:
 *   POST /api/testing/reaction-abuse?token=$WEBHOOK_TOKEN
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
 *   exclude       - {userIds: number[], reason}
 *                   Add users to metricExcludedUsers (active=1). Idempotent.
 *   unexclude     - {userIds: number[]}
 *                   Reverse an exclusion (insert active=0; latest row wins).
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
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

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
        return res.status(200).json({ excluded: values.length, userIds: input.userIds });
      }

      case 'unexclude': {
        const values = input.userIds!.map((userId) => ({
          userId,
          reason: 'unexclude',
          active: 0,
        }));
        await clickhouse.insert({ table: 'metricExcludedUsers', values, format: 'JSONEachRow' });
        return res.status(200).json({ unexcluded: values.length, userIds: input.userIds });
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
