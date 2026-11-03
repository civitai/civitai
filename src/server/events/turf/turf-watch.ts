import { chunk } from 'lodash-es';
import { SignalMessages } from '~/server/common/enums';
import { isEventPointsEnabled } from '~/server/events/points/enabled';
import { eventTurfTopic, turfKeys, type TurfCounts } from '~/server/events/turf/turf-map';
import type { FeedSticker } from '~/server/events/turf/turf.service';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';
import { signalClient } from '~/utils/signal-client';

// Live turf counts on feed cards and image pages: a client marks the images it has on screen, and
// a change to an image's counts is pushed to its topic only while it is marked. Counts move only on a
// placement or a removal, never on a view, so pushes follow placement volume.
//
// Its own interest set, apart from the points one (events/points/watch.ts), so a full page of turf
// images can never crowd out hat and team totals.
export const TURF_WATCH_TTL_MS = 90_000;
export const MAX_TURF_WATCHED = 20_000;
export const MAX_TURF_IMAGES_PER_MARK = 50;
const PUSH_CONCURRENCY = 20;

export type TurfWatchRedis = Pick<
  typeof sysRedis,
  'zRemRangeByScore' | 'zCard' | 'zmScore' | 'zAdd' | 'pExpireAt'
>;

/**
 * Marks images as on screen for the next TURF_WATCH_TTL_MS. Any image id may be marked, so a card
 * hears the first sticker on an image that has none yet; the cap bounds the set. Returns how many.
 */
export async function markTurfWatched(
  event: { name: string; endsAt: Date },
  imageIds: number[],
  { redis = sysRedis as TurfWatchRedis, now = Date.now() } = {}
) {
  if (!(await isEventPointsEnabled().catch(() => false))) return 0;
  if (now > event.endsAt.getTime()) return 0;
  const ids = [...new Set(imageIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, MAX_TURF_IMAGES_PER_MARK)
    .map(String);
  if (!ids.length) return 0;
  const key = turfKeys(event.name).watch;
  await redis.zRemRangeByScore(key, '-inf', now);
  const [size, scores] = await Promise.all([redis.zCard(key), redis.zmScore(key, ids)]);
  // Marked images always refresh; new ones only while there is room.
  let room = Math.max(0, MAX_TURF_WATCHED - Number(size));
  const marked = ids.filter((_, i) => scores[i] != null || room-- > 0);
  if (marked.length < ids.length)
    void logToAxiom({
      type: 'warning',
      name: 'event-turf-watch',
      event: event.name,
      message: 'turf interest set at its cap, images refused',
      refused: ids.length - marked.length,
    }).catch(() => undefined);
  if (!marked.length) return 0;
  const lapse = now + TURF_WATCH_TTL_MS;
  await Promise.all([
    redis.zAdd(
      key,
      marked.map((value) => ({ score: lapse, value }))
    ),
    redis.pExpireAt(key, event.endsAt.getTime() + TURF_WATCH_TTL_MS),
  ]);
  return marked.length;
}

export type TurfPush = {
  imageId: number;
  counts: TurfCounts | null;
  // What a feed card draws, so a watcher need not read it back; ids as strings (bigint is not JSON).
  // null: this push does not say, so watchers keep what they draw (never [], which draws no hats).
  stickers: FeedSticker[] | null;
};

/**
 * Sends the changed counts of the images someone is watching. `counts: null` means the image has no
 * live sticker left. Never throws: a dropped push is caught up by the next change or the next read.
 */
export async function pushTurfCounts(
  event: string,
  changes: TurfPush[],
  {
    redis = sysRedis as Pick<typeof sysRedis, 'zmScore'>,
    send = (args: Parameters<typeof signalClient.topicSend>[0]) => signalClient.topicSend(args),
    now = Date.now(),
  } = {}
) {
  try {
    if (!changes.length) return 0;
    const scores = await redis.zmScore(
      turfKeys(event).watch,
      changes.map((c) => String(c.imageId))
    );
    const watched = changes.filter((_, i) => scores[i] != null && Number(scores[i]) > now);
    let failed = 0;
    // A reconcile can change thousands of watched images at once: a few sends at a time.
    for (const part of chunk(watched, PUSH_CONCURRENCY)) {
      const results = await Promise.allSettled(
        part.map(({ imageId, counts, stickers }) =>
          send({
            topic: eventTurfTopic(event, imageId),
            target: SignalMessages.EventPointsTurf,
            data: { event, imageId, counts, stickers },
          })
        )
      );
      failed += results.filter((r) => r.status === 'rejected').length;
    }
    if (failed)
      void logToAxiom({ type: 'warning', name: 'event-turf-watch', event, failed }).catch(
        () => undefined
      );
    return watched.length - failed;
  } catch (error) {
    void logToAxiom({ type: 'error', name: 'event-turf-watch', fn: 'push', event, error }).catch(
      () => undefined
    );
    return 0;
  }
}
