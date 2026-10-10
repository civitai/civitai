import { isEventPointsEnabled } from '~/server/events/points/enabled';
import {
  eventPointKeys,
  eventPointSeason,
  seasonTeamsTopicId,
  TEAMS_TOPIC_ID,
  type EventPointSeason,
} from '~/server/events/points/keys';
import { logToAxiom } from '~/server/logging/client';
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
// The member for the event's live team totals; the preview's is its keyed id (keys.ts).
export const TEAMS_WATCH = TEAMS_TOPIC_ID;
// What seasonHatTopicId produces in each season.
const HAT_TOPIC_ID: Record<EventPointSeason, RegExp> = {
  live: /^[0-9a-f]{16}$/,
  preview: /^[0-9a-f]{32}$/,
};

export type WatchRedis = Pick<
  typeof sysRedis,
  'zRemRangeByScore' | 'zCard' | 'zmScore' | 'zAdd' | 'pExpireAt'
>;

export type WatchEvent = {
  name: string;
  previewFrom?: Date;
  startDate: Date;
  endDate: Date;
  finalizeAfterMs: number;
};

export type MarkWatchDeps = {
  redis: WatchRedis;
  now: () => number;
  isEnabled: () => Promise<boolean>;
  // The scored event by name, or undefined when there is none.
  getEvent: (name: string) => Promise<WatchEvent | undefined>;
  isKnownHatTopic: (event: string, topicId: string, season: EventPointSeason) => Promise<boolean>;
  // Whether this caller may see the event's preview (event-access.ts). Asked only during it.
  canWatchPreview: (event: string) => Promise<boolean>;
  // Called when the cap refuses topics, with how many.
  logCapReached?: (event: string, refused: number) => void;
};

// Marks topics as on screen for the next WATCH_TTL_MS. Writes nothing with the engine switched off,
// outside the event's window, or when no topic is valid. In the preview only a caller the preview
// lets in gets past the window check, so for anyone else a real preview id and a guessed one both
// get 0 without being looked up. Returns how many topics were marked.
export async function markWatched(
  { event: name, topics }: { event: string; topics: string[] },
  deps: MarkWatchDeps
) {
  if (!(await deps.isEnabled().catch(() => false))) return 0;
  const event = await deps.getEvent(name);
  const now = deps.now();
  if (!event || now < (event.previewFrom ?? event.startDate).getTime()) return 0;
  const endsAt = event.endDate.getTime() + event.finalizeAfterMs;
  if (now > endsAt) return 0;
  const season = eventPointSeason(event.startDate, new Date(now));
  if (season === 'preview' && !(await deps.canWatchPreview(name).catch(() => false))) return 0;

  const teams = seasonTeamsTopicId(name, season);
  const candidates = [...new Set(topics)].slice(0, MAX_TOPICS_PER_MARK);
  const valid: string[] = [];
  for (const topic of candidates) {
    if (topic === teams) valid.push(topic);
    else if (HAT_TOPIC_ID[season].test(topic) && (await deps.isKnownHatTopic(name, topic, season)))
      valid.push(topic);
  }
  if (!valid.length) return 0;

  const key = eventPointKeys(name).watch;
  await deps.redis.zRemRangeByScore(key, '-inf', now);
  const [size, scores] = await Promise.all([deps.redis.zCard(key), deps.redis.zmScore(key, valid)]);
  // Topics already in the set always refresh; new ones only while there is room. The team totals are
  // one topic every viewer of the page shares, so they always have room: a set full of hats must not
  // turn them off for everyone. The size is read before the write, so concurrent calls can overshoot
  // the cap by up to MAX_TOPICS_PER_MARK each.
  let room = Math.max(0, MAX_WATCHED_PER_EVENT - Number(size));
  const marked = valid.filter((topic, i) => scores[i] != null || topic === teams || room-- > 0);
  if (marked.length < valid.length) deps.logCapReached?.(name, valid.length - marked.length);
  if (!marked.length) return 0;
  const lapse = now + WATCH_TTL_MS;
  await Promise.all([
    deps.redis.zAdd(
      key,
      marked.map((value) => ({ score: lapse, value }))
    ),
    // The set itself goes once the event's pushes are over.
    deps.redis.pExpireAt(key, endsAt + WATCH_TTL_MS),
  ]);
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
  deps: Pick<MarkWatchDeps, 'getEvent' | 'isKnownHatTopic' | 'canWatchPreview'>
): MarkWatchDeps => ({
  redis: sysRedis,
  now: Date.now,
  isEnabled: isEventPointsEnabled,
  logCapReached: (event, refused) =>
    void logToAxiom({
      type: 'warning',
      name: 'event-points-watch',
      event,
      message: 'interest set at its cap, topics refused',
      refused,
    }).catch(() => undefined),
  ...deps,
});
