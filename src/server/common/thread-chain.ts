/**
 * Both a cycle backstop and a ceiling on how deep a comment-thread chain any walker resolves.
 *
 * Shared so the lock walk and the notification mute walk cannot drift apart on the number — but they
 * do NOT share what happens when it is reached, and that difference is deliberate:
 * `throwIfThreadChainLocked` treats the cap as "could not resolve" and REFUSES the write, because a
 * walk that ran out of road has not proved the absence of a lock. `notThreadMuted` treats it as "no
 * mute found" and SENDS the notification, because a notification silently withheld is a failure the
 * user cannot see, while one they muted arriving anyway is visible and correctable.
 *
 * Measured on production 2026-08-27, over every thread rather than a recent sample: the deepest chain
 * is 247, 706 threads are 20 or deeper, and 149 are past this cap. So this does not close the gap for
 * either walker — past it, a lock refuses writes it should have allowed and a mute stops suppressing.
 * It bounds the work; it is not a proof that no real chain reaches it.
 */
export const MAX_THREAD_CHAIN_DEPTH = 100;

/**
 * The ancestor walk both the notification filter and the UI read use, as ONE string, because
 * mirroring it by retyping is what guarantees they drift — and when they drift the menu says "muted"
 * while notifications keep arriving, or the reverse.
 *
 * Two edges: `Thread.parentThreadId`, and `Thread.commentId -> CommentV2.threadId`. Neither reaches
 * every ancestor on its own (measured on production 2026-08-27: 1,508 of 461,725 comment-anchored
 * threads have no usable `parentThreadId`; 3,110 of 254,368 orphans have only that).
 *
 * 🔴 `UNION`, never `UNION ALL`. With two edges the walk branches by 2 at every level, so the dedup
 * is what bounds it — not the depth cap. Measured: swapping in `UNION ALL` and capping at depth 18
 * produced 524,287 rows against this version's 19. At the shipped cap that is 2 to the 101.
 */
export const muteableThreadsCte = (seedExpression: string) => `WITH RECURSIVE muteable_threads AS (
              SELECT ${seedExpression} "id", 0 "depth"
              UNION
              SELECT "parentId", mt."depth" + 1
              FROM muteable_threads mt
              JOIN "Thread" th ON th.id = mt."id"
              CROSS JOIN LATERAL unnest(ARRAY[
                th."parentThreadId",
                (SELECT pc."threadId" FROM "CommentV2" pc WHERE pc.id = th."commentId")
              ]) AS "parentId"
              WHERE "parentId" IS NOT NULL AND mt."depth" < ${MAX_THREAD_CHAIN_DEPTH}
            )`;
