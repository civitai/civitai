import { createHash } from 'crypto';
import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import type { BotAccountCohortMember, SurfaceCounts } from './cohort';
import { renderNotes, renderSubScores, type BotAccountScore } from './scoring';

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
 * 🔴 A reason over the contract's limit does not lose the finding, it 400s the REPORT and loses
 * every finding in the batch. So it is truncated here rather than left to fail, and the ellipsis is
 * the record that something was cut. Reason text is generated from bounded facts plus a username and
 * a per-heuristic list, both of which can grow.
 */
export function truncateReason(reason: string, max = MAX_REASON_LENGTH): string {
  if (reason.length <= max) return reason;
  return `${reason.slice(0, max - 1)}…`;
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
 * email domain yields a 251-character key and the whole report is refused (boundary: 193 characters
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

/** `3 comment(s), 0 model(s), 40 image(s)` — the per-surface breakdown, spelled one way. */
const renderSurface = (s: SurfaceCounts) =>
  `${s.comments} comment(s), ${s.models} model(s), ${s.images} image(s)`;

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
 * 🔴 "STILL ON THE SITE", NOT "VISIBLE". `cohort.ts` deliberately counts an image whose scan has
 * not finished (`ingestion: Pending`) as on-site, which is exactly the case a moderator cannot view
 * yet — so calling that number "visible" claimed something the query does not deliver. The carve-out
 * is stated in BOTH branches, rather than left to a reader who would have no way to know.
 *
 * 🔴 THE NOTHING-EXCLUDED BRANCH NEEDS THE CARVE-OUT MOST, and used to be the one branch without it.
 * `imageCountArgs` keeps `ingestion: Pending`, so a twenty-minute-old account whose three uploads are
 * all attached and all awaiting a scan has `excluded.total === 0` and takes this branch — and this is
 * the modal shape of the population this detector exists to find, precisely because nothing has been
 * actioned yet. "All 3 still on the site" then sent a moderator to look at three items none of which
 * they can view. Same over-claim the word "visible" was removed for, surviving in the commoner half.
 */
const PENDING_CARVE_OUT = 'Images still awaiting a scan result are counted as on the site.';

export function renderPostCounts(posts: BotAccountCohortMember['posts']): string {
  const head = `Posted ${posts.all.total} item(s) — ${renderSurface(posts.all)}.`;
  if (posts.excluded.total === 0)
    return (
      `${head} All ${posts.all.total} still on the site (nothing hidden, blocked, unpublished or ` +
      `removed). ${PENDING_CARVE_OUT}`
    );
  return (
    `${head} Still on the site: ${posts.visible.total} (${renderSurface(posts.visible)}). ` +
    `NOT on the site: ${posts.excluded.total} (${renderSurface(posts.excluded)}) — drafts, ` +
    `unpublished or scheduled models, unattached uploads, uploads the scanner blocked or could not ` +
    `find, and hidden, TOS-flagged or already-removed content. ${PENDING_CARVE_OUT}`
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
  // 🔴 THE NOTES ARE THE ONLY PART A MODERATOR CAN ACT ON. `Per-heuristic: a=0.60, b=0.00` says
  // which signal fired and nothing about WHAT IT SAW — so the clause below carries the cluster
  // sizes, the posting rate and the shared text, and it is placed BEFORE the numbers because it is
  // the part that gets read. It is omitted entirely when nothing fired rather than rendered as an
  // empty clause; that is the case where the numbers alone are the whole story.
  const notes = renderNotes(score.subScores);
  const reason = truncateReason(
    `Shadow-mode observation — NOT actioned. Account ${member.userId}` +
      `${member.username ? ` (${member.username})` : ''} registered ` +
      `${member.createdAt.toISOString()}, ${ageHours.toFixed(1)}h old at scan. ` +
      `${renderPostCounts(member.posts)} ` +
      `${notes ? `Signals — ${notes}. ` : ''}` +
      `Per-heuristic: ${renderSubScores(score.subScores)}. ` +
      `Blended confidence ${score.confidence.toFixed(2)}.`
  );
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
    return {
      detector,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      summary:
        `${args.summary} Batch ${index + 1} of ${batches.length}; ` +
        `${batch.length} finding(s) in this report, ${args.findings.length} in the run. ` +
        `SHADOW MODE: nothing was muted, banned or restricted.`,
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
