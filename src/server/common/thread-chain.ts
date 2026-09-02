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
 * Climbs `Thread.commentId -> CommentV2.threadId` ONLY, the same edge `throwIfThreadChainLocked`
 * uses, and deliberately NOT `Thread.parentThreadId`. That column is written from client input on
 * the first reply, so trusting it would let a commenter steer their own reply into a chain the
 * recipient has muted and have the notification dropped — a suppression chosen by the person being
 * replied to about. Dropping the edge fails the other way: a mute is not recognised and the
 * notification arrives anyway. Measured on production 2026-08-27, that costs 3,110 of 254,368
 * orphaned threads (1.2% of orphans, 0.057% of all threads) whose only surviving upward link is the
 * `parentThreadId` their deleted parent comment left behind. An unrecognised mute is noise; a
 * suppressed notification is a control someone else operates on your behalf. (Justin's fleet lead,
 * 2026-08-31. Deriving `parentThreadId` server-side is filed separately.)
 *
 * `UNION ALL`, and the DEPTH CAP is what bounds this — not the dedupe. An earlier version claimed
 * `UNION` made a corrupted cycle converge: measured on Postgres 16 with a deliberate 2-cycle, both
 * forms produce 101 rows and stop at depth 100, because `depth` is in the projected row so no row is
 * ever a duplicate. `UNION ALL` is used because a dedupe that provably cannot fire is dead weight and
 * misleads the next reader — NOT because it is faster. Measured on the prod replica over 5,000
 * single-seed evaluations, interleaved: ~110ms either way against ±25ms run-to-run noise, i.e. no
 * difference. The "cannot fire" part depends on the CTE being seeded with ONE row, which is all
 * production does — seed it with thousands at once and siblings converging on a shared ancestor
 * produce duplicate `(id, depth)` pairs, the dedupe starts working, and `UNION` measurably wins.
 * Anyone batching this walk needs to revisit the choice, not inherit it.
 *
 * Out-degree is 1 because BOTH joins in the recursive term are primary-key equalities (`th.id` and
 * `pc.id`), so each row yields at most one successor. That does not depend on any constraint anyone
 * could drop.
 */
export const muteableThreadsCte = (seedExpression: string) => `WITH RECURSIVE muteable_threads AS (
              SELECT ${seedExpression} "id", 0 "depth"
              UNION ALL
              SELECT pc."threadId", mt."depth" + 1
              FROM muteable_threads mt
              JOIN "Thread" th ON th.id = mt."id"
              JOIN "CommentV2" pc ON pc.id = th."commentId"
              WHERE mt."depth" < ${MAX_THREAD_CHAIN_DEPTH}
            )`;
