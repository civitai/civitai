import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { applyBlockPostPublishEffects } from '~/server/services/blocks/block-post.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

/**
 * `applyBlockPostPublishEffects` is the hand re-issue of everything a NATIVE post
 * publish fires that this path does not — the controller's side effects AND the
 * two `Post` database triggers, both of which are declared `AFTER UPDATE OF
 * "publishedAt"` while `writeBlockPost` writes `publishedAt` inside an INSERT.
 *
 * 🔴 WHY THIS FILE EXISTS AS A SEPARATE SUITE. Every other test of this function
 * mocked it WHOLESALE (`blocks.router.createPostFromApp.test.ts` replaces it with
 * a `vi.fn()` and asserts only that a rejection does not fail the post), so the
 * SET of effects it issues was unverified prose in a docblock. An omission from
 * that set is invisible to a mock — which is exactly how the missing nsfw-level
 * enqueue shipped, and why the first describe below drives the SYMPTOM rather
 * than asserting that a function was called.
 */

const effect = vi.hoisted(() => ({
  ledger: [] as string[],
  enqueueJobs: vi.fn(),
  preventReplicationLag: vi.fn(),
  userPostCountRefresh: vi.fn(),
  userImageVideoCountRefresh: vi.fn(),
  bustCacheTag: vi.fn(),
  bustCachesForPosts: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
  firstDailyPostRewardApply: vi.fn(),
  imagePostedToModelRewardApply: vi.fn(),
  processEngagement: vi.fn(),
}));

/** Record the call in the ordered ledger, then behave like a resolved promise. */
function tap(name: string, fn: { mock: unknown }) {
  return (...args: unknown[]) => {
    effect.ledger.push(name);
    return (fn as unknown as (...a: unknown[]) => unknown)(...args);
  };
}

vi.mock('~/server/services/job-queue.service', () => ({
  enqueueJobs: (...a: unknown[]) => tap('enqueueJobs', effect.enqueueJobs)(...a),
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: (...a: unknown[]) =>
    tap('preventReplicationLag', effect.preventReplicationLag)(...a),
}));
vi.mock('~/server/redis/caches', () => ({
  userPostCountCache: {
    refresh: (...a: unknown[]) =>
      tap('userPostCountCache.refresh', effect.userPostCountRefresh)(...a),
  },
  userImageVideoCountCaches: {
    refresh: (...a: unknown[]) =>
      tap('userImageVideoCountCaches.refresh', effect.userImageVideoCountRefresh)(...a),
  },
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  bustCacheTag: (...a: unknown[]) => tap('bustCacheTag', effect.bustCacheTag)(...a),
}));
vi.mock('~/server/services/post.service', () => ({
  bustCachesForPosts: (...a: unknown[]) =>
    tap('bustCachesForPosts', effect.bustCachesForPosts)(...a),
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: (...a: unknown[]) =>
    tap('queueImageSearchIndexUpdate', effect.queueImageSearchIndexUpdate)(...a),
}));
vi.mock('~/server/rewards', () => ({
  firstDailyPostReward: {
    apply: (...a: unknown[]) =>
      tap('firstDailyPostReward.apply', effect.firstDailyPostRewardApply)(...a),
  },
  imagePostedToModelReward: {
    apply: (...a: unknown[]) =>
      tap('imagePostedToModelReward.apply', effect.imagePostedToModelRewardApply)(...a),
  },
}));
vi.mock('~/server/events', () => ({
  eventEngine: {
    processEngagement: (...a: unknown[]) =>
      tap('eventEngine.processEngagement', effect.processEngagement)(...a),
  },
}));

const POST_ID = 60601;
const USER_ID = 4242;
const MODEL_ID = 777;
const MODEL_VERSION_ID = 888;
const IMAGE_A = 5001;
const IMAGE_B = 5002;
const IP = '203.0.113.7';

/**
 * Fixture browsing-level bits. Chosen DISTINCT from every id above and from each
 * other, and deliberately NOT a value the assertion's own constant could equal by
 * coincidence: `NSFW_BIT_A | NSFW_BIT_B` is 12, which is neither operand, so a
 * mutant that returned either input instead of the `bit_or` cannot survive.
 */
const NSFW_BIT_A = 4;
const NSFW_BIT_B = 8;

beforeEach(() => {
  vi.clearAllMocks();
  effect.ledger.length = 0;
  // The shared db mock is module-global and is NOT auto-reset between tests in
  // this project; without this a later test reads an earlier one's calls.
  dbMock.dbWrite.$executeRaw.mockClear?.();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

function run(over: Partial<Parameters<typeof applyBlockPostPublishEffects>[0]> = {}) {
  return applyBlockPostPublishEffects({
    postId: POST_ID,
    userId: USER_ID,
    imageIds: [IMAGE_A, IMAGE_B],
    modelVersionId: MODEL_VERSION_ID,
    modelId: MODEL_ID,
    ip: IP,
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SYMPTOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A faithful model of the CONSUMER, derived from production SQL and NOT from the
 * code under test:
 *
 *  - `updatePostNsfwLevels` (`nsfwLevels.service.ts`) is the ONLY writer of
 *    `Post.nsfwLevel`. Its statement is
 *    `SELECT bit_or(i."nsfwLevel") FROM "Post" p JOIN "Image" i ON i."postId" = p.id`
 *    … `UPDATE "Post" SET "nsfwLevel" = level."nsfwLevel"`.
 *  - It is reached ONLY from the `update-nsfw-levels` cron
 *    (`src/server/jobs/job-queue.ts`), which selects `JobQueue` rows of type
 *    `UpdateNsfwLevel` and feeds their `entityId`s in as `postIds`.
 *
 * So: a post with NO queued row is never visited, and keeps whatever level it
 * has. That is the whole mechanism this test exercises.
 */
function runUpdateNsfwLevelCron(
  queuedRows: Array<{ entityId: number; entityType: EntityType; type: JobQueueType }>,
  world: {
    post: { id: number; nsfwLevel: number };
    images: Array<{ postId: number; nsfwLevel: number }>;
  }
) {
  const postIds = queuedRows
    .filter((r) => r.entityType === EntityType.Post && r.type === JobQueueType.UpdateNsfwLevel)
    .map((r) => r.entityId);
  if (!postIds.includes(world.post.id)) return;
  const joined = world.images.filter((i) => i.postId === world.post.id);
  if (joined.length === 0) return;
  world.post.nsfwLevel = joined.reduce((acc, i) => acc | i.nsfwLevel, 0);
}

/**
 * The two non-owner read predicates, transcribed from production:
 *  - `getPostDetail` (`post.service.ts`) admits a non-owner, non-moderator on
 *    `{ publishedAt: { lt: new Date() }, nsfwLevel: { not: 0 } }`.
 *  - `getPostsInfinite` masks with `(p."nsfwLevel" & browsingLevel) != 0`.
 */
function nonOwnerCanOpenPost(post: { publishedAt: Date; nsfwLevel: number }) {
  return post.publishedAt < new Date() && post.nsfwLevel !== 0;
}
function appearsInFeed(post: { nsfwLevel: number }, browsingLevel: number) {
  return (post.nsfwLevel & browsingLevel) !== 0;
}

describe('an all-`published` post ends up VISIBLE to a non-owner', () => {
  /**
   * 🔴 THE SYMPTOM, NOT THE CALL. Asserting "we called `enqueueJobs`" would pass
   * against a wrong enqueue (wrong entity type, wrong job type, wrong id) and
   * says nothing about whether the post is readable. This drives the real chain
   * instead: effects → whatever landed in `JobQueue` → the cron's `bit_or` →
   * the two read predicates.
   *
   * The arm driven is ALL-`published`, which is the broken one: it is the only
   * arm with no accidental rescue. A post containing a `fresh` output recovers
   * because that output's later scan fires the IMAGE trigger, whose job `bit_or`s
   * over every image of the post; an all-`published` post's images were already
   * terminally `Scanned` before adoption, so no image level ever changes again.
   */
  it('computes a real nsfwLevel from the adopted images, so it is not a permanent 404', async () => {
    const world = {
      post: { id: POST_ID, publishedAt: new Date(Date.now() - 60_000), nsfwLevel: 0 },
      images: [
        { postId: POST_ID, nsfwLevel: NSFW_BIT_A },
        { postId: POST_ID, nsfwLevel: NSFW_BIT_B },
      ],
    };

    // Pre-state: the post as `writeBlockPost` leaves it — published, level 0.
    expect(world.post.nsfwLevel).toBe(0);
    expect(nonOwnerCanOpenPost(world.post)).toBe(false);

    await run();

    const queued = effect.enqueueJobs.mock.calls.flatMap(
      (call) => call[0] as Array<{ entityId: number; entityType: EntityType; type: JobQueueType }>
    );
    runUpdateNsfwLevelCron(queued, world);

    // The post now carries the bit_or of its images — 4 | 8 === 12, a value
    // equal to NEITHER operand, so returning one input instead of the or dies.
    expect(world.post.nsfwLevel).toBe(NSFW_BIT_A | NSFW_BIT_B);
    expect(world.post.nsfwLevel).not.toBe(0);
    // …which is what makes it readable at all. Both consequences, named.
    expect(nonOwnerCanOpenPost(world.post)).toBe(true);
    expect(appearsInFeed(world.post, NSFW_BIT_A)).toBe(true);
  });

  it('seeds the `PostMetric(AllTime)` row with an ageGroup, which the trigger would have', async () => {
    // Same root cause, smaller blast radius: `publish_post_metrics_trigger` is
    // also `AFTER UPDATE OF "publishedAt"`. The counts recover via the metrics
    // job's upsert; `ageGroup` is written ONLY here, and a NULL one drops the
    // post out of every age-bucketed metric read.
    await run();

    // 🔴 PIN THE WHOLE NORMALISED STATEMENT, NOT KEYWORDS IN IT. A
    // `toContain("'Day'::\"MetricTimeframe\"")` check SURVIVES a mutant that
    // replaces the VALUES-clause ageGroup with NULL, because the identical
    // literal also appears in the `ON CONFLICT … DO UPDATE` clause — measured,
    // that exact mutant passed a keyword-based version of this test. Comparing
    // the full string makes both occurrences load-bearing. `?` marks each
    // interpolated parameter; the post id is asserted separately below.
    const statements = dbMock.dbWrite.$executeRaw.mock.calls.map((call) =>
      (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim()
    );
    expect(statements).toEqual([
      'INSERT INTO "PostMetric" ("postId", "timeframe", "createdAt", "updatedAt", "likeCount", ' +
        '"dislikeCount", "laughCount", "cryCount", "heartCount", "commentCount", "collectedCount", ' +
        '"ageGroup") VALUES (?, \'AllTime\'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ' +
        '\'Day\'::"MetricTimeframe") ON CONFLICT ("postId", "timeframe") DO UPDATE SET "ageGroup" = ' +
        '\'Day\'::"MetricTimeframe"',
    ]);
    // The post id is the interpolated parameter.
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledWith(expect.anything(), POST_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE LEDGER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 AN ASSERTED LEDGER OF THE EXACT EFFECT SET — IT MUST FAIL WHEN THE SET GROWS
 * *OR* SHRINKS. A "was it called" test only catches a shrink, and it was the
 * absence of a grow-side ledger that let the two trigger re-issues stay missing:
 * nothing anywhere stated what the complete set was, so nothing could notice one
 * was not in it. `toEqual` on the whole ordered array is what pins both
 * directions; adding an effect without updating this list is a failing test, by
 * design, because the docblock enumeration has to be re-read when it changes.
 */
describe('the effect ledger', () => {
  const WITH_GALLERY = [
    'enqueueJobs',
    'preventReplicationLag',
    'preventReplicationLag',
    'userPostCountCache.refresh',
    'userImageVideoCountCaches.refresh',
    'bustCacheTag',
    'bustCachesForPosts',
    'queueImageSearchIndexUpdate',
    'firstDailyPostReward.apply',
    'imagePostedToModelReward.apply',
    'eventEngine.processEngagement',
  ];

  it('issues EXACTLY this set, in this order, for a gallery-attached post', async () => {
    await run();
    expect(effect.ledger).toEqual(WITH_GALLERY);
  });

  it('omits ONLY the model reward when there is no gallery target', async () => {
    await run({ modelVersionId: null, modelId: null });
    expect(effect.ledger).toEqual(
      WITH_GALLERY.filter((e) => e !== 'imagePostedToModelReward.apply')
    );
    expect(effect.imagePostedToModelRewardApply).not.toHaveBeenCalled();
  });

  it('omits ONLY the search-index queue when the post has no images', async () => {
    await run({ imageIds: [] });
    expect(effect.ledger).toEqual(WITH_GALLERY.filter((e) => e !== 'queueImageSearchIndexUpdate'));
  });

  it('queues the post for nsfw-level recompute with the exact entity and job type', async () => {
    // The enqueue's ARGUMENTS, separately from the symptom test above: the
    // symptom test would still pass if the entity type were wrong in a way the
    // consumer model tolerated, so the shape is pinned here too.
    await run();
    expect(effect.enqueueJobs).toHaveBeenCalledWith([
      { entityId: POST_ID, entityType: EntityType.Post, type: JobQueueType.UpdateNsfwLevel },
    ]);
  });

  it('passes the reward arguments the native call sites pass', async () => {
    await run();
    expect(effect.firstDailyPostRewardApply).toHaveBeenCalledWith(
      { postId: POST_ID, posterId: USER_ID },
      { ip: IP }
    );
    expect(effect.imagePostedToModelRewardApply).toHaveBeenCalledWith(
      { modelId: MODEL_ID, modelVersionId: MODEL_VERSION_ID, posterId: USER_ID },
      { ip: IP }
    );
  });

  it('passes `undefined` — not null — for an unknown modelId on a gallery attach', async () => {
    // `imagePostedToModelReward` takes an optional modelId; a null would be a
    // different value than the native call site produces.
    await run({ modelId: null });
    expect(effect.imagePostedToModelRewardApply).toHaveBeenCalledWith(
      { modelId: undefined, modelVersionId: MODEL_VERSION_ID, posterId: USER_ID },
      { ip: IP }
    );
  });
});
