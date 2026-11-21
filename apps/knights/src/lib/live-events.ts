/** Signal names shared by the server that sends them and /play that listens. */
export const QUEUE_DROP_EVENT = 'knights-queue-drop';
export const PLAYER_STATS_EVENT = 'knights-player';

/** One topic per stage: an item that leaves a stage is announced on the topic of the stage it left. */
export const queueTopic = (stage: string) => `knights-queue:${stage}`;

/**
 * An item that left a stage. `k` is the item's opaque live key (never its id); `to` is the stage it is open at now, or null when
 * it is no longer served to players at all.
 */
export type QueueDrop = { k: string; to: string | null };
export type QueueDropSignal = { drops: QueueDrop[] };

/** Whether a drop takes the item away from a player who works `stages`: an item moved to a stage they also judge stays theirs. */
export const dropsForPlayer = (drop: QueueDrop, stages: readonly string[]) =>
  drop.to === null || !stages.includes(drop.to);

export function readQueueDrops(payload: unknown): QueueDrop[] {
  const drops = (payload as Partial<QueueDropSignal> | null)?.drops;
  if (!Array.isArray(drops)) return [];
  return drops.filter(
    (drop): drop is QueueDrop =>
      typeof drop?.k === 'string' && (drop.to === null || typeof drop.to === 'string')
  );
}

/**
 * Whether a stats signal may replace what /play shows. Never while a vote is in flight, never older than the page's data or the
 * last signal taken, and never one that counts fewer votes today than the page already shows (`votes`, landed ones included):
 * such a signal was built before a vote landed, and taking it would move the Watch back.
 */
export const acceptsStats = (
  signal: { at: number; daily: { votes: number } },
  shown: { at: number; votes: number; inFlight: number }
) => shown.inFlight === 0 && signal.at > shown.at && signal.daily.votes >= shown.votes;
