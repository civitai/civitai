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
  MAX_FILENAME_SAMPLES,
  MAX_STAGED_IMAGE_SAMPLES,
  collectCohortSignals,
  emptyCohortSignals,
  type EvidenceReader,
} from './evidence';
import { FILENAME_FINGERPRINT_PREFIX } from './fingerprint-keys';
import {
  ASSET_STAGING_ID,
  BOT_ACCOUNT_HEURISTICS,
  CONTENT_TEMPLATING_ID,
  assetStagingHalfScores,
  contentTemplatingSourceScore,
  isCommonEmailDomain,
  registrationClusterGroupKey,
} from './heuristics';
import { BOT_ACCOUNT_DETECTOR, buildFinding, buildReports } from './report';
import {
  MIN_REPORTED_CONFIDENCE,
  confidenceBucketCounters,
  heuristicCounters,
  partitionByConfidence,
  scoreAccount,
  soleSignalCounters,
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
   * The cohort-level sources — registration IPs, uploaded filenames and staged images.
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
  /** Ceiling on image rows read for the templating heuristic. Defaults to `MAX_FILENAME_SAMPLES`.
   *  Its own budget, not a share of any other — see that constant. */
  maxFilenameSamples?: number;
  /** Ceiling on image rows read for the `asset-staging` heuristic. Defaults to
   *  `MAX_STAGED_IMAGE_SAMPLES`. Its own budget, not a share of the filename one. */
  maxStagedImageSamples?: number;
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
  const maxFilenameSamples = options.maxFilenameSamples ?? MAX_FILENAME_SAMPLES;
  const maxStagedImageSamples = options.maxStagedImageSamples ?? MAX_STAGED_IMAGE_SAMPLES;
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
        maxFilenameSamples,
        maxStagedImageSamples,
        // The run's own clock as the filename read's upper bound, so the sample is a snapshot of
        // the window rather than drifting with whatever was uploaded while the run walked.
        createdBefore: startedAt,
        // The window this run already computed, handed to the ClickHouse read as its `time` bound.
        // Every cohort account was created after it, so it prunes the scan without removing a row
        // the query wants.
        createdAfter,
        checkCanceled,
        log,
      })
    : emptyCohortSignals();
  log('bot-account-detection:signals', {
    registrationIps: signals.sources.registrationIps,
    distinctIps: signals.membersPerIp.size,
    distinctDomains: signals.membersPerDomain.size,
    distinctFingerprints: signals.membersPerFingerprint.size,
    filenameSamples: signals.sources.filenameSamples,
    filenameBudgetExhausted: signals.sources.filenameBudgetExhausted,
    membersSampledForFilenames: signals.sources.membersSampledForFilenames,
    stagedImages: signals.sources.stagedImages,
    stagedImageBudgetExhausted: signals.sources.stagedImageBudgetExhausted,
    membersSampledForStagedImages: signals.sources.membersSampledForStagedImages,
    membersWithStagedImages: signals.stagedImagesByUser.size,
    // The failure half, beside the availability half. A reader of this line could previously see
    // `filenameSamples: false` and not know whether a read had broken or a client was absent.
    readFailures: signals.sources.readFailures,
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
  const findings = reported.map((score) => {
    // Every score was built from a member, so the lookup cannot miss; the non-null assertion would
    // be the only place in this module where a missing key is silent, so it throws instead.
    const member = mustGet(memberById, score.userId);
    // 🔴 THE SAME `signals` THE SCORING SAW. A key derived from a different index — an empty one, or
    // one rebuilt here — would group findings by something the reason text does not describe, which
    // is the disclosure rule broken by accident rather than by design.
    return buildFinding(member, score, startedAt, registrationClusterGroupKey(member, signals));
  });

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

  // 🔴 THE DOMAIN LIST'S OWN BLIND SPOT, AS A NUMBER. `COMMON_EMAIL_DOMAINS` scores a member's
  // domain half at 0 by construction, so a real ring that registered on a listed provider is
  // invisible to the clustering heuristic and to every counter that reads its score. This is how
  // many members that applied to — the SIZE of the blind spot, which is the most the shadow phase
  // can measure; it cannot say how many of them were a ring. It was asserted in a code comment
  // before it existed anywhere, which is the failure mode the comment was warning about.
  const domainsSuppressed = cohort.members.filter(
    (m) => m.emailDomain !== null && isCommonEmailDomain(m.emailDomain)
  ).length;

  /** Distinct cluster keys from ONE fingerprint source. See the counters below for why the two are
   *  never summed into a single series. */
  const distinctFingerprints = (prefix: string) => {
    let n = 0;
    for (const key of signals.membersPerFingerprint.keys()) if (key.startsWith(prefix)) n += 1;
    return n;
  };

  // 🔴 WHICH SOURCE OF `content-templating` FIRED. `heuristic:content-templating:fired` does not say
  // WHICH fingerprint source produced a score, and the shadow phase's whole question of a signal is
  // whether IT, specifically, is earning its place. The deleted comment source fired zero times
  // across every run it shipped in while that was invisible inside a single counter; this is what
  // makes the same failure visible for the next source folded in here.
  //
  // 🔴 `fired_text` IS GONE, AND ITS ABSENCE IS THE INTENDED, VISIBLE SIGNAL. The comment source it
  // counted has been deleted, so the key will never appear in another run's counters. A reader
  // comparing run series across this change sees a key stop rather than go to zero — which is the
  // honest shape, because a zero would assert the source was read and found nothing.
  //
  // 🔴 AND TODAY IT CANNOT DIVERGE FROM `fired`. THAT IS NOT A CAVEAT, IT IS THE READING
  // INSTRUCTION. `fired` counts scored members whose `content-templating` sub-score is above zero
  // across EVERY namespace in the index; this counts the same members across `file:` alone, over the
  // same population (`scores` is `cohort.members` mapped one-to-one). With the comment source
  // deleted the index carries exactly ONE namespace — `evidence.test.ts` pins every key in
  // `membersPerFingerprint` and `fingerprintsByUser` as `file:`-prefixed — so the prefix filter
  // rejects nothing and the two counters are EQUAL BY CONSTRUCTION on every run, not merely equal so
  // far. An operator charting the pair gets two identical lines, and reading that agreement as the
  // decomposition being exercised is the exact error this paragraph exists to stop: the lines agree
  // by arithmetic, and they would agree just as perfectly if the decomposition were broken.
  //
  // WHAT MAKES IT INFORMATIVE AGAIN, stated as a trigger rather than as a hope: the first run whose
  // index carries a SECOND namespace. From that run `fired` counts both sources and this one counts
  // `file:`, and the gap between them is the new source's own contribution — with no change to this
  // code. `evidence.test.ts` fails the moment a second `*_FINGERPRINT_PREFIX` is declared in
  // `fingerprint-keys.ts`, which is where that contract lives, so this paragraph is made to expire
  // rather than left to rot.
  //
  // 🔴 WHY IT IS KEPT RATHER THAN DELETED UNTIL THEN, given it measures nothing today. The two
  // sentences above are the whole argument for the counter's PRESENT value and they concede it is
  // nil; what removing it would cost is the module's own convention for a vanishing key, stated in
  // the `fired_text` paragraph above and asserted in `run.test.ts`: a key that stops appearing says
  // THE SOURCE IS NO LONGER READ. `fired_text` stopping says something true; `fired_filename`
  // stopping would say the filename source went dark, on a run where it is the only source there
  // is — a false statement on the surface that renders these (`abuse_detection_run.counters`,
  // listed key by key on the run page), and the opposite of what its absence would mean.
  const firedFromSource = (prefix: string) =>
    cohort.members.filter((m) => contentTemplatingSourceScore(m.userId, signals, prefix) > 0)
      .length;

  // 🔴 WHICH HALF OF `asset-staging` FIRED — the same decomposition, for the same reason. That
  // heuristic answers two questions about one source (how many staged uploads, and how concentrated
  // in time), and `heuristic:asset-staging:fired` cannot say which of them is earning its place.
  //
  // 🔴 THIS COMMENT USED TO NAME A QUESTION THESE COUNTERS CAN NO LONGER ANSWER, AND THE CORRECTION
  // MATTERS BECAUSE THE OLD SENTENCE READ AS COVERAGE. It said they were here to settle "whether the
  // same-second half ever fires on an account the volume half did not already carry". Since the
  // firing point moved to two that has a known answer — NEVER. `fired_burst > 0 && fired_volume == 0`
  // is unreachable, so a run reporting it is a defect in the evidence fold, not a finding about
  // accounts. Leaving the old sentence would have had someone watch a counter for a signal that
  // cannot arrive and read its silence as an answer.
  //
  // 🔴 WHY IT IS UNREACHABLE, AND UNDER WHAT CONDITION, IS ON `BURST_ONE_AT` — DO NOT RE-DERIVE IT
  // FROM THE CONSTANTS HERE. This comment used to, and the derivation it carried ("the two halves
  // share boundaries") went stale the moment the volume boundary moved. So did the copy on the
  // constants — both said it, both were wrong, both had to be rewritten, which is the argument for
  // one derivation in one place rather than a claim that the other copy fared better.
  //
  // WHAT THEY CAN STILL SETTLE, which is why they are kept: `fired_burst` is the population of
  // accounts whose staged uploads arrived in one batch, and the question is whether THAT population
  // is actioned at a different rate than the accounts carried by volume alone. That is a grading
  // question over outcomes, answered by joining these counters to moderation results — not by
  // either counter on its own. If the answer is "no different", the burst arm has no reason to
  // exist and the honest edit is to delete it.
  //
  // 🔴 IF IT SEPARATES, TIGHTENING `BURST_ONE_AT` IS NOT THE FIX — AND THIS PARAGRAPH SAID IT WAS
  // UNTIL THE VOLUME RAMP BECAME A STEP. Such an edit changes no SCORE. It is not silent, though,
  // and saying "it ships green" would send someone to read a guard firing as designed as an
  // unrelated break: the two assertions that read the burst half AT 0.5 go red, which is exactly
  // what they are for. (Other assertions read that half at 0 or 1 and are unmoved — the qualifier
  // is what makes the count right.) What reviving the arm takes instead is on `BURST_ONE_AT` and on
  // the `max` in `assetStagingHeuristic`.
  //
  // Counted over EVERY scored member, matching `fired`'s own population. They may sum to MORE than
  // `fired` — an account can be both, and attributing it to whichever won a `>` comparison would
  // invent a tie-break the data does not support.
  const stagedHalfFired = (half: 'volume' | 'burst') =>
    cohort.members.filter((m) => assetStagingHalfScores(m.userId, signals)[half] > 0).length;

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
    evidence_distinct_registration_ips: signals.membersPerIp.size,
    evidence_distinct_email_domains: signals.membersPerDomain.size,
    // 🔴 COUNTED PER NAMESPACE, NOT AS `membersPerFingerprint.size`, even though one source makes
    // the two equal today. The bare size silently redefines this series the moment a second source
    // is folded in: a run whose count jumped from 3 to 4,000 would read as an explosion of filename
    // sharing on the day the new source shipped. Separate questions get separate keys.
    //
    // 🔴 `evidence_distinct_content_fingerprints` IS GONE with the comment source it counted, for
    // the reason `fired_text` is — a key that stops appearing says "not read any more"; a key
    // reporting 0 would assert the source was read and found nothing.
    evidence_distinct_filename_fingerprints: distinctFingerprints(FILENAME_FINGERPRINT_PREFIX),
    evidence_filename_samples: signals.sources.filenameSamples ? 1 : 0,
    evidence_filename_budget_exhausted: signals.sources.filenameBudgetExhausted ? 1 : 0,
    evidence_members_sampled_for_filenames: signals.sources.membersSampledForFilenames,
    evidence_filename_budget: maxFilenameSamples,

    // The staged-image source, on the same 0/1 terms as the two above and emitted on every run. For
    // `asset-staging` the availability flag matters MORE than it does for the ring heuristics: a
    // zero from this source that nobody read means "these accounts staged nothing", which is a claim
    // about each account's own uploads rather than a weaker version of a claim about a ring.
    evidence_staged_images: signals.sources.stagedImages ? 1 : 0,
    evidence_staged_image_budget_exhausted: signals.sources.stagedImageBudgetExhausted ? 1 : 0,
    evidence_members_sampled_for_staged_images: signals.sources.membersSampledForStagedImages,
    evidence_staged_image_budget: maxStagedImageSamples,
    // How many members had ANY staged upload — the denominator for the heuristic's own rate, and the
    // number that says whether "nobody scored" means the signal is rare or the read is empty.
    evidence_members_with_staged_images: signals.stagedImagesByUser.size,

    // 🔴 THE SOURCE-FAILURE LEDGER. Every other evidence counter above answers "was this heuristic
    // blind", and each of them reads `0` on a quiet day AND on a broken one. That is not a
    // hypothetical: a run shipped whose filename read died on every attempt, and its counters —
    // `evidence_filename_samples: 0`, `evidence_members_sampled_for_filenames: 0`,
    // `evidence_distinct_filename_fingerprints: 0`, `evidence_filename_budget_exhausted: 0` — were
    // number for number the counters of a day on which nobody uploaded anything. The run reported
    // success, the report was filed, nothing alerted, and the only record of the failure was a log
    // line.
    //
    // 🔴 NOTHING READS THIS COUNTER YET, AND CALLING IT "the counter to alert on" WAS THE SAME
    // MISTAKE ONE LEVEL UP. These keys land in `abuse_detection_run.counters`; no consumer anywhere
    // reads that column to alert on, and this change does not add one. What DOES close the loop
    // today is the other two halves of it: the `bot-account-detection:signals` log line above now
    // carries `readFailures` in a structured, queryable payload, and the report summary below now
    // says FAILED rather than "did not run or failed" on a board a moderator already reads. The
    // counter is emitted so a consumer has something to read when one exists. That is its whole
    // present value, and it is written down rather than dressed up as something stronger.
    //
    // 🔴 WHY THE SHAPE IS RIGHT NOW RATHER THAN LATER: it is set ONLY inside a `catch` (see
    // `CohortSignals.sources.readFailures`). No empty cohort, no empty result, no absent ClickHouse
    // client and no exhausted budget can raise it above zero — so `> 0` means a read threw, full
    // stop, and there is no quiet-day reading of a non-zero. Every key here is emitted on every run,
    // zeros included, so an absent key means the producer did not run rather than that nothing
    // broke.
    //
    // 🔴 THE PER-SOURCE KEYS ARE FOR TRIAGE, NOT FOR DISAMBIGUATION. An earlier version of this
    // comment justified them by the total's reassuring default — a run that never got far enough
    // reads as "nothing broke" — and that reasoning does not survive contact with them, since they
    // default to `0` for exactly the same reason and so say nothing the total does not. What they
    // add is WHICH read broke: ClickHouse, the filename read, or the staged-image read. That is the
    // difference between a fix aimed at the right source and a morning spent reading logs.
    //
    // 🔴 `evidence_content_read_failed` IS GONE, and the TOTAL now sums three terms rather than
    // four. A run's total can therefore only fall as a result of this change, never rise — and it
    // could only ever have counted the comment read, which no longer happens.
    evidence_source_read_failures:
      (signals.sources.readFailures.registrationIps ? 1 : 0) +
      (signals.sources.readFailures.filenameSamples ? 1 : 0) +
      (signals.sources.readFailures.stagedImages ? 1 : 0),
    evidence_registration_ips_read_failed: signals.sources.readFailures.registrationIps ? 1 : 0,
    evidence_filename_read_failed: signals.sources.readFailures.filenameSamples ? 1 : 0,
    evidence_staged_image_read_failed: signals.sources.readFailures.stagedImages ? 1 : 0,

    domains_suppressed_common: domainsSuppressed,

    ...heuristicCounters(scores),
    [`heuristic:${CONTENT_TEMPLATING_ID}:fired_filename`]: firedFromSource(
      FILENAME_FINGERPRINT_PREFIX
    ),
    [`heuristic:${ASSET_STAGING_ID}:fired_volume`]: stagedHalfFired('volume'),
    [`heuristic:${ASSET_STAGING_ID}:fired_burst`]: stagedHalfFired('burst'),
    // Over EVERY scored member, not only the reported ones — see `confidenceBucketCounters`.
    ...confidenceBucketCounters(scores),
    // Over the REPORTED members only: which findings rest on ONE heuristic and nothing else. See
    // `soleSignalCounters` — this is what a known collision shows up as, and it is not visible in
    // `fired`. 🔴 THE COLLISION THIS LINE USED TO NAME — a generation-parameter paste matching
    // itself under `content-templating` — IS RETRACTED: it depended on the deleted comment source
    // and on a digit masking the filename fingerprinter deliberately does not apply, so it cannot
    // occur. The reachable one is a generic filename several unrelated new accounts happen to share;
    // `soleSignalCounters` carries the worked arithmetic.
    ...soleSignalCounters(reported, heuristics),
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
    // 🔴 THE CUT IS RENDERED EXACTLY, NOT TO TWO PLACES. `toFixed(2)` printed the default threshold
    // as `0.11` once it was re-derived to 0.1125 for a four-heuristic registry — a summary stating a
    // looser cut than the one it applied, in the sentence a human reads to know what they are
    // looking at. Four places with the trailing zeros trimmed renders 0.15 as `0.15` and 0.1125 as
    // `0.1125`, and keeps an operator-supplied `1/3` from spilling seventeen digits.
    ` ${reported.length} scored at or above the ${String(
      Number(minConfidence.toFixed(4))
    )} reporting threshold and ` +
    `appear below; ${suppressed.length} scored under it and are counted in the ` +
    `confidence_bucket_* counters but NOT reported as findings.` +
    // Two of three heuristics are ring detectors and both can go dark. Saying so in the summary
    // stops a reader treating a low-confidence run as evidence that no ring existed.
    (signals.sources.registrationIps
      ? ''
      : ` 🔴 REGISTRATION-IP DATA WAS UNAVAILABLE this run` +
        (signals.sources.readFailures.registrationIps
          ? ` BECAUSE THE READ FAILED (counted in evidence_source_read_failures)`
          : ``) +
        `, so the clustering heuristic scored on email domain alone — a low score from it is not ` +
        `evidence that accounts share no IP.`) +
    // 🔴 THE READ RAN AND MATCHED NOTHING — the case the availability flag alone cannot express.
    // `evidence_registration_ips: 1` with `evidence_distinct_registration_ips: 0` over a non-empty
    // cohort is the signature of a query that is wrong rather than of a day with no shared
    // addresses: a changed column name, a moved table, an over-tight filter. The counters already
    // carry both numbers; a human reading the summary had nothing, and this is the reader who would
    // recognise it.
    (signals.sources.registrationIps && signals.membersPerIp.size === 0 && cohort.members.length > 0
      ? ` 🔴 THE REGISTRATION-IP READ RAN AND MATCHED NOTHING for any of the ` +
        `${cohort.members.length} member(s). That is possible on a quiet day, and it is also what a ` +
        `wrong column, a moved table or an over-tight filter looks like — the two are not ` +
        `distinguishable from this run alone.`
      : '') +
    // `content-templating`'s source gets its own disclosures: a zero from a source that never ran is
    // not a zero from a source that found nothing, and only these sentences tell a reader which one
    // they are looking at. (The comment-text source had a matching pair of sentences; they went with
    // the source.)
    // 🔴 IT NAMES WHICH OF THE TWO HAPPENED. "did not run or failed" was one sentence covering two
    // situations that call for different actions — one is a deployment without the source wired up,
    // the other is a broken read that needs fixing today — and a reader could not tell them apart
    // from the report OR from the counters. `readFailures` is what separates them.
    (signals.sources.filenameSamples
      ? ''
      : signals.sources.readFailures.filenameSamples
      ? ` 🔴 THE UPLOADED-FILENAME READ FAILED this run and its partial result was discarded, so ` +
        `the content-templating heuristic scored 0 for every member for want ` +
        `of data. That is not evidence that no accounts uploaded files under the same name — it is ` +
        `a broken read, and it is counted in evidence_source_read_failures.`
      : ` 🔴 UPLOADED-FILENAME DATA WAS UNAVAILABLE this run — the read did not run — so the ` +
        `content-templating heuristic scored 0 for every member for want of ` +
        `data. That is not evidence that no accounts uploaded files under the same name.`) +
    (signals.sources.filenameBudgetExhausted
      ? ` 🔴 THE FILENAME SAMPLE BUDGET (${maxFilenameSamples} rows) WAS EXHAUSTED after ` +
        `${signals.sources.membersSampledForFilenames} of ${cohort.members.length} members. ` +
        `Members are sampled newest-first, so the unsampled remainder is the OLDEST end of the ` +
        `window and scored 0 on filename clustering for want of data.`
      : '') +
    // 🔴 THE STAGED-IMAGE SOURCE'S OWN DISCLOSURES, AND THEY SAY SOMETHING STRONGER THAN THE OTHERS.
    // A dead ring source leaves a weaker version of a claim about the cohort; a dead staged-image
    // read leaves `asset-staging` asserting that every account's uploads were published, which is a
    // claim about each account individually and is simply false rather than merely weak. The
    // sentence says so in those terms, and names which of the two happened.
    (signals.sources.stagedImages
      ? ''
      : signals.sources.readFailures.stagedImages
      ? ` 🔴 THE STAGED-IMAGE READ FAILED this run and its partial result was discarded, so the ` +
        `asset-staging heuristic scored 0 for every member for want of data. That is not evidence ` +
        `that these accounts published what they uploaded — it is a broken read, and it is counted ` +
        `in evidence_source_read_failures.`
      : ` 🔴 STAGED-IMAGE DATA WAS UNAVAILABLE this run — the read did not run — so the ` +
        `asset-staging heuristic scored 0 for every member for want of data. That is not evidence ` +
        `that these accounts published what they uploaded.`) +
    (signals.sources.stagedImageBudgetExhausted
      ? ` 🔴 THE STAGED-IMAGE BUDGET (${maxStagedImageSamples} rows) WAS EXHAUSTED after ` +
        `${signals.sources.membersSampledForStagedImages} of ${cohort.members.length} members. ` +
        `Members are sampled newest-first, so the unsampled remainder is the OLDEST end of the ` +
        `window and scored 0 on asset staging for want of data.`
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
