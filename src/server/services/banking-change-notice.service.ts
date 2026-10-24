import { clickhouse } from '~/server/clickhouse/client';
import { OnboardingSteps } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { isEmailConfigured } from '~/server/email/client';
import { bankingChangeNoticeEmail } from '~/server/email/templates/bankingChangeNotice.email';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getValidCreatorMembershipMap } from '~/server/services/creator-membership.service';
import { Flags } from '~/shared/utils/flags';

const SENT_KEY = REDIS_SYS_KEYS.NOTICES.BANKING_CHANGE_SENT;
const SENT_LEDGER_EXPIRES_AT = new Date('2027-03-01T00:00:00Z');
const READ_CHUNK = 500;

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

async function getSentIds(ids: number[]) {
  const sent = new Set<number>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK);
    const values = await sysRedis.hmGet(SENT_KEY, chunk.map(String));
    values.forEach((value, j) => {
      if (value) sent.add(chunk[j]);
    });
  }
  return sent;
}

export async function sendBankingChangeNotice({
  dryRun,
  count,
  batchSize,
}: {
  dryRun: boolean;
  count: number;
  batchSize: number;
}) {
  const { bankers, members, recipients } = await getBankingChangeNoticeAudience();
  const withEmail = recipients.filter((r) => !!r.email);
  const alreadySent = await getSentIds(withEmail.map((r) => r.id));
  const pending = withEmail.filter((r) => !alreadySent.has(r.id));
  const batch = pending.slice(0, count);
  const summary = {
    bankers,
    members,
    eligible: recipients.length,
    noEmail: recipients.length - withEmail.length,
    alreadySent: alreadySent.size,
  };
  if (dryRun) return { dryRun: true, ...summary, wouldSend: batch.length };
  // sendEmail returns without sending when there is no transport, which would record users as sent.
  if (!isEmailConfigured()) throw new Error('Email is not configured on this server');

  let sent = 0;
  let skipped = 0;
  const failedUserIds: number[] = [];
  const stuckUserIds: number[] = [];
  for (let i = 0; i < batch.length; i += batchSize) {
    await Promise.all(
      batch.slice(i, i + batchSize).map(async (user) => {
        // The claim, not the earlier read, is what stops a concurrent or repeated run sending twice.
        const claimed = await sysRedis.hSetNX(SENT_KEY, String(user.id), new Date().toISOString());
        if (!claimed) {
          skipped++;
          return;
        }
        try {
          await bankingChangeNoticeEmail.send({
            to: user.email as string,
            username: user.username ?? 'there',
          });
          sent++;
        } catch {
          failedUserIds.push(user.id);
          await sysRedis.hDel(SENT_KEY, String(user.id)).catch(() => stuckUserIds.push(user.id));
        }
      })
    );
  }
  if (sent) await sysRedis.expireAt(SENT_KEY, SENT_LEDGER_EXPIRES_AT);

  return {
    dryRun: false,
    ...summary,
    sent,
    skipped,
    failed: failedUserIds.length,
    failedUserIds,
    // Failed AND still recorded as sent, so later runs skip them until they are unmarked.
    stuckUserIds,
    remaining: pending.length - sent - skipped,
  };
}
