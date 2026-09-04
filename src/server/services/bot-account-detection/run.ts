import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import {
  BOT_ACCOUNT_COHORT_WINDOW_HOURS,
  COHORT_PAGE_SIZE,
  MAX_COHORT_ACCOUNTS,
  cohortCutoff,
  collectCohort,
  type CohortReader,
} from './cohort';
import {
  MAX_CONTENT_SAMPLES,
  collectCohortSignals,
  emptyCohortSignals,
  type EvidenceReader,
} from './evidence';
import { BOT_ACCOUNT_HEURISTICS } from './heuristics';
import { BOT_ACCOUNT_DETECTOR, buildFinding, buildReports } from './report';
import {
  MIN_REPORTED_CONFIDENCE,
  confidenceBucketCounters,
  heuristicCounters,
  partitionByConfidence,
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
  /**
   * The cohort-level sources — registration IPs and content samples.
   *
   * Optional, and its absence is a REAL state rather than a test affordance: a run without it scores
   * the velocity heuristic normally and the two ring heuristics against an empty index. That is why
   * `emptyCohortSignals()` sets both source flags to "did not run" — so the counters say the ring
   * heuristics had no data, instead of the run reporting that nobody shared anything.
   */
  evidence?: EvidenceReader;
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
  /**
   * The confidence at or above which a scored member becomes a finding. Defaults to
   * `MIN_REPORTED_CONFIDENCE`.
   *
   * 🔴 IT FILTERS REPORTING, NEVER SCORING. Every cohort member is scored and lands in the
   * distribution counters whatever this is set to; the only thing it decides is whether a moderator
   * sees a row. Setting it to 0 restores the previous behaviour — every member reported — and is
   * how a deliberate full-cohort grading run is requested, rather than something that happens by
   * default on a live board.
   */
  minConfidence?: number;
  /** Ceiling on content rows read for the templating heuristic. Defaults to `MAX_CONTENT_SAMPLES`. */
  maxContentSamples?: number;
};

export type BotAccountDetectionResult = {
  detector: string;
  /** Accounts read from the window, before the has-posted filter. */
  scanned: number;
  /**
   * Accounts that made the cohort and were SCORED.
   *
   * 🔴 NO LONGER THE NUMBER OF FINDINGS. It was, while every member became one; the threshold broke
   * that identity and the two names are kept apart deliberately so a caller cannot read a cohort
   * size as a finding count.
   */
  cohortSize: number;
  /** Members at or above the threshold — the rows a moderator actually receives. */
  findingsReported: number;
  /** Members scored BELOW the threshold. Never zero-by-omission: this is the number that makes a
   *  small finding count readable. */
  findingsSuppressed: number;
  /** The threshold this run applied. */
  minConfidence: number;
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

/** A map lookup that cannot fail silently. The alternative — `map.get(k)!` — turns a broken
 *  invariant into `undefined` flowing into a reason string as "Account undefined". */
function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined)
    throw new Error(`bot-account-detection: no cohort member for scored id ${String(key)}`);
  return value;
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
  const minConfidence = options.minConfidence ?? MIN_REPORTED_CONFIDENCE;
  const maxContentSamples = options.maxContentSamples ?? MAX_CONTENT_SAMPLES;
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

  // The cohort-level indexes, read once for the whole run. Without an evidence reader the ring
  // heuristics score against an empty index whose source flags say "did not run" — which the
  // counters below publish, so a run with no evidence source is never mistaken for a run that found
  // no rings.
  const signals = deps.evidence
    ? await collectCohortSignals(deps.evidence, cohort.members, {
        chunkSize: pageSize,
        maxContentSamples,
        checkCanceled,
        log,
      })
    : emptyCohortSignals();
  log('bot-account-detection:signals', {
    registrationIps: signals.sources.registrationIps,
    contentBudgetExhausted: signals.sources.contentBudgetExhausted,
    membersSampledForContent: signals.sources.membersSampledForContent,
    distinctIps: signals.membersPerIp.size,
    distinctDomains: signals.membersPerDomain.size,
    distinctFingerprints: signals.membersPerFingerprint.size,
  });

  const memberById = new Map(cohort.members.map((m) => [m.userId, m]));
  const scores = cohort.members.map((member) =>
    scoreAccount(heuristics, { member, now: startedAt, signals })
  );

  // 🔴 THE THRESHOLD, APPLIED HERE AND NOWHERE ELSE. Every member above was scored; only the
  // reported half becomes a finding. The suppressed half is still counted, bucketed and summarised
  // below — a member nobody can see is a member nobody can grade, and grading is the entire purpose
  // of the shadow phase.
  const { reported, suppressed } = partitionByConfidence(scores, minConfidence);
  const findings = reported.map((score) =>
    // Every score was built from a member, so the lookup cannot miss; the non-null assertion would
    // be the only place in this module where a missing key is silent, so it throws instead.
    buildFinding(mustGet(memberById, score.userId), score, startedAt)
  );

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

    // 🔴 THE SUPPRESSION LEDGER. `findings_reported` on its own is the reassuring number this
    // project keeps being burned by — "12 findings" reads as a quiet day whether the cohort was
    // twelve accounts or the whole day's signups. The pair, plus the threshold that produced it,
    // plus the full distribution below, is what makes a small number readable. All emitted every
    // run, zeros included.
    findings_reported: reported.length,
    findings_suppressed: suppressed.length,
    // A float, which the contract's `z.record(z.string(), z.number())` accepts. Recorded because a
    // distribution is uninterpretable without the cut that was applied to it, and the cut is
    // configurable.
    report_min_confidence: minConfidence,

    // 🔴 EVIDENCE AVAILABILITY, AS 0/1 ON EVERY RUN. Two of the three heuristics score 0 when their
    // source is missing, which is byte-identical to scoring 0 because nothing was found. These are
    // the only things that tell the two apart, so a grading pass can exclude the runs whose ring
    // heuristics were blind rather than averaging them in as evidence of no rings.
    evidence_registration_ips: signals.sources.registrationIps ? 1 : 0,
    evidence_content_budget_exhausted: signals.sources.contentBudgetExhausted ? 1 : 0,
    evidence_members_sampled_for_content: signals.sources.membersSampledForContent,
    evidence_content_budget: maxContentSamples,
    evidence_distinct_registration_ips: signals.membersPerIp.size,
    evidence_distinct_email_domains: signals.membersPerDomain.size,
    evidence_distinct_content_fingerprints: signals.membersPerFingerprint.size,

    ...heuristicCounters(scores),
    // Over EVERY scored member, not only the reported ones — see `confidenceBucketCounters`.
    ...confidenceBucketCounters(scores),
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
    // 🔴 THE SUPPRESSION SENTENCE. The counters carry this too, but the summary is what a human
    // reads first, and a finding count with no denominator beside it is the shape of every
    // reassuring zero this detector was built to avoid producing.
    ` ${reported.length} scored at or above the ${minConfidence.toFixed(
      2
    )} reporting threshold and ` +
    `appear below; ${suppressed.length} scored under it and are counted in the ` +
    `confidence_bucket_* counters but NOT reported as findings.` +
    // Two of three heuristics are ring detectors and both can go dark. Saying so in the summary
    // stops a reader treating a low-confidence run as evidence that no ring existed.
    (signals.sources.registrationIps
      ? ''
      : ` 🔴 REGISTRATION-IP DATA WAS UNAVAILABLE this run, so the clustering heuristic scored on ` +
        `email domain alone — a low score from it is not evidence that accounts share no IP.`) +
    (signals.sources.contentBudgetExhausted
      ? ` 🔴 THE CONTENT SAMPLE BUDGET (${maxContentSamples} rows) WAS EXHAUSTED after ` +
        `${signals.sources.membersSampledForContent} of ${cohort.members.length} members. Members ` +
        `are sampled newest-first, so the unsampled remainder is the OLDEST end of the window and ` +
        `scored 0 on content templating for want of data.`
      : '') +
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
    findingsReported: reported.length,
    findingsSuppressed: suppressed.length,
    minConfidence,
    capped: cohort.capped,
    reports: reports.length,
    reportsSent: sent,
    counters,
  };
}
