import { z } from 'zod';
import { isoDatetimeCompat } from '@civitai/shared/iso-datetime-compat';
import { HQ_TASK_URL_PREFIX, hqTaskFromUrl } from '@civitai/shared/clickup-url';
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TRIAGE_NOTE_APPEND_MAX_LENGTH,
} from '@civitai/shared/feedback.constants';

// The wire contract for each moderator action the spoke exposes at `/api/mod/[action]`. Shared so the
// spoke endpoint validates against the exact shape the main-app client sends — producer and consumer
// can't drift (same pattern as @civitai/notifications). Add an action by adding its schema here + a
// handler in the spoke's mod-actions registry + a method on the client.

// Action names — the URL segment. Import these instead of hand-typing the string on either side.
export const MOD_ACTION = {
  imageModerate: 'image-moderate',
  abuseReport: 'abuse-report',
  relabelBuildBatch: 'relabel-build-batch',
  feedbackTriage: 'feedback-triage',
  imageTagModerate: 'image-tag-moderate',
  caseDefinitions: 'case-definitions',
  caseIntake: 'case-intake',
  casePartyView: 'case-party-view',
  casePartyAction: 'case-party-action',
} as const;

/**
 * The actions the main app may call with the scoped takedown-intake credential (MOD_CASES_TOKEN), and
 * the only ones it may. The spoke refuses that credential on any other action, and refuses the general
 * credential on these, so neither can stand in for the other.
 */
export const CASE_ACTIONS: ReadonlySet<ModActionName> = new Set([
  MOD_ACTION.caseDefinitions,
  MOD_ACTION.caseIntake,
  MOD_ACTION.casePartyView,
  MOD_ACTION.casePartyAction,
]);
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
  /** The moderator holds `image.removal.confirm`, so a re-removal of an image approved on appeal
   *  applies directly instead of being held for confirmation. Asserted by the trusted caller. */
  canConfirmReRemoval: z.boolean().optional(),
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
const isoWithOffset = isoDatetimeCompat({ offset: true });

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
    // Refuse the whole report rather than store its findings ungrouped, for a producer whose
    // findings are unreviewable one row at a time.
    requireGroupKey: z.boolean().optional(),
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

// feedback-triage (`MOD_ACTION.feedbackTriage`) — set ONE feedback report's moderator triage status through the queue's own write
// (`triageFeedback` in the moderator app), optionally appending to its internal triage note and
// recording the HQ task that tracks it as `context.hq`. Scoped on `expectedStatus`: a row that moved
// since the caller read it is not changed. `ownerStatus` (the app developer's vocabulary) is not in
// this contract and is never written.
//
// `feedbackTriageRequest` is what a caller of the main app's `/api/mod/feedback/triage` sends;
// `feedbackTriageInput` adds the acting moderator, asserted by the trusted caller after its own
// `feedback.status.set` check, as every action here does.
export const feedbackTriageRequest = z.object({
  id: z.coerce.number().int().positive().max(2_147_483_647).describe('The Feedback row id.'),
  status: z.enum(FEEDBACK_STATUSES).describe('The status to set.'),
  expectedStatus: z
    .enum(FEEDBACK_STATUSES)
    .describe('The status the caller last read. A row no longer at it is not changed (409).'),
  noteAppend: z
    .string()
    .trim()
    .min(1)
    .max(FEEDBACK_TRIAGE_NOTE_APPEND_MAX_LENGTH)
    .optional()
    .describe('Appended to the moderator-internal triage note, below what it holds.'),
  hqTaskUrl: z
    .string()
    .refine((url) => hqTaskFromUrl(url) !== null, {
      message: `Expected an HQ task link: ${HQ_TASK_URL_PREFIX}<id>`,
    })
    .optional()
    .describe('The HQ task tracking this report, recorded as context.hq.'),
});
export type FeedbackTriageRequest = z.infer<typeof feedbackTriageRequest>;

export const feedbackTriageInput = feedbackTriageRequest.extend({
  userId: z.number().int().positive(),
  /**
   * The handler the caller read, when it must not overwrite a row someone else has re-stamped since
   * (the HQ sync): `null` matches only an unhandled row. Absent = not checked. Not on the public
   * route's input: a moderator acting is the one doing the re-stamping.
   */
  expectedHandledById: z.number().int().positive().nullable().optional(),
  /**
   * `true`: write only while the row carries no HQ sync hold (`context.syncHold`). The HQ sync
   * sets it, so a row a moderator moved back to `new` after the sync read it is refused, not
   * moved forward. Absent = not checked.
   */
  expectedUnheld: z.boolean().optional(),
});
export type FeedbackTriageInput = z.infer<typeof feedbackTriageInput>;

/**
 * What the action answers, inside `modActionResponse`. `changed: false` is the compare-and-set
 * refusal; `gone` is a row that does not exist. Any other refusal `triageFeedback` can give needs a
 * resolution write, which this contract has no field for.
 */
export const feedbackTriageResponse = z.object({
  result: z.union([
    z.object({ ok: z.literal(true), changed: z.boolean() }),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ]),
});

// image-tag-moderate (`MOD_ACTION.imageTagModerate`) — Knights writes back a Paladin consensus on one flagged tag of the
// moderator tag review queue: keep it (`disable: false`) or remove it (`disable: true`), through the same
// `moderateImageTags` the queue's Keep/Remove buttons call, in its guarded mode.
//
// 🔴 The one action whose `userId` is NOT a moderator: it is the player whose vote completed the consensus, asserted
// by Knights. The handler grants that id nothing beyond the one tag write and its `moderateTagKono` activity row.
export const imageTagModerateInput = z.object({
  imageId: z.number().int().positive().max(MAX_INT4),
  tagId: z.number().int().positive().max(MAX_INT4),
  disable: z.boolean(),
  userId: z.number().int().positive().max(MAX_INT4),
  /** The consensus closed on exactly the votes its stage needs (the 2-0 rule). A removal that would now lower the
   *  image's rating is then refused, since such a removal needs the stricter rule. */
  settledAtMinimum: z.boolean(),
});
export type ImageTagModerateInput = z.infer<typeof imageTagModerateInput>;

/**
 * `applied`: the tag was kept or removed. `already-ruled`: the tag is no longer flagged (a moderator ruled first, or it
 * was disabled or removed). `ineligible`: the image or tag is staff-only now, or the removal needs the stricter rule;
 * the tag stays in the moderators' queue. `missing`: the image is gone.
 */
export const IMAGE_TAG_MODERATE_OUTCOMES = [
  'applied',
  'already-ruled',
  'ineligible',
  'missing',
] as const;
export type ImageTagModerateOutcome = (typeof IMAGE_TAG_MODERATE_OUTCOMES)[number];
export const imageTagModerateResult = z.object({
  outcome: z.enum(IMAGE_TAG_MODERATE_OUTCOMES),
  reason: z.string().optional(),
});
export type ImageTagModerateResult = z.infer<typeof imageTagModerateResult>;
/** What the action answers: the result inside `modActionResponse`. */
export const imageTagModerateResponse = z.object({ result: imageTagModerateResult });

// Called by the main app's public /requests pages, signed out as well as in. Nothing here carries an
// acting moderator: the submitter is a member of the public, so the spoke verifies Turnstile itself and
// rate-limits by the forwarded ip. Field values are checked against the definition in the spoke, never here.

const processKey = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
/** A case's public reference, e.g. TD-26-AJEDE5. */
export const casePublicRef = z.string().regex(/^[A-Z]{2}-\d{2}-[A-Z0-9]{6}$/);
const fieldValue = z.union([
  z.string().max(20_000),
  z.array(z.string().max(2_000)).max(200),
  z.boolean(),
]);
const fieldValues = z.record(z.string().max(40), fieldValue);
const requestOrigin = {
  /** The submitter's ip as the main app saw it, for the spoke's rate limit and Turnstile check. */
  ip: z.string().min(1).max(64),
  userAgent: z.string().max(512).optional(),
};

export const caseDefinitionsInput = z.object({});
export type CaseDefinitionsInput = z.infer<typeof caseDefinitionsInput>;

export const caseIntakeInput = z.object({
  processKey,
  /** Made by the form once per page load, so a resubmit after a timeout returns the same case. */
  submissionId: z.string().uuid(),
  values: fieldValues,
  turnstileToken: z.string().min(1).max(4_096),
  /** Set by the main app only for a signed-in submitter; the spoke never trusts it for access. */
  submitterUserId: z.number().int().positive().max(2_147_483_647).optional(),
  /** A test case. The main app sets it only for a signed-in moderator. */
  isTest: z.boolean().optional(),
  ...requestOrigin,
});
export type CaseIntakeInput = z.infer<typeof caseIntakeInput>;

/** The party's own link token travels to the spoke on every call and is resolved there each time. */
const partyAccess = {
  publicRef: casePublicRef,
  token: z.string().min(16).max(256),
  ...requestOrigin,
};

export const casePartyViewInput = z.object(partyAccess);
export type CasePartyViewInput = z.infer<typeof casePartyViewInput>;

export const casePartyActionInput = z.object({
  ...partyAccess,
  /** Made by the page once per filing, so a retry after a timeout records nothing new. */
  submissionId: z.string().uuid(),
  actionId: processKey,
  values: fieldValues,
});
export type CasePartyActionInput = z.infer<typeof casePartyActionInput>;
