import type { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { OnboardingSteps } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { readMinimum } from '~/server/jobs/creator-program-counterparty-review';
import { logToAxiom } from '~/server/logging/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  runPrepayoutReview,
  type AccountState,
  type PayoutReviewFlag,
} from '~/server/services/creator-program-prepayout-review/run';
import { parseLimits } from '~/server/services/creator-program-prepayout-review/signals';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

const { PREPAYOUT_LIMITS, COUNTERPARTY_REVIEW_WARNINGS } = REDIS_SYS_KEYS.CREATOR_PROGRAM;
const ACCOUNT_LOOKUP_CHUNK = 1_000;

export async function readLimits() {
  return parseLimits(decodeRedisString(await sysRedis.get(PREPAYOUT_LIMITS)));
}

async function getWarnedAt(userIds: number[]) {
  const all = await sysRedis.hGetAll(COUNTERPARTY_REVIEW_WARNINGS);
  const warned = new Map<number, string>();
  for (const userId of userIds) {
    const raw = decodeRedisString(all[String(userId)]);
    if (!raw) continue;
    try {
      warned.set(userId, (JSON.parse(raw) as { warnedAt: string }).warnedAt);
    } catch {
      // An unreadable record is treated as no warning; the counterparty review owns that hash.
    }
  }
  return warned;
}

async function loadAccounts(userIds: number[]) {
  const accounts = new Map<number, AccountState>();
  for (let i = 0; i < userIds.length; i += ACCOUNT_LOOKUP_CHUNK) {
    const chunk = userIds.slice(i, i + ACCOUNT_LOOKUP_CHUNK);
    const rows = await dbRead.$queryRaw<(AccountState & { id: number })[]>`
      SELECT u.id, u.username, u."createdAt", u.muted, u."bannedAt" IS NOT NULL AS banned,
        (u.onboarding & ${OnboardingSteps.BannedCreatorProgram}) != 0 AS "programBanned",
        EXISTS (
          SELECT 1 FROM "UserRestriction" r WHERE r."userId" = u.id AND r.status = 'Pending'
        ) AS "pendingRestriction"
      FROM "User" u
      WHERE u.id = ANY(${chunk}::int[])
    `;
    for (const { id, ...account } of rows) accounts.set(id, account);
  }
  return accounts;
}

const store = {
  startRun: async (period: string, startedAt: Date) =>
    (await dbWrite.creatorProgramPayoutReviewRun.create({ data: { period, startedAt } })).id,
  finishRun: async (
    runId: number,
    data: {
      finishedAt: Date;
      creditedCount: number;
      evaluatedCount: number;
      flaggedCount: number;
      error: string | null;
    }
  ) => {
    await dbWrite.creatorProgramPayoutReviewRun.update({ where: { id: runId }, data });
  },
  saveFlag: async ({ period, userId, signals, payoutCents, evidence }: PayoutReviewFlag) => {
    const row = await dbWrite.creatorProgramPayoutReview.upsert({
      where: { period_userId: { period, userId } },
      create: { period, userId, signals, payoutCents, evidence: evidence as Prisma.InputJsonValue },
      update: {
        signals,
        payoutCents,
        evidence: evidence as Prisma.InputJsonValue,
        lastEvaluatedAt: new Date(),
        evaluations: { increment: 1 },
      },
      select: { evaluations: true },
    });
    return { created: row.evaluations === 1 };
  },
};

/**
 * Daily from the 1st to the 14th, so last month's pending payouts are reviewed before the 15th's
 * settlement and re-reviewed as new evidence lands.
 */
export const creatorProgramPrepayoutReview = createJob(
  'creator-program-prepayout-review',
  '0 6 1-14 * *',
  async () =>
    runPrepayoutReview({
      ch: clickhouse ?? null,
      readLimits,
      readCounterpartyMinimum: readMinimum,
      getWarnedAt,
      loadAccounts,
      store,
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      log: (name, data) =>
        void logToAxiom({ type: name.endsWith('-failed') ? 'error' : 'info', name, ...data }).catch(
          () => undefined
        ),
    }),
  { lockExpiration: 30 * 60 }
);
