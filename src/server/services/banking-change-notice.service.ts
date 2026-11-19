import { clickhouse } from '~/server/clickhouse/client';
import { OnboardingSteps } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { isEmailConfigured } from '~/server/email/client';
import { bankingChangeNoticeEmail } from '~/server/email/templates/bankingChangeNotice.email';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { getValidCreatorMembershipMap } from '~/server/services/creator-membership.service';
import type { Sleep } from '~/server/services/notice-ledger.service';
import {
  getNoticeSentIds,
  sendLedgeredNotice,
  withThrottleRetry,
} from '~/server/services/notice-ledger.service';
import { Flags } from '~/shared/utils/flags';

const SENT_KEY = REDIS_SYS_KEYS.NOTICES.BANKING_CHANGE_SENT;
const SENT_LEDGER_EXPIRES_AT = new Date('2027-03-01T00:00:00Z');

type CandidateRow = {
  id: number;
  email: string | null;
  username: string | null;
  onboarding: number;
  bannedAt: Date | null;
  deletedAt: Date | null;
};

export function isNoticeRecipient(row: CandidateRow) {
  return (
    !row.bannedAt &&
    !row.deletedAt &&
    !Flags.hasFlag(row.onboarding, OnboardingSteps.BannedCreatorProgram)
  );
}

/** Banked in the last 12 months, or a current paid Creator Program member; never banned or deleted. */
export async function getBankingChangeNoticeAudience() {
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

  const candidates = [...new Set([...bankerIds, ...memberIds])];
  const rows = candidates.length
    ? await dbRead.$queryRaw<CandidateRow[]>`
        SELECT id, email, username, onboarding, "bannedAt", "deletedAt"
        FROM "User"
        WHERE id = ANY(${candidates})
      `
    : [];
  const recipients = rows.filter(isNoticeRecipient);
  const allowed = new Set(recipients.map((r) => r.id));
  return {
    bankers: bankerIds.filter((id) => allowed.has(id)).length,
    members: memberIds.filter((id) => allowed.has(id)).length,
    recipients,
  };
}

export async function sendBankingChangeNotice({
  dryRun,
  count,
  batchSize,
  minIntervalMs,
  sleep,
}: {
  dryRun: boolean;
  count: number;
  batchSize: number;
  minIntervalMs?: number;
  sleep?: Sleep;
}) {
  const { bankers, members, recipients } = await getBankingChangeNoticeAudience();
  const withEmail = recipients.filter((r) => !!r.email);
  const alreadySent = await getNoticeSentIds(
    SENT_KEY,
    withEmail.map((r) => r.id)
  );
  const pending = withEmail.filter((r) => !alreadySent.has(r.id));
  const summary = {
    bankers,
    members,
    eligible: recipients.length,
    noEmail: recipients.length - withEmail.length,
    alreadySent: alreadySent.size,
  };
  if (dryRun) return { dryRun: true, ...summary, wouldSend: Math.min(count, pending.length) };
  // sendEmail returns without sending when there is no transport, which would record users as sent.
  if (!isEmailConfigured()) throw new Error('Email is not configured on this server');

  const result = await sendLedgeredNotice({
    ledgerKey: SENT_KEY,
    expiresAt: SENT_LEDGER_EXPIRES_AT,
    logName: 'banking-change-notice',
    pending,
    count,
    batchSize,
    minIntervalMs,
    sleep,
    send: (user) =>
      withThrottleRetry(
        () =>
          bankingChangeNoticeEmail.send({
            to: user.email as string,
            username: user.username ?? 'there',
          }),
        { sleep }
      ),
  });
  return { dryRun: false, ...summary, ...result };
}
