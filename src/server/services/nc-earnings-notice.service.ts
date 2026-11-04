import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { isEmailConfigured } from '~/server/email/client';
import { ncEarningsNoticeEmail } from '~/server/email/templates/ncEarningsNotice.email';
// The client throws on failure; the service wrapper swallows errors, which would record a failed send.
import { notifications } from '~/server/notifications/client';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import type { NoticeLedgerKey, Sleep } from '~/server/services/notice-ledger.service';
import {
  getNoticeSentIds,
  sendLedgeredNotice,
  withThrottleRetry,
} from '~/server/services/notice-ledger.service';
import type { NcEarningsNotice } from '~/shared/constants/nc-earnings-notice.constants';
import {
  NC_EARNINGS_NOTICE,
  fillNcEarningsCopy,
  getNcEarningsNoticeUrl,
} from '~/shared/constants/nc-earnings-notice.constants';

const LEDGER: Record<NcEarningsNotice, NoticeLedgerKey> = {
  'nc-recent': REDIS_SYS_KEYS.NOTICES.NC_RECENT_SENT,
  'nc-older': REDIS_SYS_KEYS.NOTICES.NC_OLDER_SENT,
};
const LEDGER_EXPIRES_AT = new Date('2027-03-01T00:00:00Z');

export const ncEarningsNoticeLedger = (notice: NcEarningsNotice) => LEDGER[notice];

export type NcVersionRow = {
  userId: number;
  baseModel: string;
  modelName: string;
  versionName: string;
  status: string;
  licensingFee: number | null;
};

export type NcUserRow = {
  id: number;
  email: string | null;
  username: string | null;
  bannedAt: Date | null;
  deletedAt: Date | null;
};

export type NcRecipient = NcUserRow & { baseModels: string[]; versions: string[] };

/** Base models count every version the query returned; fee versions are only Published ones with a fee. */
export function buildNcRecipients(
  notice: NcEarningsNotice,
  userIds: number[],
  versions: NcVersionRow[],
  users: NcUserRow[]
) {
  const order = NC_EARNINGS_NOTICE[notice].baseModels;
  const byUser = new Map<number, { bases: Set<string>; versions: string[] }>();
  for (const v of versions) {
    if (!order.includes(v.baseModel)) continue;
    const entry = byUser.get(v.userId) ?? { bases: new Set<string>(), versions: [] };
    entry.bases.add(v.baseModel);
    if (v.status === 'Published' && (v.licensingFee ?? 0) > 0)
      entry.versions.push(`${v.modelName}: ${v.versionName}`);
    byUser.set(v.userId, entry);
  }
  const usersById = new Map(users.map((u) => [u.id, u]));
  const recipients: NcRecipient[] = [];
  const bannedOrDeleted: number[] = [];
  const noVersions: number[] = [];
  const unknown: number[] = [];
  for (const id of new Set(userIds)) {
    const user = usersById.get(id);
    if (!user) {
      unknown.push(id);
      continue;
    }
    if (user.bannedAt || user.deletedAt) {
      bannedOrDeleted.push(id);
      continue;
    }
    const entry = byUser.get(id);
    if (!entry) {
      noVersions.push(id);
      continue;
    }
    recipients.push({
      ...user,
      baseModels: order.filter((b) => entry.bases.has(b)),
      versions: entry.versions.sort(),
    });
  }
  return { recipients, bannedOrDeleted, noVersions, unknown };
}

async function getNcAudience(notice: NcEarningsNotice, userIds: number[]) {
  const ids = [...new Set(userIds)];
  const [versions, users] = await Promise.all([
    dbRead.$queryRaw<NcVersionRow[]>`
      SELECT
        m."userId" AS "userId",
        mv."baseModel" AS "baseModel",
        m.name AS "modelName",
        mv.name AS "versionName",
        mv.status::text AS status,
        mv."licensingFee" AS "licensingFee"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE m."userId" = ANY(${ids})
        AND mv."baseModel" = ANY(${NC_EARNINGS_NOTICE[notice].baseModels})
        AND mv.status::text <> 'Deleted' AND m."deletedAt" IS NULL
    `,
    dbRead.$queryRaw<NcUserRow[]>`
      SELECT id, email, username, "bannedAt", "deletedAt" FROM "User" WHERE id = ANY(${ids})
    `,
  ]);
  return buildNcRecipients(notice, ids, versions, users);
}

export async function sendNcEarningsNotice({
  notice,
  userIds,
  dryRun,
  count,
  batchSize,
  date,
  minIntervalMs,
  sleep,
}: {
  notice: NcEarningsNotice;
  userIds: number[];
  dryRun: boolean;
  count: number;
  batchSize: number;
  date: string;
  minIntervalMs?: number;
  sleep?: Sleep;
}) {
  const ledgerKey = LEDGER[notice];
  const { recipients, bannedOrDeleted, noVersions, unknown } = await getNcAudience(notice, userIds);
  const alreadySent = await getNoticeSentIds(
    ledgerKey,
    recipients.map((r) => r.id)
  );
  const pending = recipients.filter((r) => !alreadySent.has(r.id));
  const summary = {
    notice,
    listed: new Set(userIds).size,
    recipients: recipients.length,
    withFee: recipients.filter((r) => r.versions.length > 0).length,
    noEmail: recipients.filter((r) => !r.email).length,
    alreadySent: alreadySent.size,
    bannedOrDeleted,
    noVersions,
    unknown,
  };
  if (dryRun) return { dryRun: true, ...summary, wouldSend: Math.min(count, pending.length) };
  // sendEmail returns without sending when there is no transport, which would record users as sent.
  if (!isEmailConfigured()) throw new Error('Email is not configured on this server');

  const copy = NC_EARNINGS_NOTICE[notice];
  const result = await sendLedgeredNotice({
    ledgerKey,
    expiresAt: LEDGER_EXPIRES_AT,
    logName: `${notice}-notice`,
    pending,
    count,
    batchSize,
    minIntervalMs,
    sleep,
    send: async (user) => {
      const hadFee = user.versions.length > 0;
      await notifications.createNotification({
        userId: user.id,
        category: NotificationCategory.System,
        type: 'system-announcement',
        key: `system-announcement:${notice}-notice:${user.id}`,
        details: {
          message: fillNcEarningsCopy(
            (hadFee && copy.feeMessage) || copy.message,
            user.baseModels,
            hadFee
          ),
          url: getNcEarningsNoticeUrl(user.username),
        },
      });
      const email = user.email;
      if (email) {
        await withThrottleRetry(
          () =>
            ncEarningsNoticeEmail.send({
              to: email,
              notice,
              username: user.username ?? 'there',
              date,
              baseModels: user.baseModels,
              versions: user.versions,
            }),
          { sleep }
        );
      }
    },
  });
  return { dryRun: false, ...summary, ...result };
}
