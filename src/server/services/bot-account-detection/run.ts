import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import {
  BOT_ACCOUNT_COHORT_WINDOW_HOURS,
  COHORT_PAGE_SIZE,
  MAX_COHORT_ACCOUNTS,
  cohortCutoff,
  collectCohort,
  type CohortReader,
} from './cohort';
import { BOT_ACCOUNT_DETECTOR, buildFinding, buildReports } from './report';
import {
  BOT_ACCOUNT_HEURISTICS,
  heuristicCounters,
  scoreAccount,
  type BotAccountHeuristic,
} from './scoring';

/**
 * The bot-account detector, shadow phase.
 *
 * 🔴 THIS RUN HAS EXACTLY ONE EFFECT: it POSTs reports. It does not mute, ban, exclude, or write a
 * `UserRestriction` row, and it holds no handle that could — its whole database surface is the
 * two-method read port in `cohort.ts`, and its whole outbound surface is `sendReport`. That is the
 * shadow guarantee expressed as reachability rather than as a flag, so there is no configuration
 * under which this run acts.
 *
 * Everything it touches arrives as a dependency, which is also what makes it testable end to end
 * without a database, a network, or a clock.
 */

/** Where a finished report goes. In production this is `moderatorApp.abuseReport`, which validates
 *  against the shared contract before the network call and cannot do anything else. */
export type BotAccountReportSink = (report: AbuseReportInput) => Promise<unknown>;

export type BotAccountDetectionDeps = {
  reader: CohortReader;
  sendReport: BotAccountReportSink;
  /** The producer's clock. Injected, because the report's `startedAt`/`finishedAt` are the producer's
   *  own times and the board's "how current is this" reading depends on them being real. */
  now: () => Date;
  heuristics?: readonly BotAccountHeuristic[];
  /** Structured progress, one call per notable step. Optional so the core has no logger dependency. */
  log?: (name: string, data: Record<string, unknown>) => void;
  /**
   * Throws if the job has been canceled. In production this is `JobContext.checkIfCanceled`.
   *
   * 🔴 WHAT THIS PROTECTS AGAINST IS THE CALLER HANGING UP, and only that. The run-jobs route
   * cancels in exactly one place — `res.on('close')`, which calls `jobRunner.cancel()` — so what
   * this stops is a walk that keeps paging and keeps POSTing after nobody is listening. Checked
   * once per cohort page and once before each report send: the two places this run can be doing
   * work for a closed response.
   *
   * 🔴 IT DOES NOT PROTECT AGAINST LOCK EXPIRY, and reading it that way is how the duplicate-run
   * hazard gets treated as handled. The route's `release()` clears the redis key and the refresh
   * interval; it never touches the job context, so nothing about a lapsed lock makes this throw and
   * the run continues unaware. The mitigation for a second concurrent run under a different
   * `startedAt` is the widened `lockExpiration` on the job — see
   * `~/server/jobs/bot-account-detection.ts` — not this callback.
   */
  checkCanceled?: () => void;
};

export type BotAccountDetectionOptions = {
  windowHours?: number;
  pageSize?: number;
  maxAccounts?: number;
  maxFindingsPerReport?: number;
};

export type BotAccountDetectionResult = {
  detector: string;
  /** Accounts read from the window, before the has-posted filter. */
  scanned: number;
  /** Accounts that made the cohort, i.e. findings. */
  cohortSize: number;
  /** The window held more accounts than the cap allowed the run to read. */
  capped: boolean;
  reports: number;
  reportsSent: number;
  counters: Record<string, number>;
};

/** Thrown when a batch fails to land, carrying how much of the run already did. */
export class BotAccountReportError extends Error {
  constructor(readonly sent: number, readonly total: number, cause: unknown) {
    super(
      `bot-account-detection: report ${sent + 1} of ${total} failed; ${sent} already landed. ` +
        `A retry re-sends the whole run under a NEW startedAt, so the landed batches will ` +
        `duplicate rather than upsert.`,
      { cause }
    );
    this.name = 'BotAccountReportError';
  }
}

export async function runBotAccountDetection(
  deps: BotAccountDetectionDeps,
  options: BotAccountDetectionOptions = {}
): Promise<BotAccountDetectionResult> {
  const heuristics = deps.heuristics ?? BOT_ACCOUNT_HEURISTICS;
  const windowHours = options.windowHours ?? BOT_ACCOUNT_COHORT_WINDOW_HOURS;
  const pageSize = options.pageSize ?? COHORT_PAGE_SIZE;
  const maxAccounts = options.maxAccounts ?? MAX_COHORT_ACCOUNTS;
  const maxFindingsPerReport = options.maxFindingsPerReport ?? MAX_FINDINGS_PER_REPORT;
  const log = deps.log ?? (() => undefined);
  const checkCanceled = deps.checkCanceled ?? (() => undefined);

  const startedAt = deps.now();
  const createdAfter = cohortCutoff(startedAt, windowHours);

  const cohort = await collectCohort(deps.reader, {
    createdAfter,
    pageSize,
    maxAccounts,
    checkCanceled,
  });
  log('bot-account-detection:cohort', {
    scanned: cohort.scanned,
    members: cohort.members.length,
    pages: cohort.pages,
    capped: cohort.capped,
    createdAfter: createdAfter.toISOString(),
  });

  const scores = cohort.members.map((member) =>
    scoreAccount(heuristics, { member, now: startedAt })
  );
  const findings = cohort.members.map((member, i) => buildFinding(member, scores[i], startedAt));

  const finishedAt = deps.now();

  // 🔴 THE COHORT'S OWN BLIND-SPOT COUNTER. Membership is decided on everything an account posted,
  // so an account whose every item was blocked, hidden or removed is now a member — and this is how
  // many of them there were. It is the number that was structurally unobservable while membership
  // ran off the visible count: those accounts were not in the cohort at all, so no counter, no
  // finding and no summary sentence could mention them. Emitted on every run, zero included, so its
  // absence means the producer did not run rather than that the case did not occur.
  const nothingOnSite = cohort.members.filter((m) => m.posts.visible.total === 0).length;
  // Everything the cohort posted, and how much of it has already been taken down. A run-level ratio
  // a grading pass can read without opening a single finding.
  const postedAll = cohort.members.reduce((sum, m) => sum + m.posts.all.total, 0);
  const postedExcluded = cohort.members.reduce((sum, m) => sum + m.posts.excluded.total, 0);

  const counters: Record<string, number> = {
    window_hours: windowHours,
    cohort_scanned: cohort.scanned,
    cohort_size: cohort.members.length,
    cohort_members_nothing_on_site: nothingOnSite,
    cohort_items_posted: postedAll,
    cohort_items_not_on_site: postedExcluded,
    cohort_pages: cohort.pages,
    cohort_cap: maxAccounts,
    // A boolean as 0/1 because the contract's counters are `Record<string, number>`. Emitted on
    // every run, not only when true: a counter that appears only in the bad case cannot be alerted
    // on, because its absence is indistinguishable from the producer not running.
    cohort_capped: cohort.capped ? 1 : 0,
    heuristics_registered: heuristics.length,
    ...heuristicCounters(scores),
  };

  // 🔴 The truncation sentence names WHICH END was dropped. "TRUNCATED at the N-account cap" alone
  // is read as "we saw the first N", and "first" in a signup window means oldest — the opposite of
  // what the walk does. The walk pages newest-first, so what a capped run did NOT read is the
  // oldest tail of the window; saying so is what stops a moderator drawing the backwards
  // conclusion that the newest signups went unexamined.
  const summary =
    `Scanned ${cohort.scanned} account(s) created since ${createdAfter.toISOString()}; ` +
    `${cohort.members.length} had posted something and were scored by ${heuristics.length} ` +
    `heuristic(s). They posted ${postedAll} item(s), of which ${postedExcluded} are no longer on ` +
    `the site; ${nothingOnSite} of the ${cohort.members.length} have nothing left on the site at ` +
    `all. Membership counts everything an account posted, so an account whose uploads were all ` +
    `blocked or removed is included rather than dropped.` +
    (cohort.capped
      ? ` 🔴 TRUNCATED at the ${maxAccounts}-account cap. Accounts are read NEWEST FIRST, so the ` +
        `${cohort.scanned} read are the most recent of the window and the unread remainder is its ` +
        `OLDEST end — the earliest signups of the window were not scored.`
      : '');

  const reports = buildReports({
    findings,
    startedAt,
    finishedAt,
    counters,
    summary,
    maxFindingsPerReport,
  });

  let sent = 0;
  for (const report of reports) {
    checkCanceled();
    try {
      await deps.sendReport(report);
    } catch (e) {
      log('bot-account-detection:report-failed', { sent, total: reports.length });
      throw new BotAccountReportError(sent, reports.length, e);
    }
    sent += 1;
    log('bot-account-detection:report-sent', {
      batch: sent,
      of: reports.length,
      findings: report.findings.length,
      startedAt: report.startedAt,
    });
  }

  return {
    detector: BOT_ACCOUNT_DETECTOR,
    scanned: cohort.scanned,
    cohortSize: cohort.members.length,
    capped: cohort.capped,
    reports: reports.length,
    reportsSent: sent,
    counters,
  };
}
