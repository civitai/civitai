import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { PLAYER_STATS_EVENT, QUEUE_DROP_EVENT, queueTopic, type QueueDrop } from '$lib/live-events';
import { getDailyStatus } from '../daily/daily.service';
import { getPlayerStatus, type PlayerStatus } from '../player-status';
import { goldForRank } from '../progression/config';
import { isRank } from '../ranks';
import { feedSecret } from '../smites/runtime';
import { liveKey } from './live-key';
import { sendToUser, sendTopic, signalsEnabled } from './signals';

export type ItemStage = { id: number; status: string; minRank: string };

/** A settled item can have had many voters; past this many, the rest see their stats on their next page read. */
const MAX_STATS_RECIPIENTS = 25;
const STATS_CONCURRENCY = 3;

export async function itemStages(db: Kysely<DB>, ids: number[]): Promise<ItemStage[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom('KnightsQueueItem')
    .select(['id', 'status', 'minRank'])
    .where('id', 'in', ids)
    .execute();
}

/** Today's Watch and gold as /play shows them; `goldPerVote` lets the page move gold the moment a vote is cast. */
export async function playDaily(db: Kysely<DB>, userId: number, status: PlayerStatus, now: Date) {
  const daily = await getDailyStatus(db, {
    playerId: userId,
    rank: status.rank,
    level: status.level,
    now,
  });
  return {
    ...daily,
    goldPerVote: isRank(status.rank) ? goldForRank(status.rank, status.rating.belowBar) : 0,
  };
}

export type PlayerStatsSignal = {
  at: number;
  status: PlayerStatus;
  daily: Awaited<ReturnType<typeof playDaily>>;
};

async function sendStats(db: Kysely<DB>, userId: number) {
  const now = new Date();
  const status = await getPlayerStatus(db, userId, now);
  if (!status) return;
  const signal: PlayerStatsSignal = {
    at: now.getTime(),
    status,
    daily: await playDaily(db, userId, status, now),
  };
  await sendToUser(userId, PLAYER_STATS_EVENT, signal);
}

/**
 * Tells every player about the items in `before` that have since left the stage they were open at: they drop out of the
 * buffers holding them. The voters of an item that is now final get their stats, since settling it paid or dropped their gold
 * and XP. Never throws: a player who misses a signal is refused the vote (and told so).
 */
export async function announceMoves(db: Kysely<DB>, before: ItemStage[]) {
  try {
    const open = before.filter((item) => item.status === 'Open');
    if (open.length === 0 || !(await signalsEnabled())) return;
    const after = new Map(
      (
        await itemStages(
          db,
          open.map((item) => item.id)
        )
      ).map((i) => [i.id, i])
    );
    const secret = feedSecret();
    const byStage = new Map<string, QueueDrop[]>();
    const final: number[] = [];
    for (const item of open) {
      const now = after.get(item.id);
      const stillOpen = now?.status === 'Open';
      if (stillOpen && now.minRank === item.minRank) continue;
      if (!stillOpen) final.push(item.id);
      const drops = byStage.get(item.minRank) ?? [];
      drops.push({ k: liveKey(secret, item.id), to: stillOpen ? now.minRank : null });
      byStage.set(item.minRank, drops);
    }
    await Promise.all(
      [...byStage].map(([stage, drops]) =>
        sendTopic(queueTopic(stage), QUEUE_DROP_EVENT, { drops })
      )
    );
    if (final.length === 0) return;
    const voters = await db
      .selectFrom('KnightsVote')
      .select('playerId')
      .distinct()
      .where('itemId', 'in', final)
      .limit(MAX_STATS_RECIPIENTS)
      .execute();
    // A few at a time: each is several reads on the pool the votes use.
    for (let at = 0; at < voters.length; at += STATS_CONCURRENCY) {
      await Promise.all(
        voters.slice(at, at + STATS_CONCURRENCY).map(({ playerId }) => sendStats(db, playerId))
      );
    }
  } catch (error) {
    console.error('knights: could not announce moved items', { error });
  }
}
