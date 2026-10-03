import { z } from 'zod';

// The wire contract for each moderator action the spoke exposes at `/api/mod/[action]`. Shared so the
// spoke endpoint validates against the exact shape the main-app client sends — producer and consumer
// can't drift (same pattern as @civitai/notifications). Add an action by adding its schema here + a
// handler in the spoke's mod-actions registry + a method on the client.

// Action names — the URL segment. Import these instead of hand-typing the string on either side.
export const MOD_ACTION = {
  imageModerate: 'image-moderate',
  abuseReport: 'abuse-report',
  relabelBuildBatch: 'relabel-build-batch',
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
 * Findings one report may carry.
 *
 * EXPORTED because the reader's page limit must equal it. Two independent caps — one here, one in
 * the moderator app — cannot be pinned equal by any test that lives in only one of the two packages,
 * and if the reader's is the lower of the pair it silently drops rows the writer accepted. Sharing
 * the constant makes them equal by construction instead.
 */
export const MAX_FINDINGS_PER_REPORT = 1_000;

/**
 * Characters one finding's `reason` may carry.
 *
 * EXPORTED for the same structural reason as the cap above, one step earlier in the pipe: a producer
 * that renders a reason has to truncate it to this bound BEFORE it calls, because an over-long reason
 * does not lose the finding — it fails the parse and loses the whole report, every correctly-built
 * finding beside it included. A producer that restates the literal holds a copy that can drift
 * silently: lowering the bound here would leave it trimming to the old, now-invalid length, and the
 * first sign of it would be that detector's runs vanishing from the board.
 *
 * ⚠️ IMPORTING THIS MAKES ONE PRODUCER'S TRUNCATION EQUAL TO THE PARSER'S CAP — IT DOES NOT MAKE
 * THEM ALL EQUAL, and the export by itself enforces nothing. `new-order-abuse-detection` imports it;
 * `bot-account-detection` and `reaction-withdrawal-detection` still declare their own local
 * `MAX_REASON_LENGTH = 2_000`, and each has a suite pinning that literal. They are consistent with
 * this value today by coincidence of the number, not by construction. The set of producers still
 * holding a local copy is pinned as an explicit ledger in
 * `src/server/services/new-order-abuse-detection/__tests__/max-reason-length-ledger.test.ts`, which
 * fails if it grows or shrinks.
 *
 * That ledger catches the COMMON shape, not every shape. It matches the identifier
 * `MAX_REASON_LENGTH` declared in a `src/server/services/<name>/report.ts`, so a copy under a
 * different name (`const REASON_CAP = 2_000`), or one in a producer laid out differently, stays
 * green. Read it as a tripwire on the likely case rather than a guarantee that no copy can appear.
 */
export const MAX_REASON_LENGTH = 2_000;

/** Declared once and used by both timestamp fields, so neither can regress without the other. */
const isoWithOffset = z.iso.datetime({ offset: true });

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
    reason: z.string().min(1).max(MAX_REASON_LENGTH),
    // 🔴 Whether the producer ACTED. False is the common case and the interesting one: it is a
    // detection the system chose not to act on, which is exactly what no existing surface can
    // represent and what a human review queue needs.
    actioned: z.boolean(),
    // What it did, when it did something (`exclude`, `unexclude`, …). Absent when `actioned` is
    // false — there is no action to name. `.min(1)`: an empty string renders as a blank "Acted"
    // cell, which reads as missing data rather than as a recorded action.
    //
    // `.nullish()` for the same reason `summary` has it, and it matters MORE here: `actioned: false`
    // is most of what the detectors produce, `action IS NULL` is the database's own spelling of it,
    // and a producer serialising a nullable field emits `null`. Refusing that would lose every run
    // from the commonest possible payload.
    action: z.string().min(1).max(64).nullish(),
    // 🔴 OPTIONAL, AND IT HAS TO STAY THAT WAY. Three detectors already post to this board and none
    // of them sends this field; a required key here would 400 every one of their reports and take
    // the whole surface down to add a feature none of them uses.
    //
    // What it is: the producer's own claim that several findings in THIS report are one actor, so a
    // moderator rules them once instead of N times. An opaque key — the reader groups on equality
    // and never parses it — scoped to the run by the reader, because the same key in two runs is two
    // separate decisions over two different cohorts.
    //
    // 🔴 A PRODUCER MUST NOT PUT ANYTHING IN HERE THAT THE FINDING'S OWN `reason` DOES NOT ALREADY
    // SAY. The key is rendered on a board with a wider audience than the investigative tools, so it
    // is a disclosure surface, not just an identifier. `.nullish()` for the same reason `action` has
    // it: a serialiser emitting `null` for an absent optional must not lose the report.
    groupKey: z.string().min(1).max(200).nullish(),
  })
  .superRefine((f, ctx) => {
    // 🔴 `!= null`, NOT `!== undefined`. Loose equality is deliberate: it treats `null` and
    // `undefined` alike, which is the whole point of accepting both above. With `!== undefined`,
    // `action: null` on a non-actioned finding — the commonest payload there is — would be refused.
    if (f.actioned && f.action == null)
      ctx.addIssue({
        code: 'custom',
        message: 'action is required when actioned is true',
        path: ['action'],
      });
    if (!f.actioned && f.action != null)
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
    // ISO-8601 producer would 400 and lose every run. BOTH fields, not just the first: they are
    // independent schemas and a guard that only varies one of them cannot see the other regress.
    startedAt: isoWithOffset,
    finishedAt: isoWithOffset,
    // `.nullish()`, not `.optional()`: most JSON serialisers emit `null` for an absent string or an
    // empty map, and refusing a whole report over that is losing data to a formatting choice.
    summary: z.string().max(2_000).nullish(),
    // Counters the producer already computes. An open record rather than named fields because each
    // detector counts different things (candidates/plausible/prefiltered/rings/…), and pinning a
    // union here would make adding a counter a cross-repo change.
    counters: z.record(z.string().max(64), z.number()).nullish(),
    findings: z.array(abuseFinding).max(MAX_FINDINGS_PER_REPORT),
  })
  .superRefine((r, ctx) => {
    // A transposed pair renders as a negative duration on a board whose entire claim is when things
    // happened. `Date.parse` on an offset-bearing string compares INSTANTS, which is why the fields
    // above insist on an offset.
    //
    // 🔴 Bail when either field already failed its OWN validation. This refinement still runs in
    // that case, and `Date.parse` does not fail on a string the field schema rejected — it GUESSES.
    // A naive `2026-08-21T11:00:00.123456` parses as LOCAL time, so west of UTC it compares as later
    // than a `Z` finish and adds a false "finishedAt is before startedAt" beside the real error. A
    // NaN check does not catch that, because the guess succeeded; re-checking the field schema does.
    if (!isoWithOffset.safeParse(r.startedAt).success) return;
    if (!isoWithOffset.safeParse(r.finishedAt).success) return;
    if (Date.parse(r.finishedAt) < Date.parse(r.startedAt))
      ctx.addIssue({
        code: 'custom',
        message: 'finishedAt is before startedAt',
        path: ['finishedAt'],
      });
  });
export type AbuseReportInput = z.infer<typeof abuseReportInput>;

// relabel.buildBatch — one daily batch of the removal-label relabel set. Like abuseReport, the caller
// is a scheduled job, so there is no acting moderator.
export const MAX_RELABEL_BATCH_ITEMS = 500;
/** One less than the blocked-image retention, which this zod-only package does not import. */
export const MAX_RELABEL_WINDOW_DAYS = 6;
/** The daily batch's per-stratum caps and removal window, shared by the job and the CLI. */
export const RELABEL_DAILY_CAPS = { removed: 100, notRemoved: 40 };
export const RELABEL_WINDOW_DAYS = 5;
export const relabelBuildBatchInput = z.object({
  /** The UTC day. It names the batch, which is what makes a second run that day add nothing. */
  batch: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Caps on what the batch holds per stratum, not on what one run adds. */
  removed: z.number().int().min(0).max(MAX_RELABEL_BATCH_ITEMS),
  notRemoved: z.number().int().min(0).max(MAX_RELABEL_BATCH_ITEMS),
  days: z.number().int().min(1).max(MAX_RELABEL_WINDOW_DAYS),
  dryRun: z.boolean(),
});
export type RelabelBuildBatchInput = z.infer<typeof relabelBuildBatchInput>;

type Strata<T> = { removed: T; notRemoved: T };

/** What the `relabel-build-batch` action returns. Built by the spoke, read by the main-app job. */
export type RelabelBuildSummary = {
  batch: string;
  dryRun: boolean;
  modelOnly: boolean;
  /** Set when the run wrote nothing because the CSAM exclusion could not complete. */
  skipped: 'csam exclusion timed out' | null;
  notRemovedSkipped: 'bands unset' | 'bands invalid' | null;
  candidates: Strata<number>;
  csamExcluded: Strata<number>;
  alreadyInSet: number;
  alreadyInBatch: Strata<number>;
  picked: Strata<number>;
  /** Picked per `<stratum> <stratumKey>`. A list, so new strata never add log fields. */
  strata: { key: string; n: number }[];
  inserted: number;
  promoted: number;
  /** Picked but already present when written: another batch's run took the image first. */
  alreadyPresent: number;
};

/** The body `/api/mod/[action]` responds with. The one place its shape is written. */
export const modActionResponse = <T>(result: T) => ({ ok: true as const, result });

export type RelabelBuildShortfall =
  | NonNullable<RelabelBuildSummary['skipped']>
  | 'bands invalid'
  | 'no summary';

/**
 * Whether a relabel run is logged as an error, and why: `null` when it is not. The one rule for
 * that, on both sides of the wire. Unset bands are not a shortfall: removed-only is the expected
 * state until the bands are configured. Nor is a stratum short of candidates; read the counts.
 */
export function relabelSummaryShortfall(
  summary: RelabelBuildSummary
): RelabelBuildShortfall | null {
  if (summary.skipped) return summary.skipped;
  if (summary.notRemovedSkipped === 'bands invalid') return 'bands invalid';
  return null;
}

/**
 * `relabelSummaryShortfall` read from the action's response. Typed against `modActionResponse`
 * but not validated at runtime, so a body without a summary counts as a shortfall, never a pass.
 */
export function relabelBuildShortfall(response: unknown): RelabelBuildShortfall | null {
  const summary = (response as Partial<ReturnType<typeof modActionResponse<RelabelBuildSummary>>>)
    ?.result;
  return summary ? relabelSummaryShortfall(summary) : 'no summary';
}
