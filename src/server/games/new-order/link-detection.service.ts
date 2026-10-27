import { publicIpOnlySql } from '@civitai/shared/clickhouse-ip-filters';
import { clickhouse } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  clusterFingerprint,
  detectLinkedClusters,
  parseLinkDetectionConfig,
  type IpGroup,
  type LinkCluster,
  type LinkDetectionConfig,
  type TipRow,
} from '~/server/games/new-order/link-detection';
import { getVotingRateLimitConfig } from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

export const LINK_REVIEW_STATUS = {
  Pending: 'Pending',
  Blocked: 'Blocked',
  Cleared: 'Cleared',
} as const;
export const AUTO_BLOCK_REASON = 'Linked accounts: payouts held pending review';

const ints = (ids: number[]) => ids.map((id) => Math.trunc(Number(id))).join(',');

const ipClusterSql = `if(position(ip, ':') > 0, concat(IPv6NumToString(tupleElement(IPv6CIDRToRange(toIPv6OrDefault(ip), 64), 1)), '/64'), ip)`;

async function loadConfig() {
  const config = await getVotingRateLimitConfig();
  return parseLinkDetectionConfig(config?.linkDetection);
}

async function loadEarners(config: LinkDetectionConfig) {
  const rows = await clickhouse!.$query<{ userId: number }>(`
    SELECT userId
    FROM knights_new_order_image_rating FINAL
    WHERE createdAt >= now() - INTERVAL ${Math.trunc(config.lookbackDays)} DAY
      AND rank != 'Acolyte'
      AND status IN ('${NewOrderImageRatingStatus.Correct}', '${NewOrderImageRatingStatus.Failed}')
    GROUP BY userId
    ORDER BY count() DESC
    LIMIT ${Math.trunc(config.maxEarners)}
  `);
  const candidates = rows.map((r) => Number(r.userId));
  if (!candidates.length) return [];
  const players = await dbRead.newOrderPlayer.findMany({
    where: {
      userId: { in: candidates },
      rankType: { not: NewOrderRankType.Acolyte },
      user: { bannedAt: null },
    },
    select: { userId: true },
  });
  return players.map((p) => p.userId);
}

async function loadIpGroups(earners: number[], config: LinkDetectionConfig): Promise<IpGroup[]> {
  const days = Math.trunc(config.lookbackDays);
  const rows = await clickhouse!.$query<{ userIds: number[]; totalAccounts: number }>(`
    WITH mine AS (
      SELECT DISTINCT ${ipClusterSql} AS cluster
      FROM default.userActivities
      WHERE targetUserId IN (${ints(earners)})
        AND type IN ('Registration', 'Login', 'Subscribe')
        AND ${publicIpOnlySql()}
        AND time >= now() - INTERVAL ${days} DAY
    )
    SELECT
      groupUniqArrayIf(targetUserId, targetUserId IN (${ints(earners)})) AS userIds,
      uniq(targetUserId) AS totalAccounts
    FROM default.userActivities
    WHERE ${ipClusterSql} IN (SELECT cluster FROM mine)
      AND type IN ('Registration', 'Login', 'Subscribe')
      AND ${publicIpOnlySql()}
      AND time >= now() - INTERVAL ${days} DAY
    GROUP BY ${ipClusterSql}
    HAVING length(userIds) > 1
  `);
  return rows.map((r) => ({
    members: r.userIds.map(Number),
    totalAccounts: Number(r.totalAccounts),
  }));
}

async function loadTips(earners: number[], config: LinkDetectionConfig): Promise<TipRow[]> {
  const rows = await clickhouse!.$query<{
    fromAccountId: number;
    toAccountId: number;
    amount: number;
    at: number;
  }>(`
    SELECT fromAccountId, toAccountId, amount, toUnixTimestamp(date) AS at
    FROM buzzTransactions
    WHERE type = 'tip'
      AND fromAccountId IN (${ints(earners)})
      AND date >= now() - INTERVAL ${Math.trunc(config.lookbackDays)} DAY
    LIMIT ${Math.trunc(config.maxTipRows)}
  `);
  return rows.map((r) => ({
    from: Number(r.fromAccountId),
    to: Number(r.toAccountId),
    amount: Number(r.amount),
    at: Number(r.at),
  }));
}

export async function findLinkedClusters(config: LinkDetectionConfig): Promise<LinkCluster[]> {
  const earners = await loadEarners(config);
  if (earners.length < 2) return [];
  const [ipGroups, tips] = await Promise.all([
    loadIpGroups(earners, config),
    loadTips(earners, config),
  ]);
  const sinkIds = tips.filter((t) => earners.includes(t.from)).map((t) => t.to);
  const accountIds = [...new Set([...earners, ...sinkIds])];
  const accounts = await dbRead.user.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, createdAt: true },
  });
  return detectLinkedClusters({
    earners,
    ipGroups,
    tips,
    accounts: accounts.map((a) => ({ userId: a.id, createdAt: a.createdAt })),
    config,
  });
}

export async function persistLinkedClusters(clusters: LinkCluster[]) {
  const counts = { blocked: 0, queued: 0, skipped: 0 };
  if (!clusters.length) return counts;

  const cleared = await dbRead.newOrderLinkReview.findMany({
    where: { status: LINK_REVIEW_STATUS.Cleared },
    select: { fingerprint: true, userIds: true },
  });
  const clearedFingerprints = new Set(cleared.map((c) => c.fingerprint));
  const clearedUsers = new Set(cleared.flatMap((c) => c.userIds));

  for (const cluster of clusters) {
    const fingerprint = clusterFingerprint(cluster.userIds);
    if (clearedFingerprints.has(fingerprint)) {
      counts.skipped++;
      continue;
    }
    const existing = await dbWrite.newOrderLinkReview.findUnique({
      where: { fingerprint },
      select: { status: true },
    });
    if (existing && existing.status !== LINK_REVIEW_STATUS.Pending) {
      counts.skipped++;
      continue;
    }

    const autoBlock =
      cluster.decision === 'block' && !cluster.userIds.some((id) => clearedUsers.has(id));
    const data = {
      userIds: cluster.userIds,
      evidence: cluster.evidence,
      buzzMoved: Math.round(cluster.buzzMoved),
      autoBlocked: autoBlock,
      status: autoBlock ? LINK_REVIEW_STATUS.Blocked : LINK_REVIEW_STATUS.Pending,
    };

    if (autoBlock) {
      await dbWrite.newOrderPlayer.updateMany({
        where: { userId: { in: cluster.userIds }, payoutBlockedAt: null },
        data: {
          payoutBlockedAt: new Date(),
          payoutBlockReason: AUTO_BLOCK_REASON,
          payoutBlockedBy: constants.system.user.id,
        },
      });
    }
    await dbWrite.newOrderLinkReview.upsert({
      where: { fingerprint },
      create: { fingerprint, ...data },
      update: data,
    });

    if (autoBlock) {
      counts.blocked++;
      await logToAxiom({
        type: 'warning',
        name: 'new-order-link-auto-block',
        details: { fingerprint, userIds: cluster.userIds, buzzMoved: cluster.buzzMoved },
        message: `Payouts held for ${cluster.userIds.length} linked accounts`,
      }).catch(() => null);
    } else {
      counts.queued++;
    }
  }
  return counts;
}

export async function runLinkDetection() {
  if (!clickhouse) return null;
  const config = await loadConfig();
  if (!config) return null;
  const clusters = await findLinkedClusters(config);
  const counts = await persistLinkedClusters(clusters);
  await logToAxiom({
    type: 'info',
    name: 'new-order-link-detection',
    details: { clusters: clusters.length, ...counts },
    message: `Link detection found ${clusters.length} cluster(s)`,
  }).catch(() => null);
  return counts;
}
