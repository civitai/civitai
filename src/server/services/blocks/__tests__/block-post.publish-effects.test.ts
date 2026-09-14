import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  applyBlockPostPublishEffects,
  writeBlockPost,
} from '~/server/services/blocks/block-post.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

/**
 * The publish-time side effects of an app-created post, across BOTH the places
 * they live: the `JobQueue(Post, UpdateNsfwLevel)` row issued INSIDE
 * `writeBlockPost`'s transaction, and `applyBlockPostPublishEffects` — the
 * best-effort, post-commit re-issue of everything a NATIVE post publish fires that
 * this path does not.
 *
 * 🔴 WHY THIS FILE EXISTS AS A SEPARATE SUITE. Every other test of the effects
 * function mocked it WHOLESALE (`blocks.router.createPostFromApp.test.ts` replaces
 * it with a `vi.fn()` and asserts only that a rejection does not fail the post), so
 * the SET of effects it issues was unverified prose in a docblock. An omission from
 * that set is invisible to a mock — which is exactly how the missing nsfw-level
 * enqueue shipped, and why the first describe below drives the SYMPTOM rather than
 * asserting that a function was called.
 *
 * 🔴 AND WHY THAT DESCRIBE NOW DRIVES `writeBlockPost`. The router calls the
 * effects function as `applyBlockPostPublishEffects({…}).catch(log)`, AFTER the
 * post has committed — so an enqueue issued from there is separable from the
 * publish, and one transient statement failure produces a committed, permanently
 * invisible post. A test that asserted only "enqueueJobs was called" cannot see
 * that: the call happens in both designs. The cases below distinguish them by
 * driving the symptom with the post-commit path REMOVED, and then with it FAILING.
 */

const effect = vi.hoisted(() => ({
  ledger: [] as string[],
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

const ACTOR = {
  userId: USER_ID,
  appId: 'appblk-alpha',
  appBlockId: 'apb_alpha',
  browsingLevel: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  effect.ledger.length = 0;
  // The shared db mock is module-global and is NOT auto-reset between tests in
  // this project; without this a later test reads an earlier one's calls.
  dbMock.dbWrite.$executeRaw.mockClear?.();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbWrite.post.create.mockClear?.();
  dbMock.dbWrite.post.create.mockResolvedValue({ id: POST_ID });
  dbMock.dbWrite.image.updateMany.mockClear?.();
  dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 1 });
  // 🔴 `vi.clearAllMocks()` clears CALLS but keeps IMPLEMENTATIONS, so a
  // `mockRejectedValue` armed by one case survives into every later one and makes
  // them fail for a reason that has nothing to do with what they assert. Re-arm
  // every mock this file ever rejects, here, rather than relying on each case to
  // undo itself.
  effect.preventReplicationLag.mockResolvedValue(undefined);
});

function publishPost() {
  return writeBlockPost({
    actor: ACTOR,
    materialisedImageIds: [IMAGE_A, IMAGE_B],
    title: null,
    detail: null,
    tagIds: [],
    tagNames: [],
    gallery: null,
  });
}

/**
 * Read the `JobQueue` rows a run actually issued, by parsing the raw statements
 * rather than by trusting a helper's arguments.
 *
 * The shape is transcribed from `create_job_queue_record`
 * (`nsfw_level_update_triggers.sql`) — `INSERT INTO "JobQueue" ("entityId",
 * "entityType", "type") VALUES (…) ON CONFLICT DO NOTHING` — so this reads what
 * Postgres would have stored, from whichever client issued it. That is the point:
 * it cannot tell the difference between "issued inside the transaction" and
 * "issued after it", which is why the ARRANGEMENT of each case below, not this
 * helper, is what discriminates the two designs.
 */
function queuedJobsFrom(calls: unknown[][]) {
  return calls
    .filter((call) => (call[0] as string[]).join('?').includes('INSERT INTO "JobQueue"'))
    .map((call) => ({
      entityId: call[1] as number,
      entityType: call[2] as EntityType,
      type: call[3] as JobQueueType,
    }));
}

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

function freshWorld() {
  return {
    post: { id: POST_ID, publishedAt: new Date(Date.now() - 60_000), nsfwLevel: 0 },
    images: [
      { postId: POST_ID, nsfwLevel: NSFW_BIT_A },
      { postId: POST_ID, nsfwLevel: NSFW_BIT_B },
    ],
  };
}

describe('an all-`published` post ends up VISIBLE to a non-owner', () => {
  /**
   * 🔴 THE SYMPTOM, NOT THE CALL. Asserting "we called `enqueueJobs`" would pass
   * against a wrong enqueue (wrong entity type, wrong job type, wrong id), says
   * nothing about whether the post is readable, and — the reason this describe was
   * rewritten — passes IDENTICALLY whether the enqueue is atomic with the publish
   * or issued afterwards from a function whose failures are swallowed. This drives
   * the real chain instead: publish → whatever landed in `JobQueue` → the cron's
   * `bit_or` → the two read predicates.
   *
   * The arm driven is ALL-`published`, which is the broken one: it is the only arm
   * with no accidental rescue. A post containing a `fresh` output recovers because
   * that output's later scan fires the IMAGE trigger, whose job `bit_or`s over
   * every image of the post; an all-`published` post's images were already
   * terminally `Scanned` before adoption, so no image level ever changes again.
   */
  it('computes a real nsfwLevel from the adopted images, so it is not a permanent 404', async () => {
    const world = freshWorld();

    // Pre-state: the post as the INSERT leaves it — published, level 0.
    expect(world.post.nsfwLevel).toBe(0);
    expect(nonOwnerCanOpenPost(world.post)).toBe(false);

    // 🔴 THE PUBLISH ALONE. `applyBlockPostPublishEffects` is NEVER CALLED in this
    // case — that is the discriminator. An enqueue issued from the post-commit
    // effects path leaves NOTHING in `JobQueue` here, so the post stays at level 0
    // and the two predicates below stay false; only an enqueue that is part of the
    // publishing transaction survives this arrangement.
    await publishPost();

    runUpdateNsfwLevelCron(queuedJobsFrom(dbMock.dbWrite.$executeRaw.mock.calls), world);

    // The post now carries the bit_or of its images — 4 | 8 === 12, a value
    // equal to NEITHER operand, so returning one input instead of the or dies.
    expect(world.post.nsfwLevel).toBe(NSFW_BIT_A | NSFW_BIT_B);
    expect(world.post.nsfwLevel).not.toBe(0);
    // …which is what makes it readable at all. Both consequences, named.
    expect(nonOwnerCanOpenPost(world.post)).toBe(true);
    expect(appearsInFeed(world.post, NSFW_BIT_A)).toBe(true);
  });

  it('…and still does when EVERY post-commit statement fails and the router swallows it', async () => {
    // 🔴 THE ORIGINAL 🔴 SYMPTOM, REACHED FROM A TRANSIENT BLIP. The router calls
    // the effects function as `applyBlockPostPublishEffects({…}).catch(log)`, so a
    // connection reset, pool exhaustion or statement timeout on ONE post-commit
    // statement is swallowed with no rethrow and no retry. If the nsfw-level
    // enqueue lives there, that blip yields a committed, permanently-404 post —
    // exactly the defect this arc exists to close — and nothing reconciles it
    // (`temp-set-missing-nsfw-level.ts` covers ModelVersion/Model only).
    const world = freshWorld();
    await publishPost();

    // Everything the publish issued is already durable; capture it BEFORE arming
    // the failure, so what follows cannot contribute.
    const queued = queuedJobsFrom(dbMock.dbWrite.$executeRaw.mock.calls);

    // Now break the post-commit path completely — at the DB client, so it takes
    // out any statement the effects function issues, not one named helper.
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('connection reset by peer'));
    effect.preventReplicationLag.mockRejectedValue(new Error('connection reset by peer'));
    let swallowed: unknown = null;
    await run().catch((error) => {
      swallowed = error;
    });
    // POSITIVE CONTROL on the arrangement: the effects path really did blow up. A
    // version of this test where it quietly succeeded would prove nothing.
    expect(swallowed).toBeInstanceOf(Error);

    runUpdateNsfwLevelCron(queued, world);
    expect(world.post.nsfwLevel).toBe(NSFW_BIT_A | NSFW_BIT_B);
    expect(nonOwnerCanOpenPost(world.post)).toBe(true);
  });

  it('queues the post for nsfw-level recompute with the exact entity and job type', async () => {
    // The enqueue's ARGUMENTS, separately from the symptom cases above: those
    // would still pass if the entity type were wrong in a way the consumer model
    // tolerated, so the shape is pinned here too.
    await publishPost();
    expect(queuedJobsFrom(dbMock.dbWrite.$executeRaw.mock.calls)).toEqual([
      { entityId: POST_ID, entityType: EntityType.Post, type: JobQueueType.UpdateNsfwLevel },
    ]);
    // And the statement is the trigger's own, `ON CONFLICT DO NOTHING` included —
    // a retry of the whole publish must not fail on a duplicate row.
    const sql = (dbMock.dbWrite.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql.replace(/\s+/g, ' ')).toContain('ON CONFLICT DO NOTHING');
  });

  it('issues the enqueue on the TRANSACTION client, so it cannot commit without the post', async () => {
    // 🔴 THE STRUCTURAL HALF, AND THE ONE A MUTATION CAN SEE. The two cases above
    // observe an effect; this one observes WHERE it was issued, which is what makes
    // the atomicity claim rather than an ordering coincidence. `$transaction` here
    // hands the callback its OWN client, so a statement issued on the global
    // `dbWrite` — i.e. moved back outside the transaction — lands on a different
    // spy and this fails.
    const txExecuteRaw = vi.fn().mockResolvedValue(1);
    const txClient = {
      $executeRaw: txExecuteRaw,
      post: { create: vi.fn().mockResolvedValue({ id: POST_ID }) },
      image: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    // `…Once`, not `mockImplementation`: the shared db mock's `$transaction`
    // default (run the callback against `dbWrite`) is what every other case in
    // this file relies on, and `mockReset()` would delete it rather than restore it.
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: unknown) =>
      (fn as (tx: unknown) => unknown)(txClient)
    );

    await publishPost();
    expect(queuedJobsFrom(txExecuteRaw.mock.calls)).toEqual([
      { entityId: POST_ID, entityType: EntityType.Post, type: JobQueueType.UpdateNsfwLevel },
    ]);
    // NEGATIVE CONTROL: nothing reached the non-transactional client.
    expect(queuedJobsFrom(dbMock.dbWrite.$executeRaw.mock.calls)).toEqual([]);
  });

  it('rolls the enqueue back with the post when the adopt fails — neither is durable', async () => {
    // The other half of inseparability. A row that changed underneath us makes the
    // adopt count come back short, the transaction throws, and the publish leaves
    // NO Post row — so it must leave no queued job either. Under the real client
    // the rollback is Postgres's; what this pins is that the statement is on the
    // path that rolls back, by showing it never runs once the adopt has thrown.
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 0 });
    await expect(publishPost()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(queuedJobsFrom(dbMock.dbWrite.$executeRaw.mock.calls)).toEqual([]);
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
 * absence of a grow-side ledger that let the trigger re-issues stay missing:
 * nothing anywhere stated what the complete set was, so nothing could notice one
 * was not in it. `toEqual` on the whole ordered array is what pins both directions.
 *
 * ⚠️ ITS SCOPE IS EXACTLY THE MOCKED MODULES, WHICH IS NARROWER THAN "EVERY
 * EFFECT" — stated plainly because an over-wide reading would make this list look
 * like coverage it does not provide. The ledger records a call only when it goes
 * through one of the seven `vi.mock`ed modules above, so an effect issued as a RAW
 * statement on `dbWrite`, or through a module this file does not mock, is INVISIBLE
 * to it. The `PostMetric` insert is the standing example: it is a `$executeRaw` and
 * appears nowhere below — it is pinned separately, by the whole-statement `toEqual`
 * in the case above. So: adding an effect that routes through a mocked module fails
 * this list by design; adding any other kind needs its own assertion, and adding
 * one with NEITHER is the gap this comment exists to keep visible.
 */
describe('the effect ledger', () => {
  const WITH_GALLERY = [
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

  it('issues NO JobQueue row of its own — that one is the publishing transaction’s', async () => {
    // The grow-side guard for the boundary this arc moved. An enqueue re-added
    // here would be separable from the publish again, which is the whole defect.
    await run();
    expect(queuedJobsFrom(dbMock.dbWrite.$executeRaw.mock.calls)).toEqual([]);
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
