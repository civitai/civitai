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
