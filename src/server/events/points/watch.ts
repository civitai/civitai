import { isEventPointsEnabled } from '~/server/events/points/enabled';
import { eventPointKeys } from '~/server/events/points/keys';
import { sysRedis } from '~/server/redis/client';

// The interest set: which live topics someone has on screen. A client marks a topic while it is in
// view and refreshes the mark every WATCH_REFRESH_MS; a mark it stops refreshing lapses after
// WATCH_TTL_MS, and the pusher sends nothing to a topic without a live mark.
//
// One sorted set per event, member = topic, score = when its mark lapses (ms). The pusher asks about
// every topic in a flush with one ZMSCORE, marks carry their own expiry without a key per topic, and
// lapsed marks are trimmed by score.
export const WATCH_TTL_MS = 90_000;
export const WATCH_REFRESH_MS = 30_000;
// Most topics one event's set holds. At the cap, new topics are refused and marked ones still refresh.
export const MAX_WATCHED_PER_EVENT = 20_000;
// Most topics one mark call may name.
export const MAX_TOPICS_PER_MARK = 50;
// The member for the event's team totals.
export const TEAMS_WATCH = 'teams';
// What hatTopicId produces.
const HAT_TOPIC_ID = /^[0-9a-f]{16}$/;

export type WatchRedis = Pick<
  typeof sysRedis,
  'zRemRangeByScore' | 'zCard' | 'zmScore' | 'zAdd' | 'pExpireAt'
>;

export type WatchEvent = { name: string; startDate: Date; endDate: Date; finalizeAfterMs: number };

export type MarkWatchDeps = {
  redis: WatchRedis;
  now: () => number;
  isEnabled: () => Promise<boolean>;
  // The scored event by name, or undefined when there is none.
  getEvent: (name: string) => Promise<WatchEvent | undefined>;
  isKnownHatTopic: (event: string, topicId: string) => Promise<boolean>;
};

// Marks topics as on screen for the next WATCH_TTL_MS. Writes nothing with the engine switched off,
// outside the event's live window (pushes are never sent for the preview), or when no topic is valid.
// Returns how many topics were marked.
export async function markWatched(
  { event: name, topics }: { event: string; topics: string[] },
  deps: MarkWatchDeps
) {
  if (!(await deps.isEnabled().catch(() => false))) return 0;
  const event = await deps.getEvent(name);
  const now = deps.now();
  if (!event || now < event.startDate.getTime()) return 0;
  const endsAt = event.endDate.getTime() + event.finalizeAfterMs;
  if (now > endsAt) return 0;

  const candidates = [...new Set(topics)].slice(0, MAX_TOPICS_PER_MARK);
  const valid: string[] = [];
  for (const topic of candidates) {
    if (topic === TEAMS_WATCH) valid.push(topic);
    else if (HAT_TOPIC_ID.test(topic) && (await deps.isKnownHatTopic(name, topic)))
      valid.push(topic);
  }
  if (!valid.length) return 0;

  const key = eventPointKeys(name).watch;
  await deps.redis.zRemRangeByScore(key, '-inf', now);
  const [size, scores] = await Promise.all([deps.redis.zCard(key), deps.redis.zmScore(key, valid)]);
  // Topics already in the set always refresh; new ones only while there is room.
  let room = Math.max(0, MAX_WATCHED_PER_EVENT - Number(size));
  const marked = valid.filter((_, i) => scores[i] != null || room-- > 0);
  if (!marked.length) return 0;
  const lapse = now + WATCH_TTL_MS;
  await deps.redis.zAdd(
    key,
    marked.map((value) => ({ score: lapse, value }))
  );
  // The set itself goes once the event's pushes are over.
  await deps.redis.pExpireAt(key, endsAt + WATCH_TTL_MS);
  return marked.length;
}

// Which of `topics` have a live mark: one read, for one flush of one event.
export async function readWatched(
  event: string,
  topics: string[],
  now: number,
  redis: Pick<typeof sysRedis, 'zmScore'> = sysRedis
) {
  if (!topics.length) return new Set<string>();
  const scores = await redis.zmScore(eventPointKeys(event).watch, topics);
  return new Set(topics.filter((_, i) => scores[i] != null && Number(scores[i]) > now));
}

export const defaultMarkWatchDeps = (
  deps: Pick<MarkWatchDeps, 'getEvent' | 'isKnownHatTopic'>
): MarkWatchDeps => ({
  redis: sysRedis,
  now: Date.now,
  isEnabled: isEventPointsEnabled,
  ...deps,
});
