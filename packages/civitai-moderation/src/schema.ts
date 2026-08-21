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
export const abuseReportInput = z.object({
  // Stable identifier for the producing job, e.g. `reaction-abuse` / `review-bomb`. Used to group
  // runs on the dashboard, so it is an opaque key rather than a display string — the UI titles it.
  detector: z.string().min(1).max(64),
  // When the run happened, per the PRODUCER's clock, ISO-8601. Not defaulted to receipt time: a run
  // that finishes at 11:20 and reports at 11:47 after a retry must not read as an 11:47 run, or the
  // "how stale is this queue" judgement the board exists for is quietly wrong.
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  // Free-text summary for the run header — the same line the job posts to its chat digest.
  summary: z.string().max(2_000).optional(),
  // Counters the producer already computes. Kept as an open record rather than named fields because
  // each detector counts different things (candidates/plausible/prefiltered/rings/…), and pinning a
  // union here would make adding a counter a cross-repo change.
  counters: z.record(z.string().max(64), z.number()).optional(),
  findings: z
    .array(
      z.object({
        // The account the finding is ABOUT. Not an actor.
        userId: z.number().int().positive(),
        // 0..1. The producer's own confidence, not a normalised cross-detector score — comparing two
        // detectors' numbers is not meaningful and the UI must not invite it.
        confidence: z.number().min(0).max(1),
        // Why. The evidence-citing sentence, which is the whole value of the row to a moderator.
        reason: z.string().max(2_000),
        // 🔴 Whether the producer ACTED. False is the common case and the interesting one: it is a
        // detection the system chose not to act on, which is exactly what no existing surface can
        // represent and what a human review queue needs.
        actioned: z.boolean(),
        // What it did, when it did something (`exclude`, `unexclude`, …). Absent when `actioned` is
        // false — there is no action to name.
        action: z.string().max(64).optional(),
      })
    )
    .max(1_000),
});
export type AbuseReportInput = z.infer<typeof abuseReportInput>;
