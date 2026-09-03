/**
 * The abandoned-draft reaping schedule, in one place.
 *
 * Three files independently spell parts of this rule and they must agree:
 *  - `src/server/jobs/remove-old-drafts.ts` — the reaper that actually destroys
 *    models (cascading to their versions, files and training data).
 *  - `src/server/notifications/model.notifications.ts` — the `old-draft`
 *    warning, which promises the deletion is coming.
 *  - `src/server/jobs/reset-to-draft-without-requirements.ts` — the sweep that
 *    puts models into `Draft` in the first place.
 *
 * 🔴 This module must stay dependency-free. `model.notifications.ts` sits in a
 * module graph that `no-server-infra-in-app-graph.test.ts` forbids from reaching
 * `src/server/db/` or `src/utils/logging.ts`, so it cannot import the reaper job
 * directly to get these numbers. That is the whole reason this file exists
 * rather than the constants living next to the job.
 */

/**
 * How long a model's own row must have gone untouched before it is even a
 * deletion CANDIDATE — the abandonment threshold.
 *
 * 🔴 Lowering it WIDENS what the reaper destroys. It is NOT the same quantity as
 * `ACTIVITY_WINDOW_DAYS`, even though both are 30 today: raising the window
 * spares more, lowering the threshold destroys more. Keep them separate symbols
 * so a maintainer narrowing one is never steered into changing the other.
 */
export const REAP_AGE_DAYS: number = 30;

/**
 * How recently something UNDER a model must have moved for the model to count as
 * still in use, and therefore be SPARED.
 *
 * Read at runtime by `filterModelsWithRecentActivity`, and spelled as a SQL
 * literal in both the reaper's fence and the `old-draft` notification's.
 */
export const ACTIVITY_WINDOW_DAYS: number = 30;

/**
 * How far AHEAD of the reap the `old-draft` warning fires. This is the "1 week"
 * the notification's message promises.
 */
export const OLD_DRAFT_LEAD_DAYS: number = 7;

/**
 * The model age at which the `old-draft` warning fires.
 *
 * 🔴 Derived from `REAP_AGE_DAYS`, never hardcoded, and deliberately NOT from
 * `ACTIVITY_WINDOW_DAYS`: the notification's `BETWEEN` band keys on
 * `Model."updatedAt"`, which is the very column the reaper's age threshold
 * tests. The two constants are 30 today, so an expression built on the wrong one
 * is indistinguishable by value — see the warning on `REAP_AGE_DAYS` above.
 *
 * This is the ONLY interval in the `old-draft` query. It carries no activity
 * fence, because a `now()`-relative activity clause evaluated once cannot track a
 * reaper that retries nightly — the reasoning is on the query itself.
 */
export const OLD_DRAFT_NOTICE_DAYS: number = REAP_AGE_DAYS - OLD_DRAFT_LEAD_DAYS;

/**
 * The lead time as it appears in the notification's user-facing message, derived
 * so the copy cannot silently disagree with the schedule it describes.
 */
// Annotated `number` above, not left to literal inference: TypeScript otherwise
// narrows each to its own literal type and rejects the arithmetic below as a
// comparison "with no overlap". These are configuration values, not literals.
export const OLD_DRAFT_LEAD_TEXT: string =
  OLD_DRAFT_LEAD_DAYS % 7 === 0
    ? `${OLD_DRAFT_LEAD_DAYS / 7} week${OLD_DRAFT_LEAD_DAYS / 7 === 1 ? '' : 's'}`
    : `${OLD_DRAFT_LEAD_DAYS} day${OLD_DRAFT_LEAD_DAYS === 1 ? '' : 's'}`;
