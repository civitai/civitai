import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { revokeCivitaiUserTokens } from '~/server/services/orchestrator/civitai';
import {
  markTokenRevocation,
  revokeUserTokens,
} from '~/server/services/user-token-revocation.service';

const NAME = 'revoke-user-tokens';
const RESEND_HOURS = 24;
const ALERT_HOURS = 48;
const WINDOW_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
// Inlined, not bound: Prisma binds numbers as int8 and make_interval only takes int4.
const WINDOW = Prisma.raw(`make_interval(hours => ${WINDOW_HOURS})`);

type Row = {
  id: number;
  since: Date;
  revocation: { confirmedAt?: string; alertedAt?: string } | null;
};

/**
 * For a day after a ban or deletion, re-sends the orchestrator's token-cache expiry even when the
 * first call was confirmed: the orchestrator holds that mark in memory, so a restart before the
 * token's next use loses it. Unconfirmed accounts are retried in full until confirmed, and alerted
 * on once at 48h.
 */
export async function revokeRecentlyBannedUserTokens(now = new Date()) {
  const rows = await dbWrite.$queryRaw<Row[]>`
    SELECT id, GREATEST("bannedAt", "deletedAt") AS "since", meta -> 'tokenRevocation' AS "revocation"
    FROM "User"
    WHERE "bannedAt" > NOW() - ${WINDOW} OR "deletedAt" > NOW() - ${WINDOW}
  `;

  const limit = pLimit(10);
  const outcomes = await Promise.all(
    rows.map((row) =>
      limit(async () => {
        const ageHours = (now.getTime() - new Date(row.since).getTime()) / HOUR_MS;
        if (row.revocation?.confirmedAt) {
          if (ageHours < RESEND_HOURS) await revokeCivitaiUserTokens({ userId: row.id });
          return 'confirmed';
        }

        if (await revokeUserTokens(row.id, { retryDelaysMs: [] })) return 'confirmed';
        if (ageHours >= ALERT_HOURS && !row.revocation?.alertedAt) {
          await logToAxiom({
            type: 'error',
            name: 'user-token-revocation-unconfirmed',
            userId: row.id,
            message: `orchestrator token revocation for user ${row.id} still unconfirmed after ${ALERT_HOURS}h`,
          }).catch(() => null);
          await markTokenRevocation(row.id, 'alertedAt');
        }
        return 'unconfirmed';
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
