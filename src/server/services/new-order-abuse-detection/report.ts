import type { AbuseReportInput } from '@civitai/moderation';

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
 * 🔴 THE THRESHOLDS DO NOT COME IN HERE AND MUST NOT. Every tunable this scan uses is held in Redis
 * specifically so it is not readable from the public source tree, and the board has a wider audience
 * than the job's own logs. Everything rendered below is an OBSERVED value off one account's own
 * behaviour — counts, a percentage, a pace — never the number it was compared against.
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

/** The wire contract's own cap on `reason`. Restated as a constant because the truncation below is
 *  arithmetic on it, and a literal in two places drifts. */
const MAX_REASON_LENGTH = 2_000;

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
 * 🔴 A reason over the contract's limit does not lose the finding, it 400s the REPORT and loses
 * every finding in the batch. Truncated here; the ellipsis is the record that something was cut.
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
 * Deliberately computed from the account's OWN observed values and nothing else — no threshold is an
 * input, so the number cannot be inverted to recover one.
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
 * 🔴 `smited` MUST BE THE OUTCOME, NOT THE INTENT. Pass whether `smitePlayer` actually returned —
 * the job's smite loop swallows per-player failures and continues, so "was selected for smiting" and
 * "was smited" are different sets, and claiming the first on the board tells a moderator an account
 * was dealt with when it was not.
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
  /** The accounts `smitePlayer` actually succeeded on. Membership, not selection — see `toFinding`. */
  smitedUserIds: ReadonlySet<number>;
  /** The producer's clock at the start of the run. */
  startedAt: Date;
  /** The producer's clock when the scan (including any smiting) finished. */
  finishedAt: Date;
};

/**
 * The whole run, as the one report the endpoint will accept.
 *
 * 🔴 NO THRESHOLD GOES IN `counters`. The scan's tunables live in Redis precisely so they are not
 * readable from the public source tree, and a counter is a longer-lived and wider-read disclosure
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
