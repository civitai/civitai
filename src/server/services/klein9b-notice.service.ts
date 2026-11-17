import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { isEmailConfigured } from '~/server/email/client';
import { klein9bNoticeEmail } from '~/server/email/templates/klein9bNotice.email';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
// The client throws on failure; the service wrapper swallows errors, which would record a failed send.
import { notifications } from '~/server/notifications/client';
import type { Sleep } from '~/server/services/notice-ledger.service';
import {
  getNoticeSentIds,
  sendLedgeredNotice,
  withThrottleRetry,
} from '~/server/services/notice-ledger.service';
import type { Klein9bNoticeVariant } from '~/shared/constants/klein9b-notice.constants';
import {
  KLEIN9B_NOTICE,
  KLEIN9B_NOTICE_BASE_MODELS,
  getKlein9bNoticeUrl,
} from '~/shared/constants/klein9b-notice.constants';

const SENT_KEY = REDIS_SYS_KEYS.NOTICES.KLEIN9B_SENT;
const SENT_LEDGER_EXPIRES_AT = new Date('2027-03-01T00:00:00Z');

export type Klein9bVersionRow = {
  userId: number;
  modelName: string;
  versionName: string;
  status: string;
  modelStatus: string;
  /** Private on the version or its model: not public, so not "listed". */
  private: boolean;
  licensingFee: number | null;
  paidAccess: boolean;
};

export type Klein9bUserRow = {
  id: number;
  email: string | null;
  username: string | null;
  bannedAt: Date | null;
  deletedAt: Date | null;
};

export type Klein9bRecipient = Klein9bUserRow & {
  variant: Klein9bNoticeVariant;
  versions: string[];
};

/**
 * Only listed versions count (published and public, on a published, public model): both notices tell the creator the
 * versions "stay listed" / "stay published". Charged: a listed version with a fee or open paid access.
 * Uncharged: a listed version and nothing charged. Charged wins.
 */
export function classifyKlein9bAudience(versions: Klein9bVersionRow[], users: Klein9bUserRow[]) {
  const byUser = new Map<number, { charged: string[] }>();
  for (const v of versions) {
    if (v.status !== 'Published' || v.modelStatus !== 'Published' || v.private) continue;
    const entry = byUser.get(v.userId) ?? { charged: [] };
    if ((v.licensingFee ?? 0) > 0 || v.paidAccess)
      entry.charged.push(`${v.modelName}: ${v.versionName}`);
    byUser.set(v.userId, entry);
  }
  const recipients: Klein9bRecipient[] = [];
  let excluded = 0;
  for (const user of users) {
    const entry = byUser.get(user.id);
    if (!entry) continue;
    if (user.bannedAt || user.deletedAt) {
      excluded++;
      continue;
    }
    recipients.push(
      entry.charged.length
        ? { ...user, variant: 'charged', versions: entry.charged.sort() }
        : { ...user, variant: 'uncharged', versions: [] }
    );
  }
  return { recipients, excluded };
}

export async function getKlein9bNoticeAudience() {
  const versions = await dbRead.$queryRaw<Klein9bVersionRow[]>`
    SELECT
      m."userId" AS "userId",
      m.name AS "modelName",
      mv.name AS "versionName",
      mv.status::text AS status,
      m.status::text AS "modelStatus",
      (mv.availability::text = 'Private' OR m.availability::text = 'Private') AS private,
      mv."licensingFee" AS "licensingFee",
      EXISTS (
        SELECT 1 FROM "PaidAccess" pa
        WHERE pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
          AND (pa."endsAt" IS NULL OR pa."endsAt" > now())
      ) AS "paidAccess"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv."baseModel" = ANY(${KLEIN9B_NOTICE_BASE_MODELS})
      AND mv.status::text = 'Published' AND m.status::text = 'Published' AND m."deletedAt" IS NULL
  `;
  const userIds = [...new Set(versions.map((v) => v.userId))];
  const users = userIds.length
    ? await dbRead.$queryRaw<Klein9bUserRow[]>`
        SELECT id, email, username, "bannedAt", "deletedAt" FROM "User" WHERE id = ANY(${userIds})
      `
    : [];
  return classifyKlein9bAudience(versions, users);
}

export async function sendKlein9bNotice({
  dryRun,
  count,
  batchSize,
  date,
  minIntervalMs,
  sleep,
}: {
  dryRun: boolean;
  count: number;
  batchSize: number;
  date: string;
  minIntervalMs?: number;
  sleep?: Sleep;
}) {
  const { recipients, excluded } = await getKlein9bNoticeAudience();
  const alreadySent = await getNoticeSentIds(
    SENT_KEY,
    recipients.map((r) => r.id)
  );
  const pending = recipients.filter((r) => !alreadySent.has(r.id));
  const summary = {
    charged: recipients.filter((r) => r.variant === 'charged').length,
    uncharged: recipients.filter((r) => r.variant === 'uncharged').length,
    bannedOrDeleted: excluded,
    noEmail: recipients.filter((r) => !r.email).length,
    alreadySent: alreadySent.size,
  };
  if (dryRun) return { dryRun: true, ...summary, wouldSend: Math.min(count, pending.length) };
  // sendEmail returns without sending when there is no transport, which would record users as sent.
  if (!isEmailConfigured()) throw new Error('Email is not configured on this server');

  const result = await sendLedgeredNotice({
    ledgerKey: SENT_KEY,
    expiresAt: SENT_LEDGER_EXPIRES_AT,
    logName: 'klein9b-notice',
    pending,
    count,
    batchSize,
    minIntervalMs,
    sleep,
    send: async (user) => {
      await notifications.createNotification({
        userId: user.id,
        category: NotificationCategory.System,
        type: 'system-announcement',
        key: `system-announcement:klein9b-notice:${user.id}`,
        details: {
          message: KLEIN9B_NOTICE[user.variant].message,
          url: getKlein9bNoticeUrl(user.username),
        },
      });
      const email = user.email;
      if (email) {
        await withThrottleRetry(
          () =>
            klein9bNoticeEmail.send({
              to: email,
              variant: user.variant,
              username: user.username ?? 'there',
              date,
              versions: user.versions,
            }),
          { sleep }
        );
      }
    },
  });
  return { dryRun: false, ...summary, ...result };
}
