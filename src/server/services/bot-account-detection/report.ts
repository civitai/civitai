import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import type { BotAccountCohortMember, SurfaceCounts } from './cohort';
import { renderSubScores, type BotAccountScore } from './scoring';

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
 * is stated in the same sentence rather than left to a reader who would have no way to know.
 */
export function renderPostCounts(posts: BotAccountCohortMember['posts']): string {
  const head = `Posted ${posts.all.total} item(s) — ${renderSurface(posts.all)}.`;
  if (posts.excluded.total === 0)
    return `${head} All ${posts.all.total} still on the site (nothing hidden, blocked, unpublished or removed).`;
  return (
    `${head} Still on the site: ${posts.visible.total} (${renderSurface(posts.visible)}). ` +
    `NOT on the site: ${posts.excluded.total} (${renderSurface(posts.excluded)}) — drafts, ` +
    `unpublished or scheduled models, unattached uploads, uploads the scanner blocked or could not ` +
    `find, and hidden, TOS-flagged or already-removed content. Images still awaiting a scan result ` +
    `are counted as on the site.`
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
 */
export function buildFinding(
  member: BotAccountCohortMember,
  score: BotAccountScore,
  observedAt: Date
): AbuseFinding {
  // Floored at zero: an account timestamped after the scan instant is clock skew between the app and
  // the database, not a negative age, and a negative figure in the reason reads as corrupt data.
  const ageHours = Math.max(0, (observedAt.getTime() - member.createdAt.getTime()) / 3_600_000);
  const reason = truncateReason(
    `Shadow-mode observation — NOT actioned. Account ${member.userId}` +
      `${member.username ? ` (${member.username})` : ''} registered ` +
      `${member.createdAt.toISOString()}, ${ageHours.toFixed(1)}h old at scan. ` +
      `${renderPostCounts(member.posts)} ` +
      `Per-heuristic: ${renderSubScores(score.subScores)}. ` +
      `Blended confidence ${score.confidence.toFixed(2)}.`
  );
  return {
    userId: member.userId,
    confidence: score.confidence,
    reason,
    actioned: false,
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
