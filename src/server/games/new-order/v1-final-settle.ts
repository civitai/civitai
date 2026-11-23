import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { runGrantBlessedBuzz } from '~/server/jobs/new-order-jobs';
import { processFinalRatings } from '~/server/services/games/new-order.service';
import { throwInternalServerError } from '~/server/utils/errorHandling';
import dayjs from '~/shared/utils/dayjs';

// The old in-app Knights game's last settlement, run once after its nightly grant and its
// moderator-rating hooks were removed. Deleted with the rest of the v1 code.

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

/** Payout-blocked players with v1 judgments the nightly grant held back (it held from two days
 *  before the block). Clearing their block no longer pays those, so they stay held. */
export async function countHeldV1Players() {
  const blocked = await dbRead.newOrderPlayer.findMany({
    where: { payoutBlockedAt: { not: null } },
    select: { userId: true, payoutBlockedAt: true },
  });
  if (!blocked.length) return { blocked: 0, withHeldJudgments: 0 };
  const conditions = blocked
    .map(
      (p) =>
        `(userId = ${p.userId} AND createdAt >= parseDateTimeBestEffort('${dayjs(p.payoutBlockedAt!)
          .startOf('day')
          .subtract(2, 'day')
          .toISOString()}'))`
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

/** Settles every vote still Pending as Inconclusive, as the daily rating-slot purge did. Those pay
 *  nothing: only Correct and Failed judgments earn Buzz. */
export async function voidPendingV1Votes() {
  const ch = requireClickhouse();
  // A moderator rating still waiting in the batch would lose to the later NULL row and settle as
  // Inconclusive, so it has to be processed first.
  const flushed = await processFinalRatings();
  if (flushed.status !== 'processed' && flushed.status !== 'no-new-data')
    return { images: 0, processed: flushed, retry: true };

  const rows = await ch.$query<{ imageId: number }>`
    SELECT DISTINCT imageId FROM (${pendingVotes})
  `;
  const imageIds = rows.map((r) => Number(r.imageId));
  for (const batch of chunk(imageIds, 10000)) {
    await ch.insert({
      table: 'knights_rating_updates_buffer',
      values: batch.map((imageId) => ({ imageId, rating: null })),
      format: 'JSONEachRow',
    });
  }
  const processed = imageIds.length ? await processFinalRatings() : { status: 'nothing-pending' };
  return { images: imageIds.length, processed, retry: false };
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
