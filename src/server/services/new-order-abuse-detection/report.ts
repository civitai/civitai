import { MAX_REASON_LENGTH, type AbuseReportInput } from '@civitai/moderation';

/**
 * Turning the Knights of New Order rating-abuse scan into abuse-board reports.
 *
 * 🔴 THIS DETECTOR IS NOT IN SHADOW MODE, AND THAT IS THE ONE WAY IT DIFFERS FROM THE TWO
 * DETECTORS ALREADY ON THIS BOARD. `reaction-withdrawal-detection` and `bot-account-detection` both
 * hardcode `actioned: false` because neither holds a write client. This scan DOES act: when the
 * `autoSmiteAbusers` flag is on it calls `smitePlayer` on the strict-signal subset before it files.
 * So `actioned` is a per-finding fact about what already happened, not an invariant — which is
 * exactly the case the contract's `actioned`/`action` pair exists to express, and exactly the case
 * its `superRefine` refuses to let a producer get half-right.
 *
 * 🔴 NO THRESHOLD IS AN INPUT TO THIS MODULE AND NONE IS RENDERED AS A FIELD. Everything below is an
 * OBSERVED value off one account's own behaviour — counts, a percentage, a pace — never the number it
 * was compared against.
 *
 * ⚠️ WHAT THAT BUYS, AND WHAT IT DOES NOT. An earlier version of this comment said the tunables are
 * held in Redis so they are "not readable from the public source tree", and that the confidence
 * score "cannot be inverted to recover" one. Both overclaim, so they are corrected here rather than
 * left to be cited:
 *
 *  - The reason text publishes the four values the selection rule compares. The query selects on
 *    `HAVING totalRatings >= minTotalRatings`, so the SMALLEST `totalRatings` visible across a few
 *    runs of the board converges on that tunable from above; the smallest dominant share among rows
 *    reading "Auto-smited by this scan." converges on the smite tunable the same way. Withholding
 *    the fields does not change that — the row itself is the disclosure.
 *  - The source tree is not a barrier either: this repo is public, and a checked-in test of the
 *    smite path already carries live values.
 *
 * The withholding is kept anyway, on PROPORTIONALITY rather than secrecy: nothing a moderator does
 * with this board needs a threshold, so putting one on it is a disclosure that buys the reader
 * nothing. And the surface this replaced — a moderator Discord channel — carried the same observed
 * values, so the board is not a widening of what was already published.
 */

/** Stable producer key. Opaque: it groups this detector's runs on the board and namespaces its
 *  counters, so it is not a display string and renaming it orphans the run history. */
export const NEW_ORDER_ABUSE_DETECTOR = 'new-order-abuse-detection';

/**
 * The scan's lookback, in hours.
 *
 * Exported and interpolated into the ClickHouse query rather than restated beside it, because the
 * reason text on every finding states the window as a fact about the evidence ("in the last 24h").
 * Two literals would drift, and the drift would be invisible: the sentence would keep reading
 * correctly while describing a different window than the one that was measured.
 */
export const ABUSE_SCAN_WINDOW_HOURS = 24;

/** The one `action` string this detector can record. A literal in one place, so the finding builder
 *  and every test assert the same token. */
export const SMITE_ACTION = 'smite';

/** One row of the detection query. Structural, not imported from the job, so this module can be
 *  exercised without dragging in ClickHouse, Redis and the smite service. */
export type AbuseSuspect = {
  userId: number;
  totalRatings: number;
  uniqueRatings: number;
  dominantRating: number;
  /** 0..100. Share of this account's ratings that were the dominant value. */
  dominantPct: number;
  avgPerMinute: number;
};

type Finding = AbuseReportInput['findings'][number];

/**
 * A reason over the contract's limit does not lose the finding, it 400s the REPORT and loses every
 * finding in the batch. Truncated here; the ellipsis is the record that something was cut.
 *
 * ⚠️ DEFENCE IN DEPTH, NOT LIVE PROTECTION — it has never trimmed anything and cannot with today's
 * template. `renderReason`'s longest possible output is 311 characters, measured by rendering every
 * numeric field at `Number.MAX_SAFE_INTEGER` in both branches (269 smited, 311 open — the open
 * sentence is the longer of the two), against a cap of `MAX_REASON_LENGTH`. A typical finding is
 * ~220. So this guards a FUTURE template that adds a producer-supplied or unbounded string, not any
 * input the query can hand it; do not cite it as the thing keeping today's reasons in bounds.
 *
 * The bound is IMPORTED from the contract rather than restated. It used to be a local literal beside
 * the contract's own `.max(...)`, which is a copy that can drift silently: the two disagreeing means
 * either a trim to a length the parser has already rejected, or no trim where one was needed, and
 * both present as a detector's runs disappearing from the board rather than as a failure here.
 */
export function truncateReason(reason: string, max = MAX_REASON_LENGTH): string {
  return reason.length <= max ? reason : `${reason.slice(0, max - 1)}…`;
}

/**
 * 🔴 EVERY NUMBER THE RULE LOOKED AT GOES IN THE REASON.
 *
 * The contract has no structured-metrics field — `reason` is the only place a moderator can be told
 * how the detector knows, and a row without the numbers is a bare accusation they cannot check. So
 * all six columns the query selects are stated: the account, the volume, how many distinct values it
 * used, which value dominated, what share that was, and the pace.
 *
 * The pair to read is the DISTINCT-VALUE COUNT against the volume. 200 ratings using one value is a
 * script; 200 ratings using five with one at 40% is a person with an opinion. Both can reach this
 * board, and only the sentence can tell them apart.
 */
export function renderReason(suspect: AbuseSuspect, smited: boolean): string {
  // Floored, not rounded: 99.6% rounding to "100%" states that EVERY rating was the same value,
  // which is a strictly stronger claim than the data supports and the one a moderator would act on.
  const share = Math.floor(suspect.dominantPct);
  const pace = (Math.round(suspect.avgPerMinute * 10) / 10).toFixed(1);
  const parts = [
    `Account ${suspect.userId} cast ${suspect.totalRatings.toLocaleString()} rating(s) in the ` +
      `last ${ABUSE_SCAN_WINDOW_HOURS}h using ${suspect.uniqueRatings.toLocaleString()} distinct ` +
      `rating value(s).`,
    `${share}% of them were the value ${suspect.dominantRating}.`,
    `Pace ${pace} rating(s) per active minute.`,
    // 🔴 The sentence says what was DONE, matching the `actioned` flag on the same row. A moderator
    // reading the board sees the "Acted" cell and the prose together, and the two disagreeing is
    // worse than either being absent — an account that was already smited must not read as an open
    // case, and one that was not must not read as handled.
    smited
      ? `Auto-smited by this scan.`
      : `No action was taken by this scan — filed for a moderator to review.`,
  ];
  return truncateReason(parts.join(' '));
}

/**
 * 🔴 CONFIDENCE IS THE QUEUE'S SORT ORDER, NOT A PROBABILITY.
 *
 * The board renders findings `confidence DESC`, and this detector's selection rule is a disjunction:
 * an account is here because ONE of several signals fired, so a per-account probability would be
 * invented. What the band does is put the rows a moderator should open first at the top.
 *
 * Deliberately computed from the account's OWN observed values and nothing else, so no threshold is
 * an input to it. ⚠️ That is a fact about THIS FUNCTION, not about the row it ships on: the reason
 * text on the same finding publishes the values the selection rule compared, and those bound the
 * thresholds regardless of what this function takes. See the header.
 *
 * 🔴 NOT a function of `actioned`. A smited account scores high because its numbers are extreme, not
 * because it was smited; coupling the two would make the sort order restate the "Acted" column
 * instead of ranking the un-acted rows a moderator actually has to triage.
 */
export function confidenceFor(suspect: AbuseSuspect): number {
  // 0..1 each. Uniformity is the sharpest of the three — one distinct value scores 1, two scores
  // 0.5 — which is the shape a script has and a heavy human voter does not.
  const uniformity = suspect.uniqueRatings > 0 ? 1 / suspect.uniqueRatings : 0;
  const share = Math.min(1, Math.max(0, suspect.dominantPct / 100));
  // Volume saturates: past a couple of hundred ratings in a day the count stops discriminating, and
  // an unbounded term would let a single heavy day outrank a perfectly uniform one.
  const volume = Math.min(1, suspect.totalRatings / 200);
  const blended = 0.4 * uniformity + 0.4 * share + 0.2 * volume;
  // Floored at 0.5 so the whole band sits in the top half — every row here matched the rule, and a
  // 0.1 would read as "probably nothing" on a page that mixes detectors.
  return Math.round((0.5 + 0.5 * blended) * 100) / 100;
}

/**
 * One finding.
 *
 * 🔴 THE `actioned`/`action` PAIR IS THE WHOLE POINT OF THIS FUNCTION, AND GETTING IT HALF-RIGHT
 * COSTS THE ENTIRE RUN. The contract's `superRefine` rejects in BOTH directions — `actioned: true`
 * with no `action`, and `actioned: false` with an `action` — and `moderatorApp.abuseReport` parses
 * before the network call, so one mispaired finding throws and the whole batch, including every
 * correctly-built finding beside it, never reaches the board.
 *
 * So the pair is minted in ONE place, as two whole branches rather than as two independently-set
 * fields. There is no code path that can set one without the other: the `false` branch omits
 * `action` entirely rather than passing `null`, which makes the forbidden combination
 * unrepresentable instead of merely absent today.
 *
 * 🔴 `smited` MEANS "A SMITE ROW WAS WRITTEN FOR THIS ACCOUNT BY THIS RUN" — the durable penalty,
 * not the intent to apply one and not the smite call returning cleanly. All three are different
 * sets, and the board is wrong in a different direction for each of the two it is not:
 *
 *  - SELECTED-for-smiting over-claims. The job's loop swallows a per-player failure and carries on,
 *    so an account whose write never happened would read as dealt with when nothing was done.
 *  - CALL-RETURNED under-claims, which is the worse of the two because it reads as the safe option.
 *    `smitePlayer` commits the row first and then does non-durable work that can throw (see its
 *    `onSmiteCreated` comment); an account caught by that IS penalised, and filing it `actioned:
 *    false` puts "No action was taken by this scan" on the board beside a live smite, inviting a
 *    moderator to apply a second one.
 *
 * So the job hooks the write itself and this flag carries exactly that fact — no more. It does NOT
 * claim the player was notified, that their counter moved, or that a third-strike career reset
 * completed; each of those is in the tail that can fail independently of the penalty.
 */
export function toFinding(suspect: AbuseSuspect, smited: boolean): Finding {
  const base = {
    userId: suspect.userId,
    confidence: confidenceFor(suspect),
    reason: renderReason(suspect, smited),
  };
  if (smited) return { ...base, actioned: true, action: SMITE_ACTION };
  return { ...base, actioned: false };
}

export function renderSummary(suspects: AbuseSuspect[], smitedCount: number): string {
  if (!suspects.length)
    return `No accounts matched the rating-pattern scan over the last ${ABUSE_SCAN_WINDOW_HOURS}h.`;
  const ratings = suspects.reduce((sum, s) => sum + s.totalRatings, 0);
  return (
    `${suspects.length.toLocaleString()} account(s) matched the rating-pattern scan over the last ` +
    `${ABUSE_SCAN_WINDOW_HOURS}h, between them ${ratings.toLocaleString()} rating(s). ` +
    `${smitedCount.toLocaleString()} were auto-smited by the scan; ` +
    `${(
      suspects.length - smitedCount
    ).toLocaleString()} were filed for review with no action taken.`
  );
}

export type BuildReportArgs = {
  suspects: AbuseSuspect[];
  /** The accounts this run committed a smite row for. Membership, not selection, and keyed on the
   *  durable write rather than on the call returning — see `toFinding`. */
  smitedUserIds: ReadonlySet<number>;
  /** The producer's clock at the start of the run. */
  startedAt: Date;
  /** The producer's clock when the scan (including any smiting) finished. */
  finishedAt: Date;
};

/**
 * The whole run, as the one report the endpoint will accept.
 *
 * 🔴 NO THRESHOLD GOES IN `counters` — but not because that keeps one secret. The observed values on
 * the findings already bound the thresholds (see the header); the reason is that nothing a moderator
 * does with this board needs a tunable, and a counter is a longer-lived and wider-read disclosure
 * than a log line. The three below are outcomes of this run — how many matched, how many were acted
 * on, how many are waiting — plus the lookback, which is a plain literal in the query already.
 *
 * 🔴 `finishedAt` is floored at `startedAt`. Both are the producer's own clock so the pair is
 * normally ordered, but the contract refuses a transposed pair outright and losing a whole run to a
 * clock stepping backwards mid-scan is not a trade worth taking.
 *
 * 🔴 ONE report, not batches, and that holds only while the scan's own `LIMIT` stays under
 * `MAX_FINDINGS_PER_REPORT` (1,000 against 50 today). Raising that limit past it does not truncate
 * the report, it makes the contract refuse the whole run — at which point this needs the chunking
 * `bot-account-detection/report.ts` already implements, including its per-batch `startedAt` offset,
 * because `(detector, started_at)` is the receiving table's idempotency key and two batches sharing
 * one start REPLACE each other rather than appending.
 */
export function buildAbuseReport(args: BuildReportArgs): AbuseReportInput {
  const findings = args.suspects.map((s) => toFinding(s, args.smitedUserIds.has(s.userId)));
  const smitedCount = findings.filter((f) => f.actioned).length;
  const finishedAt = new Date(Math.max(args.finishedAt.getTime(), args.startedAt.getTime()));
  return {
    detector: NEW_ORDER_ABUSE_DETECTOR,
    startedAt: args.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary: renderSummary(args.suspects, smitedCount),
    counters: {
      suspects: args.suspects.length,
      auto_smited: smitedCount,
      filed_for_review: args.suspects.length - smitedCount,
      lookback_hours: ABUSE_SCAN_WINDOW_HOURS,
    },
    findings,
  };
}
