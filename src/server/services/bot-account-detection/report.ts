import { createHash } from 'crypto';
import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import { NO_ACTION_TAKEN, plural } from '../abuse-report-prose';
import type { BotAccountCohortMember, SurfaceCounts } from './cohort';
import { renderNotes, type BotAccountScore } from './scoring';

/**
 * Turning a scored cohort into abuse-board reports.
 *
 * 🔴 WHY THE BOARD AND NOT `UserRestriction`. The integration target for the LIVE phase is a
 * `UserRestriction` row of type `bot-account`, and that seam already exists (civitai#4609). It is
 * deliberately not used here, because in the shadow phase it cannot be: `applyPendingReviewMute` has
 * no file-without-mute path — its create branch is one `$transaction([user.update({muted:true}),
 * userRestriction.create(…)])` — and the service's own comment calls an unmuted Pending row "the one
 * state a Pending row must never be left in", since an uphold then sets `mutedAt` and `confirm-mutes`
 * acts on the account. So "file a Pending row, mute nobody" would manufacture that forbidden state on
 * every single finding.
 *
 * The abuse board is the surface built for precisely this: `actioned: false` on the wire contract is
 * documented as "a detection the system chose not to act on, which is exactly what no existing
 * surface can represent". Write-only, and it grants nothing.
 */

/** The producer key. Opaque — it groups runs on the board and is a counters namespace, so it is not
 *  a display string and renaming it orphans this detector's history. */
export const BOT_ACCOUNT_DETECTOR = 'bot-account-detection';

type AbuseFinding = AbuseReportInput['findings'][number];

/** The wire contract's own cap on `reason`. Restated as a constant because the truncation below has
 *  to be arithmetic on it, and a literal in two places drifts. */
const MAX_REASON_LENGTH = 2_000;

/**
 * 🔴 A reason over the contract's limit does not lose the finding, it loses the whole REPORT — every
 * finding in the batch with it. The failure is LOCAL, not a spoke 4xx: `moderatorApp.abuseReport`
 * runs `abuseReportInput.parse(input)` before the fetch, so an over-long reason throws a ZodError in
 * this process and nothing is ever sent. So it is truncated here rather than left to fail, and the
 * ellipsis is the record that something was cut. Reason text is generated from bounded facts plus a
 * username and the heuristics' own notes, both of which can grow. (The per-heuristic `id=0.00` list
 * was a third such input and is no longer rendered — see `buildFinding` — so the reason is shorter
 * than it was, not differently bounded.)
 */
export function truncateReason(reason: string, max = MAX_REASON_LENGTH): string {
  if (reason.length <= max) return reason;
  return `${reason.slice(0, max - 1)}…`;
}

/**
 * The wire contract's own cap on a report's `summary`, restated for the same reason
 * `MAX_REASON_LENGTH` is.
 *
 * 🔴 THE THIRD PRODUCER-SUPPLIED STRING ON THIS CONTRACT, AND IT SHIPPED UNBOUNDED. `reason` and
 * `groupKey` were each brought inside their cap at the point a finding is built; the summary was
 * not, and it is the one of the three that GROWS WITH THE RUN'S ILL HEALTH — every disclosure
 * sentence in `run.ts` (three source-failure branches, two budget-exhausted branches, the cap
 * branch) is appended only when something went wrong. So the longest summary this producer can emit is the one
 * describing the worst run, which is exactly the run whose report must not be lost.
 *
 * MEASURED, AND THE MEASUREMENT IS HISTORICAL — READ THE DATE ON IT. When the on-site legend was
 * first appended to the summary in full, a run with all three evidence reads failing and the cohort
 * capped produced a 2,037-character summary and `abuseReportInput.safeParse` REFUSED the whole
 * report: no findings, no counters, no record that the reads had failed. The failure is local
 * (`moderatorApp.abuseReport` parses before the fetch), so there is no 400 to read and nothing is
 * sent.
 *
 * ⚠️ THAT CASE NOW MEASURES 1,973 AND IS NOT TRIMMED, because the scan-pending caveat moved back
 * onto each finding and took ~50 characters out of the legend. 27 characters of headroom is not a
 * safety margin — it is one reworded disclosure sentence — which is the whole argument for the
 * bound existing rather than for it being unnecessary. Do not read the smaller number as "this
 * cannot happen"; `run.ts` has two budget-exhausted branches that this fixture does not even
 * trigger.
 *
 * ⚠️ IT IS A LOCAL LITERAL BECAUSE THE CONTRACT DOES NOT EXPORT THIS ONE — `MAX_REASON_LENGTH` and
 * `MAX_FINDINGS_PER_REPORT` are exported, the summary's `.max(2_000)` is inline. A copy can drift,
 * so `__tests__/report.test.ts` pins it against the REAL schema by parsing at the boundary in both
 * directions rather than by restating the number a second time.
 */
const MAX_SUMMARY_LENGTH = 2_000;

/**
 * Bring a run summary inside the contract's cap.
 *
 * 🔴 IT CUTS THE TAIL, AND THAT IS WHY `run.ts` PUTS THE LEGEND LAST. Everything a summary says is
 * worth saying, but not equally: a source-read failure is a fact about THIS run that appears nowhere
 * else a human reads, while `POST_COUNT_LEGEND` is a definition that is the same on every run and is
 * inferable from the words it defines. So the ordering in `run.ts` is the priority order, and this
 * function is what makes that ordering matter. Rewriting it to cut from the middle, or to drop whole
 * sentences, would be a worse trade for a more complicated function.
 *
 * TRUNCATION, NOT REFUSAL, for the reason `truncateReason` gives: over the cap the report is not
 * shortened, it is REJECTED, and every finding and counter in it is lost. The ellipsis is the record
 * that something was cut.
 */
export function truncateSummary(summary: string, max = MAX_SUMMARY_LENGTH): string {
  // 🔴 A NON-POSITIVE BUDGET MUST RETURN NOTHING, NOT A LONGER STRING. The caller subtracts the
  // batch wording's length from the cap, so this is reachable in principle by a caller with a
  // pathological suffix — and the naive path is worse than useless there: `slice(0, 0)` plus an
  // ellipsis is ONE character where zero were allowed, and `slice(0, -1)` returns nearly the whole
  // string. A bound that can exceed its own budget is not a bound. (Unreachable today: the batch
  // wording is ~130 characters against a 2,000 cap, so the budget is ~1,870.)
  if (max <= 0) return '';
  if (summary.length <= max) return summary;
  return `${summary.slice(0, max - 1)}…`;
}

/** The wire contract's own cap on `groupKey`, restated for the same reason `MAX_REASON_LENGTH` is. */
const MAX_GROUP_KEY_LENGTH = 200;

/**
 * The prefix a hashed key carries. Distinct from every key-kind prefix a producer may mint (today:
 * `domain:`), so a hashed key can never be mistaken for, or collide with, an unhashed one.
 */
export const HASHED_GROUP_KEY_PREFIX = 'hashed:';

/**
 * 🔴 THE SAME HAZARD `truncateReason` EXISTS FOR, IN THE SECOND PRODUCER-SUPPLIED STRING THIS
 * CONTRACT CARRIES. A `groupKey` over the contract's 200-character cap does not lose the one
 * finding: `abuseReportInput.safeParse` fails `too_big`, `run.ts` validates BEFORE the network call,
 * and the throw aborts the run — losing that batch and every batch after it. Measured: a 240-char
 * email domain yields a 247-character key and the whole report is refused (boundary: 193 characters
 * parses, 194 fails). Four accounts on one uncommon domain is all it takes to reach, and a
 * wildcard-MX subdomain chain under an attacker-owned apex fits inside DNS's own 253-character
 * limit — so an unbounded key is a denial-of-detection lever, not just an edge case.
 *
 * 🔴 HASHED, NOT TRUNCATED, AND THAT IS THE WHOLE DIFFERENCE FROM `truncateReason`. A reason is
 * prose and cutting it costs the tail of a sentence. A group key is an IDENTITY: two distinct
 * domains sharing a 193-character prefix truncate to the SAME string, which would merge two
 * unrelated clusters into one decision and let a moderator rule a ring they never looked at with one
 * click. A digest keeps both halves of what a key has to do — every member of one cluster derives
 * the identical key, because this is a pure function of the key, and two different clusters do not
 * collide.
 *
 * It also discloses strictly LESS than the key it replaces, which keeps the "a key must not carry
 * anything the reason does not already say" rule satisfied by construction.
 */
export function boundGroupKey(key: string, max = MAX_GROUP_KEY_LENGTH): string {
  if (key.length <= max) return key;
  return `${HASHED_GROUP_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`;
}

/** `3 comments, 0 models, 40 images` — the per-surface breakdown, spelled one way. */
const renderSurface = (s: SurfaceCounts) =>
  `${s.comments} ${plural(s.comments, 'comment')}, ${s.models} ${plural(s.models, 'model')}, ` +
  `${s.images} ${plural(s.images, 'image')}`;

/**
 * 🔴 THE CARVE-OUT THAT KEEPS "STILL ON THE SITE" HONEST — PER ROW, BECAUSE IT HAS TO BE.
 *
 * `cohort.ts` deliberately counts an image whose scan has not finished (`ingestion: Pending`) as
 * on-site, which is exactly the case a moderator cannot view yet. Without this clause "All 3 are
 * still on the site" sends someone to look at three items none of which they can open — the same
 * over-claim the word "visible" was removed for.
 *
 * 🔴 IT STAYS ON EVERY FINDING WHILE THE ENUMERATION MOVES TO THE SUMMARY, AND THE SPLIT IS NOT
 * ARBITRARY. A reason is rendered on TWO surfaces, and only one of them shows a summary:
 * `apps/moderator/src/routes/abuse/[runId]/+page.svelte` renders the run summary above the findings
 * table, but `apps/moderator/src/routes/retool/user-lookup/AbuseFindingsPanel.svelte` renders
 * `{f.reason}` on its own — `getAbuseFindingsForUser` selects from `abuse_detection_finding` alone
 * and never joins the run. So anything moved to the summary is UNREACHABLE from User Lookup. A
 * definition of the two categories is inferable from the words it defines and can live there; a
 * caveat that inverts what one of those categories means cannot, so it rides with the number.
 */
const PENDING_CARVE_OUT = 'Images awaiting a scan result count as on the site.';

/**
 * 🔴 WHAT THE TWO ON-SITE CATEGORIES COVER — ONCE, ON THE RUN PAGE.
 *
 * The enumeration used to be appended to EVERY finding, ~210 characters of identical prose repeated
 * for every account in a run that can carry a thousand of them. A list a reader needs once is noise
 * on the 999 rows after that, and it pushed the account's own facts — the only part that differs per
 * row — down below the fold of the board's reason cell.
 *
 * ⚠️ IT IS REACHABLE FROM THE RUN PAGE AND NOT FROM USER LOOKUP; see `PENDING_CARVE_OUT` above for
 * why that is an acceptable trade for this half and not for the other. "Still on the site" and "no
 * longer on the site" are ordinary English that a moderator can act on without the list; the list
 * tells them WHICH states fall where, which is a refinement rather than a correction.
 *
 * 🔴 IT MUST STAY IN THE SUMMARY OF EVERY BATCH, not only the first. `buildReports` splits a large
 * run across several reports and each becomes its own row on the board with its own summary; a
 * legend attached to batch 1 alone would leave batches 2..n undefined. `buildReports` appends its
 * batch wording to the caller's summary rather than replacing it, so a caller that includes this
 * once gets it on all of them.
 */
export const POST_COUNT_LEGEND =
  'Still on the site means the item has not been hidden, blocked, unpublished or removed; ' +
  'no longer on the site covers drafts, unpublished or scheduled models, unattached uploads, ' +
  'uploads the scanner blocked or could not find, and hidden, TOS-flagged or already-removed ' +
  'content.';

/**
 * 🔴 WHAT THE ACCOUNT POSTED, AND HOW MUCH OF IT IS STILL UP — both, always, in that order.
 *
 * The leading number is the total, because that is what membership was decided on and a moderator
 * ranking a queue by volume must see the same figure the detector did. An account with 40 blocked
 * uploads leads with 40, not with 0.
 *
 * The split follows, because "40 images" and "40 images, 39 of which we already removed" call for
 * different actions and the second is the interesting one. When nothing was excluded the split
 * collapses to one clause — the sentence still states it, so a reader never has to infer the
 * absence of a missing clause.
 *
 * The CATEGORIES are ENUMERATED once in `POST_COUNT_LEGEND`, on the run summary. What stays here is
 * this account's own numbers — the only part that differs from one row to the next — plus
 * `PENDING_CARVE_OUT`, which could not move for the reason its own docstring gives: one of the two
 * surfaces that renders a reason shows no summary at all.
 */
export function renderPostCounts(posts: BotAccountCohortMember['posts']): string {
  const head = `Posted ${posts.all.total} ${plural(posts.all.total, 'item')} — ${renderSurface(
    posts.all
  )}.`;
  // `All 1 are still on the site` is grammatical nonsense and the single-item account is common in
  // a cohort of day-old signups, so the singular gets its own sentence rather than a spliced verb.
  if (posts.excluded.total === 0)
    return posts.all.total === 1
      ? `${head} It is still on the site. ${PENDING_CARVE_OUT}`
      : `${head} All ${posts.all.total} are still on the site. ${PENDING_CARVE_OUT}`;
  return (
    `${head} Still on the site: ${posts.visible.total} (${renderSurface(posts.visible)}). ` +
    `No longer on the site: ${posts.excluded.total} (${renderSurface(posts.excluded)}). ` +
    PENDING_CARVE_OUT
  );
}

/**
 * One finding.
 *
 * 🔴 `actioned: false` is a LITERAL, not a parameter and not a default. It is the shadow-mode
 * invariant made unreachable rather than merely unset: a caller cannot pass `true`, so there is no
 * argument, config value or flag anywhere upstream that can turn this run into an acting one. When
 * the operator approves auto-mute, that is a deliberate edit here and in `run.ts`, not a flag flip.
 *
 * `action` is OMITTED rather than set to null — both are accepted by the contract, and omitting it
 * makes the pair unrepresentable in the wrong combination rather than merely correct today.
 *
 * 🔴 `groupKey` IS SUPPLIED, NOT DERIVED HERE. It comes from the clustering heuristic, which owns the
 * one predicate deciding whether a cluster is large enough to be named — the same predicate that
 * decides whether the domain appears in the reason text. Re-deriving it here would be a second copy
 * of that rule, and the two would disagree the first time either boundary moved. Defaulting to
 * `null` keeps every existing caller (and the two other detectors on this board) unchanged.
 */
export function buildFinding(
  member: BotAccountCohortMember,
  score: BotAccountScore,
  observedAt: Date,
  groupKey: string | null = null
): AbuseFinding {
  // Floored at zero: an account timestamped after the scan instant is clock skew between the app and
  // the database, not a negative age, and a negative figure in the reason reads as corrupt data.
  const ageHours = Math.max(0, (observedAt.getTime() - member.createdAt.getTime()) / 3_600_000);
  // 🔴 THE NOTES ARE THE ONLY PART A MODERATOR CAN ACT ON, AND THEY ARE NOW THE ONLY PART OF THE
  // SCORING THAT REACHES THE SENTENCE. Each clause says what a signal SAW — the cluster sizes, the
  // posting rate, the shared filename — which is the half a human can check. It is omitted entirely
  // when nothing fired rather than rendered as an empty clause.
  const notes = renderNotes(score.subScores);
  // 🔴 THE `id=0.00` PER-HEURISTIC DUMP IS GONE FROM THE PROSE, AND THE NUMBERS ARE NOT.
  //
  // The reason used to end `Per-heuristic: posting-velocity=0.00, registration-cluster=0.00,
  // content-templating=1.00, asset-staging=1.00. Blended confidence 0.50.` — machine syntax on the
  // one string the board describes as "the whole value of the row to a moderator", and the part a
  // non-technical reader stops at. Measured on the fixture in
  // `src/server/services/__tests__/abuse-detector-reason-prose.test.ts` — one account, four
  // registered heuristics, three of them carrying notes — the reason went from 690 characters to
  // 516: this clause accounts for 110 of the 174 saved and the enumeration that moved to
  // `POST_COUNT_LEGEND` for the rest. A production finding with longer notes ran longer than the
  // fixture does. (516 and not 464: the scan-pending caveat was kept on the row rather than moved
  // to the summary, because one of the two surfaces that renders a reason shows no summary at all —
  // see `PENDING_CARVE_OUT`.)
  //
  // WHERE THE NUMBERS WENT, because they are load-bearing for grading and deleting them was not on
  // the table: `heuristic:<id>:score_sum` in the run counters, added beside the `evaluated`/`fired`/
  // `clamped` trio that was already there (see `heuristicCounters`). That is the record a grading
  // pass already reads — `abuse_detection_run.counters`, rendered key by key on the run page — and
  // the sum against `evaluated` gives the mean sub-score per heuristic per run, which is the "how
  // hard does this fire" half that NO counter carried before: all three existing ones are COUNTS, so
  // the only place a magnitude appeared was this dumped clause.
  //
  // ⚠️ WHAT THE MOVE COSTS, said plainly rather than left for someone to discover: per-ACCOUNT
  // sub-scores no longer leave this process. The wire contract has no structured field on a finding
  // (`packages/civitai-moderation/src/schema.ts` — userId, confidence, reason, actioned, action,
  // groupKey and nothing else), so the only alternatives were the prose or a per-account counter key,
  // and the latter is 4 keys × up to `MAX_COHORT_ACCOUNTS` rows into a jsonb column the page renders
  // one key per line. The per-account signal that survives is `confidence`, which is a first-class
  // column on the board, plus the notes above.
  //
  // `Blended confidence` went with it: the board renders `confidence` as its own column beside the
  // reason cell, so the sentence was restating a number the reader is already looking at, in
  // vocabulary ("blended") that means something only to whoever wrote the blend.
  const body =
    `Account ${member.userId}` +
    `${member.username ? ` (${member.username})` : ''} registered ` +
    `${member.createdAt.toISOString()}, ${ageHours.toFixed(1)}h old at scan. ` +
    `${renderPostCounts(member.posts)} ` +
    `${notes ? `Signals — ${notes}. ` : ''}`;
  // 🔴 LAST, AND IN THE WORDS `new-order-abuse-detection` ALREADY USED. It used to LEAD, as
  // "Shadow-mode observation — NOT actioned." — a phrase naming an internal rollout phase, in the
  // position a reader skips. Shared from `../abuse-report-prose` so the two producers cannot drift
  // back apart. Unconditional here because this producer holds no write client at all:
  // `actioned: false` is a literal in the object below, not a parameter.
  //
  // 🔴 ITS BUDGET IS RESERVED, NOT TRIMMED — MOVING IT TO THE END PUT IT IN THE CUT ZONE.
  // `truncateReason` keeps a PREFIX, so the last clause is the first thing it drops. While this
  // sentence LED it survived truncation for free; appended naively it would vanish from exactly the
  // findings that ran long, and those are not hypothetical — `member.username` is unbounded and the
  // notes carry a sampled filename, which is why `truncateReason` exists at all. So the body is
  // trimmed against a budget that already excludes this sentence, and the sentence is concatenated
  // afterwards. Same shape as `buildReports`, which reserves its batch wording for the same reason.
  const reason = truncateReason(body, MAX_REASON_LENGTH - NO_ACTION_TAKEN.length) + NO_ACTION_TAKEN;
  return {
    userId: member.userId,
    confidence: score.confidence,
    reason,
    actioned: false,
    // Spread rather than `groupKey: groupKey ?? undefined`, for the same reason `action` is omitted
    // above: an ungrouped finding carries no key at all, so "no cluster" is unrepresentable as
    // anything other than an absent field.
    //
    // 🔴 BOUNDED HERE, beside `truncateReason` and for the identical reason — this is the single
    // place a finding is constructed, so every producer-supplied string the contract caps is brought
    // inside its cap at one choke point rather than at each site that mints one.
    ...(groupKey === null ? {} : { groupKey: boundGroupKey(groupKey) }),
  };
}

/** Fixed-size slices, in order. A separate function because the boundary is the interesting part and
 *  a loop inlined into the report builder cannot be exercised on its own. */
export function chunkFindings<T>(findings: T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  // One batch, empty, rather than none: a run that found nothing must still reach the board. "No
  // report today" and "a report with zero findings" are the same picture to a reader otherwise, and
  // the first is what a broken producer looks like.
  if (!findings.length) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < findings.length; i += size) out.push(findings.slice(i, i + size));
  return out;
}

export type BuildReportsArgs = {
  findings: AbuseFinding[];
  /** The producer's clock at the start of the run. */
  startedAt: Date;
  /** The producer's clock when scoring finished. */
  finishedAt: Date;
  /** Run-level counters. Merged under the per-heuristic ones, which are namespaced. */
  counters: Record<string, number>;
  /** Sentence prefix describing the cohort — batch wording is appended per report. */
  summary: string;
  detector?: string;
  maxFindingsPerReport?: number;
};

/**
 * Split a run into the reports the endpoint will accept.
 *
 * 🔴 THE BATCH TIMESTAMPS ARE OFFSET ON PURPOSE, AND SKIPPING THAT LOSES DATA SILENTLY.
 * `(detector, started_at)` is the receiving table's IDEMPOTENCY KEY: re-reporting the same pair does
 * not append, it REPLACES the run and DELETES its previous findings (see
 * `apps/moderator/src/lib/server/abuse-detection.service.ts`, and the unique index in
 * `apps/moderator/abuse-detection/schema.sql`). That behaviour is correct and load-bearing — it is
 * what makes a retried POST safe — but it means two batches of ONE run sharing a `startedAt` would
 * see the second overwrite the first, and the board would show the last 1,000 findings of a 2,500
 * finding run with nothing to indicate the other 1,500 ever arrived.
 *
 * So batch `k` is stamped `startedAt + k ms`. The offset is synthetic and it is bounded by the batch
 * count in milliseconds; it is not a measurement, and it is the smallest change that makes the key
 * unique while keeping the batches contiguous and correctly ordered on a board that sorts by
 * `started_at`.
 *
 * 🔴 `finishedAt` is floored at each batch's own `startedAt`. Without it a run fast enough to finish
 * inside `batchCount` milliseconds emits `finishedAt < startedAt` on a later batch, which the wire
 * contract refuses outright ("finishedAt is before startedAt") — losing a whole report to the run
 * having been quick.
 */
export function buildReports(args: BuildReportsArgs): AbuseReportInput[] {
  const detector = args.detector ?? BOT_ACCOUNT_DETECTOR;
  const size = args.maxFindingsPerReport ?? MAX_FINDINGS_PER_REPORT;
  const batches = chunkFindings(args.findings, size);

  return batches.map((batch, index) => {
    const startedAt = new Date(args.startedAt.getTime() + index);
    const finishedAt = new Date(Math.max(args.finishedAt.getTime(), startedAt.getTime()));
    // 🔴 THE BATCH WORDING IS BUILT FIRST AND SUBTRACTED FROM THE BUDGET, so it is the CALLER's
    // sentence that gets cut and never this. "Batch 2 of 3" and "nothing was muted" are the two
    // facts a reader cannot reconstruct from anywhere else on the row.
    const batchWording =
      ` Batch ${index + 1} of ${batches.length}; ` +
      `${batch.length} ${plural(batch.length, 'finding')} in this report, ` +
      `${args.findings.length} in the run. ` +
      `Nothing was muted, banned or restricted by this scan.`;
    return {
      detector,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      summary: `${truncateSummary(
        args.summary,
        MAX_SUMMARY_LENGTH - batchWording.length
      )}${batchWording}`,
      counters: {
        ...args.counters,
        batch_index: index + 1,
        batch_count: batches.length,
        batch_findings: batch.length,
        run_findings: args.findings.length,
      },
      findings: batch,
    };
  });
}
