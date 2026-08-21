import { z } from 'zod';

// The wire contract for each moderator action the spoke exposes at `/api/mod/[action]`. Shared so the
// spoke endpoint validates against the exact shape the main-app client sends — producer and consumer
// can't drift (same pattern as @civitai/notifications). Add an action by adding its schema here + a
// handler in the spoke's mod-actions registry + a method on the client.

// Action names — the URL segment. Import these instead of hand-typing the string on either side.
export const MOD_ACTION = {
  imageModerate: 'image-moderate',
  abuseReport: 'abuse-report',
} as const;
export type ModActionName = (typeof MOD_ACTION)[keyof typeof MOD_ACTION];

// image.moderate — block/unblock one or more images (the review-queue verdict + inline badges). Unblock
// applies the smart default for whatever queue the image is in (e.g. the minor-flag resolution); the
// force-clear-minor override is spoke-internal, not part of this generic contract. `userId` is the acting
// moderator, asserted by the trusted caller; `ip`/`userAgent` are the moderator request provenance for
// the DeleteTOS analytics row.
export const imageModerateInput = z.object({
  ids: z.array(z.number().int()).min(1),
  reviewAction: z.enum(['block', 'unblock']),
  userId: z.number().int(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
});
export type ImageModerateInput = z.infer<typeof imageModerateInput>;

// abuse.report — one run of an automated abuse detector, with whatever it found.
//
// 🔴 This entry breaks the shape every other action here has, deliberately. The rest are invoked BY
// THE MAIN APP on behalf of a signed-in moderator, so they carry a `userId` the trusted caller
// asserts. A detector is a scheduled job: there is NO acting moderator, and requiring one would
// force a caller to invent a person. So the actor is absent by construction, and `actioned` on each
// finding is what says whether anything was DONE — which is the distinction the surface exists for.
// Most of what the detectors produce is `actioned: false`: found, scored, and deliberately not acted
// on. A shape that could only express "here is what I did" would have nothing to store for those.
/**
 * 🔴 `user_id` is a Postgres `integer`. An out-of-range value does not miss the row, it ERRORS the
 * INSERT — and because the whole report is one transaction, that loses the ENTIRE run. Bounded here
 * so one bad finding is refused at the edge instead. The moderator app bounds ids the same way and
 * for the same reason (`$lib/server/query.ts`); duplicated rather than imported because this package
 * must not depend on the app.
 */
const MAX_INT4 = 2_147_483_647;

/**
 * 🔴 Every cross-field rule below exists because the receiving table has a CHECK constraint, and a
 * CHECK violation aborts the transaction and loses the whole run. Rejecting at the edge costs ONE
 * report; letting it through costs all of them. A downstream normalisation cannot substitute: it can
 * only guess which of the two fields the producer meant.
 */
const abuseFinding = z
  .object({
    // The account the finding is ABOUT. Not an actor.
    userId: z.number().int().positive().max(MAX_INT4),
    // 0..1. The producer's own confidence, not a normalised cross-detector score — comparing two
    // detectors' numbers is not meaningful and the UI must not invite it.
    confidence: z.number().min(0).max(1),
    // Why. The evidence-citing sentence, which is the whole value of the row to a moderator, so an
    // empty one is not a finding.
    reason: z.string().min(1).max(2_000),
    // 🔴 Whether the producer ACTED. False is the common case and the interesting one: it is a
    // detection the system chose not to act on, which is exactly what no existing surface can
    // represent and what a human review queue needs.
    actioned: z.boolean(),
    // What it did, when it did something (`exclude`, `unexclude`, …). Absent when `actioned` is
    // false — there is no action to name. `.min(1)`: an empty string renders as a blank "Acted"
    // cell, which reads as missing data rather than as a recorded action.
    action: z.string().min(1).max(64).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.actioned && f.action === undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'action is required when actioned is true',
        path: ['action'],
      });
    if (!f.actioned && f.action !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'action must be absent when actioned is false',
        path: ['action'],
      });
  });

export const abuseReportInput = z
  .object({
    // Stable identifier for the producing job, e.g. `reaction-abuse` / `review-bomb`. Used to group
    // runs on the dashboard, so it is an opaque key rather than a display string — the UI titles it.
    detector: z.string().min(1).max(64),
    // When the run happened, per the PRODUCER's clock. Not defaulted to receipt time: a run that
    // finishes at 11:20 and reports at 11:47 after a retry must not read as an 11:47 run, or the
    // "how current is this" judgement the board exists for is quietly wrong.
    //
    // 🔴 `offset: true`, not the default. Bare `.datetime()` accepts ONLY `Z` and rejects
    // `+00:00` — which is what Python's `datetime.isoformat()` emits, so a perfectly correct
    // ISO-8601 producer would 400 and lose every run.
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
    // `.nullish()`, not `.optional()`: most JSON serialisers emit `null` for an absent string or an
    // empty map, and refusing a whole report over that is losing data to a formatting choice.
    summary: z.string().max(2_000).nullish(),
    // Counters the producer already computes. An open record rather than named fields because each
    // detector counts different things (candidates/plausible/prefiltered/rings/…), and pinning a
    // union here would make adding a counter a cross-repo change.
    counters: z.record(z.string().max(64), z.number()).nullish(),
    findings: z.array(abuseFinding).max(1_000),
  })
  .superRefine((r, ctx) => {
    // A transposed pair renders as a negative duration on a board whose entire claim is when things
    // happened. Compared as instants so the offsets above cannot make this a string comparison.
    if (Date.parse(r.finishedAt) < Date.parse(r.startedAt))
      ctx.addIssue({
        code: 'custom',
        message: 'finishedAt is before startedAt',
        path: ['finishedAt'],
      });
  });
export type AbuseReportInput = z.infer<typeof abuseReportInput>;
