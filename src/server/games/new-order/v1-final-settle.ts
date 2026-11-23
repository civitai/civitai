import { clickhouse } from '~/server/clickhouse/client';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { runGrantBlessedBuzz } from '~/server/jobs/new-order-jobs';
import { throwInternalServerError } from '~/server/utils/errorHandling';
import dayjs from '~/shared/utils/dayjs';

// The old in-app Knights game's last payout, run once after its nightly grant and its
// moderator-rating hooks were removed. Deleted with the rest of the v1 code. Pending votes are left
// as they are: settling one re-inserts its row dated today, and the table keeps only the last row
// per (userId, imageId), so the vote's own day would be lost to the Paladin active-days count.

const pendingVotes = `
  SELECT imageId, userId
  FROM (
    SELECT imageId, userId, argMax(status, createdAt) AS latestStatus
    FROM knights_new_order_image_rating
    GROUP BY imageId, userId
  )
  WHERE latestStatus = '${NewOrderImageRatingStatus.Pending}'
`;

function requireClickhouse() {
  if (!clickhouse) throw throwInternalServerError('ClickHouse not available');
  return clickhouse;
}

export async function countPendingV1Votes() {
  const [row] = await requireClickhouse().$query<{
    votes: number;
    images: number;
    players: number;
  }>`
    SELECT count() AS votes, uniq(imageId) AS images, uniq(userId) AS players
    FROM (${pendingVotes})
  `;
  return {
    votes: Number(row?.votes ?? 0),
    images: Number(row?.images ?? 0),
    players: Number(row?.players ?? 0),
  };
}

/** Payout-blocked players with v1 judgments nothing pays: the nightly grant held from two days before
 *  the block, and `pay` skips a blocked player from `from` on. Clearing the block no longer pays them. */
export async function countHeldV1Players(from?: Date) {
  const blocked = await dbRead.newOrderPlayer.findMany({
    where: { payoutBlockedAt: { not: null } },
    select: { userId: true, payoutBlockedAt: true },
  });
  if (!blocked.length) return { blocked: 0, withHeldJudgments: 0 };
  const conditions = blocked
    .map(
      (p) =>
        `(userId = ${p.userId} AND createdAt >= parseDateTimeBestEffort('${heldFrom(
          p.payoutBlockedAt!,
          from
        ).toISOString()}'))`
    )
    .join(' OR ');
  const [row] = await requireClickhouse().$query<{ players: number }>`
    SELECT uniq(userId) AS players
    FROM knights_new_order_image_rating
    WHERE (${conditions})
      AND status IN ('${NewOrderImageRatingStatus.Correct}', '${NewOrderImageRatingStatus.Failed}')
  `;
  return { blocked: blocked.length, withHeldJudgments: Number(row?.players ?? 0) };
}

function heldFrom(blockedAt: Date, from?: Date) {
  const nightlyHeldFrom = dayjs(blockedAt).startOf('day').subtract(2, 'day');
  return from && dayjs(from).isBefore(nightlyHeldFrom)
    ? dayjs(from).startOf('day').toDate()
    : nightlyHeldFrom.toDate();
}

/** Pays each day from `from` through today, oldest first. */
export async function payV1Days(from: Date) {
  const days: string[] = [];
  const today = dayjs().startOf('day');
  for (let day = dayjs(from).startOf('day'); !day.isAfter(today); day = day.add(1, 'day')) {
    await runGrantBlessedBuzz(day.toDate());
    days.push(day.toDate().toISOString());
  }
  return { days };
}
