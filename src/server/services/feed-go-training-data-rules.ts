import { redis, REDIS_KEYS } from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import { trainingDataListingRulesId } from '~/server/services/training-data-restricted.service';

/**
 * Tells feed-go which Training Data listing rules the Node builds answering the public model API
 * (`GET /api/v1/models`, `GET /api/v1/models/[id]`) list by, so a body it serves never lists a
 * dataset by rules other than those (apps/feed-go/DESIGN.md §16.8).
 *
 * Every process that answers one of those routes writes its rule set id
 * (`trainingDataListingRulesId`) as a field of one hash, each field expiring
 * FEED_GO_TRAINING_DATA_RULES_TTL_MS after the process last wrote it. feed-go lists Training Data
 * files only while the hash's live fields are exactly its own id: a build with other rules (a
 * rollout, a canary) still answering, or none having said, makes it hand the request to Node.
 *
 * Fire and forget: never awaited, never throws. A process writes at most once per
 * FEED_GO_TRAINING_DATA_RULES_EVERY_MS, so a route pays one Redis write a minute, not one per call.
 */

/** How long a build's field lives after its last write: well past the write interval. */
export const FEED_GO_TRAINING_DATA_RULES_TTL_MS = 5 * 60_000;

/** The least time between two writes from one process. */
export const FEED_GO_TRAINING_DATA_RULES_EVERY_MS = 60_000;

export type TrainingDataRulesPublisherDeps = {
  /** Sets `field` of the hash and its TTL (production: hSetWithTTL on the cache client). */
  write: (field: string, ttlMs: number) => Promise<unknown>;
  rulesId: () => string;
  now: () => number;
};

/** A throttled publisher. The module exports one wired to the cache client. */
export function createTrainingDataRulesPublisher(deps: TrainingDataRulesPublisherDeps) {
  let nextAt = 0;
  return function publish(): void {
    try {
      const now = deps.now();
      if (now < nextAt) return;
      nextAt = now + FEED_GO_TRAINING_DATA_RULES_EVERY_MS;
      deps.write(deps.rulesId(), FEED_GO_TRAINING_DATA_RULES_TTL_MS).catch(() => {
        // Not written: feed-go hands the requests that need it to Node until a later write lands.
      });
    } catch {
      /* never throw from the handler */
    }
  };
}

/** Call on every request the public model routes answer. */
export const publishTrainingDataRulesLive = createTrainingDataRulesPublisher({
  write: (field, ttlMs) =>
    hSetWithTTL(redis, REDIS_KEYS.FEED_GO.TRAINING_DATA_RULES_LIVE, field, '1', ttlMs),
  // Read on each write, not at import, so a module that replaces the listing service loads this.
  rulesId: () => trainingDataListingRulesId(),
  now: Date.now,
});
