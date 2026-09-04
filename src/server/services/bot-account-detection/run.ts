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
   * 🔴 A run that never asks keeps going after the scheduler has hung up, and this one is on a
   * lock the webhook route releases at `lockExpiration` WHILE the run continues — so an uncanceled
   * overrun is how the same window gets walked twice under two different `startedAt`s, which
   * `(detector, started_at)` cannot merge and the board shows as two complete duplicate sets.
   * Checked once per cohort page and once before each report send: the two places this run can be
   * doing work nobody is waiting for.
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

  const counters: Record<string, number> = {
    window_hours: windowHours,
    cohort_scanned: cohort.scanned,
    cohort_size: cohort.members.length,
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
    `${cohort.members.length} had posted and were scored by ${heuristics.length} heuristic(s).` +
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
