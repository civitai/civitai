/**
 * Loads the licensing-fee allowance boost grant list.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param.
 *
 * Usage:
 *   POST /api/testing/fee-allowance-boost?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   grant   - {userIds, amount?}  Grant `amount` (default and max FEE_ALLOWANCE_BOOST_MAX) extra
 *                                 licensing-fee slots to each user without a grant. Load the ids from a
 *                                 file. An existing grant is left as is; revoke it first to change it.
 *   grant-eligible - {amount?, dryRun?}  `grant` to everyone the boost is for: accounts that banked in
 *                                 the Creator Program in the last 12 months, plus current members
 *                                 (the flag and a valid paid membership), skipping banned or deleted
 *                                 accounts. dryRun returns the counts only.
 *   get     - {userId}            The stored grant and the boost it resolves to right now
 *   revoke  - {userId}            Remove one user's grant
 *   count   - {}                  How many users hold a grant
 *
 * The boost stops applying at FEE_ALLOWANCE_BOOST_ENDS_AT whatever this list holds; the key's Redis
 * expiry is set to the same instant only so the list does not linger.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  FEE_ALLOWANCE_BOOST_ENDS_AT,
  FEE_ALLOWANCE_BOOST_MAX,
  feeAllowanceBoost,
} from '@civitai/buzz';
import { clickhouse } from '~/server/clickhouse/client';
import { OnboardingSteps } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getValidCreatorMembershipMap } from '~/server/services/creator-membership.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const KEY = REDIS_SYS_KEYS.PRICING.FEE_ALLOWANCE_BOOST;
const userId = z.coerce.number().int().positive();
const amount = z.coerce
  .number()
  .int()
  .min(1)
  .max(FEE_ALLOWANCE_BOOST_MAX)
  .default(FEE_ALLOWANCE_BOOST_MAX);
const GRANT_CHUNK = 250;

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant'),
    userIds: z.array(userId).min(1).max(5000),
    amount,
  }),
  z.object({
    action: z.literal('grant-eligible'),
    amount,
    dryRun: z.boolean().default(false),
  }),
  z.object({ action: z.literal('get'), userId }),
  z.object({ action: z.literal('revoke'), userId }),
  z.object({ action: z.literal('count') }),
]);

/**
 * Adds only new grants, so a re-run can never lower one. Chunked so a large list does not fill the
 * shared sysRedis client's command queue.
 */
async function grant(userIds: number[], value: number) {
  const ids = [...new Set(userIds)];
  let granted = 0;
  for (let i = 0; i < ids.length; i += GRANT_CHUNK) {
    const added = await Promise.all(
      ids.slice(i, i + GRANT_CHUNK).map((id) => sysRedis.hSetNX(KEY, String(id), String(value)))
    );
    granted += added.filter(Boolean).length;
  }
  await sysRedis.expireAt(KEY, FEE_ALLOWANCE_BOOST_ENDS_AT);
  return {
    granted,
    alreadyGranted: ids.length - granted,
    amount: value,
    endsAt: FEE_ALLOWANCE_BOOST_ENDS_AT,
  };
}

async function eligibleUserIds() {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const banked = await clickhouse.$query<{ userId: number | string }>`
    SELECT DISTINCT fromAccountId AS userId
    FROM buzzTransactions
    WHERE type = 'bank'
      AND toAccountType IN ('creatorProgramBank', 'creatorProgramBankGreen')
      AND date >= now() - INTERVAL 12 MONTH
  `;
  const flagged = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id FROM "User" WHERE onboarding & ${OnboardingSteps.CreatorProgram} != 0
  `;
  const valid = await getValidCreatorMembershipMap(flagged.map((r) => r.id));
  const bankerIds = banked.map((r) => Number(r.userId)).filter((id) => id > 0);
  const memberIds = flagged.map((r) => r.id).filter((id) => valid.get(id));

  // One standing filter over both lists: a banker can since have been banned or deleted too.
  const candidates = [...new Set([...bankerIds, ...memberIds])];
  const inGoodStanding = candidates.length
    ? await dbRead.$queryRaw<{ id: number }[]>`
        SELECT id FROM "User"
        WHERE id = ANY(${candidates})
          AND onboarding & ${OnboardingSteps.BannedCreatorProgram} = 0
          AND "bannedAt" IS NULL
          AND "deletedAt" IS NULL
      `
    : [];
  const allowed = new Set(inGoodStanding.map((r) => r.id));
  const bankers = bankerIds.filter((id) => allowed.has(id));
  const members = memberIds.filter((id) => allowed.has(id));
  return { bankers, members, all: candidates.filter((id) => allowed.has(id)) };
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const input = parsed.data;

  switch (input.action) {
    case 'grant': {
      if (new Date() >= FEE_ALLOWANCE_BOOST_ENDS_AT)
        return res.status(400).json({ error: 'The boost window has closed.' });
      return res.status(200).json(await grant(input.userIds, input.amount));
    }
    case 'grant-eligible': {
      if (new Date() >= FEE_ALLOWANCE_BOOST_ENDS_AT)
        return res.status(400).json({ error: 'The boost window has closed.' });
      const { bankers, members, all } = await eligibleUserIds();
      const counts = { bankers: bankers.length, members: members.length, eligible: all.length };
      if (input.dryRun) return res.status(200).json({ dryRun: true, ...counts });
      return res.status(200).json({ ...counts, ...(await grant(all, input.amount)) });
    }
    case 'get': {
      const stored = await sysRedis.hGet<string>(KEY, String(input.userId));
      return res.status(200).json({ stored, boost: feeAllowanceBoost(stored) });
    }
    case 'revoke': {
      const removed = await sysRedis.hDel(KEY, String(input.userId));
      return res.status(200).json({ removed });
    }
    case 'count': {
      const all = await sysRedis.hGetAll(KEY);
      return res.status(200).json({ count: Object.keys(all).length });
    }
  }
});
