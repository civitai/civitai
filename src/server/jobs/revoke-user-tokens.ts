import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { expireUserApiKeys } from '~/server/services/api-key.service';
import {
  markTokenRevocation,
  revokeUserTokens,
} from '~/server/services/user-token-revocation.service';

const NAME = 'revoke-user-tokens';
const RESEND_HOURS = 24;
const ALERT_HOURS = 48;
const WINDOW_HOURS = 72;
// Inlined, not bound: Prisma binds numbers as int8 and make_interval only takes int4. Times are
// compared in UTC, which the query pins explicitly rather than relying on the session time zone.
const WINDOW = Prisma.raw(`make_interval(hours => ${WINDOW_HOURS})`);

type Row = {
  id: number;
  since: number;
  ageHours: number;
  revocation: { confirmedAt?: string; alertedAt?: string } | null;
};

/**
 * Repeats each ban's or deletion's token revocation for its first day, then keeps retrying any
 * account the orchestrator has not confirmed, and alerts once on one still unconfirmed at 48h.
 */
export async function revokeRecentlyBannedUserTokens() {
  // Nothing could ever confirm, and every account would alert.
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) return { accounts: 0, unconfirmed: 0, skipped: true };

  const rows = await dbWrite.$queryRaw<Row[]>`
    SELECT
      id,
      EXTRACT(EPOCH FROM GREATEST("bannedAt", "deletedAt"))::float8 AS "since",
      EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'UTC') - GREATEST("bannedAt", "deletedAt"))::float8 / 3600
        AS "ageHours",
      meta -> 'tokenRevocation' AS "revocation"
    FROM "User"
    WHERE "bannedAt" > (NOW() AT TIME ZONE 'UTC') - ${WINDOW}
       OR "deletedAt" > (NOW() AT TIME ZONE 'UTC') - ${WINDOW}
  `;

  const limit = pLimit(10);
  const outcomes = await Promise.all(
    rows.map((row) =>
      limit(async () => {
        try {
          if (row.revocation?.confirmedAt) {
            // Also catches a key minted after the first pass, and a failed cache eviction.
            if (row.ageHours < RESEND_HOURS) await expireUserApiKeys(row.id);
            return 'confirmed';
          }

          if (await revokeUserTokens(row.id, { retryDelaysMs: [] })) return 'confirmed';
          if (row.ageHours >= ALERT_HOURS && !row.revocation?.alertedAt) {
            await logToAxiom({
              type: 'error',
              name: 'user-token-revocation-unconfirmed',
              userId: row.id,
              message: `orchestrator token revocation for user ${row.id} still unconfirmed after ${ALERT_HOURS}h`,
            }).catch(() => null);
            await markTokenRevocation(row.id, 'alertedAt', row.since);
          }
          return 'unconfirmed';
        } catch (error) {
          logToAxiom({
            type: 'error',
            name: NAME,
            userId: row.id,
            message: (error as Error).message,
          }).catch(() => null);
          return 'unconfirmed';
        }
      })
    )
  );

  return {
    accounts: rows.length,
    unconfirmed: outcomes.filter((outcome) => outcome === 'unconfirmed').length,
  };
}

export const revokeUserTokensJob = createJob(NAME, '*/15 * * * *', () =>
  revokeRecentlyBannedUserTokens()
);
