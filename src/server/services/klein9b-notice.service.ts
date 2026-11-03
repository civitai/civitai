import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { isEmailConfigured } from '~/server/email/client';
import { klein9bNoticeEmail } from '~/server/email/templates/klein9bNotice.email';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
// The client throws on failure; the service wrapper swallows errors, which would record a failed send.
import { notifications } from '~/server/notifications/client';
import type { Klein9bNoticeVariant } from '~/shared/constants/klein9b-notice.constants';
import {
  KLEIN9B_NOTICE,
  KLEIN9B_NOTICE_BASE_MODELS,
  KLEIN9B_NOTICE_URL,
} from '~/shared/constants/klein9b-notice.constants';

const SENT_KEY = REDIS_SYS_KEYS.NOTICES.KLEIN9B_SENT;
const SENT_LEDGER_EXPIRES_AT = new Date('2027-03-01T00:00:00Z');
const READ_CHUNK = 500;

export type Klein9bVersionRow = {
  userId: number;
  modelName: string;
  versionName: string;
  status: string;
  modelStatus: string;
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
 * Only listed versions count (published, on a published model): both notices tell the creator the
 * versions "stay listed" / "stay published". Charged: a listed version with a fee or open paid access.
 * Uncharged: a listed version and nothing charged. Charged wins.
 */
export function classifyKlein9bAudience(versions: Klein9bVersionRow[], users: Klein9bUserRow[]) {
  const byUser = new Map<number, { charged: string[] }>();
  for (const v of versions) {
    if (v.status !== 'Published' || v.modelStatus !== 'Published') continue;
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

export async function sendKlein9bNotice({
  dryRun,
  count,
  batchSize,
  date,
}: {
  dryRun: boolean;
  count: number;
  batchSize: number;
  date: string;
}) {
  const { recipients, excluded } = await getKlein9bNoticeAudience();
  const alreadySent = await getSentIds(recipients.map((r) => r.id));
  const pending = recipients.filter((r) => !alreadySent.has(r.id));
  const batch = pending.slice(0, count);
  const summary = {
    charged: recipients.filter((r) => r.variant === 'charged').length,
    uncharged: recipients.filter((r) => r.variant === 'uncharged').length,
    bannedOrDeleted: excluded,
    noEmail: recipients.filter((r) => !r.email).length,
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
          await notifications.createNotification({
            userId: user.id,
            category: NotificationCategory.System,
            type: 'system-announcement',
            key: `system-announcement:klein9b-notice:${user.id}`,
            details: { message: KLEIN9B_NOTICE[user.variant].message, url: KLEIN9B_NOTICE_URL },
          });
          if (user.email) {
            await klein9bNoticeEmail.send({
              to: user.email,
              variant: user.variant,
              username: user.username ?? 'there',
              date,
              versions: user.versions,
            });
          }
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
