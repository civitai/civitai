import { createHash } from 'crypto';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { logToAxiom } from '~/server/logging/client';

// ─────────────────────────────────────────────────────────────────────────────
// THE `'textOutput'` MODERATION POLICY — scanning GENERATED text before it
// reaches an App Block.
//
// 🔴 WHY THIS IS A SEPARATE PHASE FROM `runStepModeration`, AND NOT A HANDLER
// IN ITS TABLE. `runStepModeration` runs in the step SUBMIT path
// (`blocks.router.ts` → `submitStepWorkflow`), BEFORE the orchestrator call.
// That position is right for `'promptAudit'`, which audits INPUT the caller
// already sent. An OUTPUT scan placed there has nothing to look at: the
// generation has not happened, `workflow.steps[].output` does not exist, and the
// handler would scan an empty string, return cleanly, and report success — a
// declared, registered, load-time-gated posture that is a NO-OP. So the posture
// declares an OUTPUT-phase handler instead, and `./moderation`'s phase table
// makes "satisfied by a submit handler" structurally impossible rather than a
// thing review has to catch.
//
// 🔴 WHY `createXGuardModerationRequest` AND NOT `submitTextModeration`.
// `submitTextModeration` (`~/server/services/text-moderation.service`) requires
// `entityType` + `entityId` and drives an `EntityModeration` row. Generated
// output has no persistent entity to key on, and that table does not exist in
// every environment this runs in — so that path would fail at runtime here.
// Calling the underlying request builder with `callbackUrl: null` and NO entity
// fields skips the EM upsert, the audit write, and the contentHash dedup (which
// is itself gated on the entity fields) in one step. Verified against the
// function's own branches: every EM/dedup branch is `if (entityType && entityId
// !== undefined)`-gated.
//
// 🔴 SKIPPING THAT DEDUP HAS A COST, AND IT IS PAID BACK HERE RATHER THAN
// IGNORED. `attachModeratedStepTextOutputs` runs on EVERY `pollWorkflow`, at a
// cadence untrusted block code chooses, over content whose length the model
// chooses — so with no dedup and no cap, one generation was an unbounded number
// of unbounded scans. Both are bounded on THIS side now:
// `MAX_SCANNED_CONTENT_CHARS` caps a single scan (fail-CLOSED above it), and the
// in-process verdict memo at the bottom of this file collapses the poll loop's
// repeated scans of identical content.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The labels submitted on EVERY generated-output scan.
 *
 * ALL FIFTEEN ARE SCANNED, INCLUDING THE FIVE NOT ACTED ON. That is a
 * deliberate, owner-approved trade: cost is ~1 unit per label per ~10k-char
 * chunk, so the five non-acting labels add ~5 units to a ~15-unit scan, and the
 * telemetry (which labels generated app output actually trips, per app) is worth
 * more than the saving on a first ring. Whoever later proposes trimming this
 * list should first read the per-label trigger rates this scan produces.
 */
export const TEXT_OUTPUT_SCAN_LABELS: readonly string[] = [
  // ── acted on, host-independent ──
  'Young',
  'Grooming',
  'Sex Trafficking',
  'Exploitation',
  'Bestiality',
  'Extremism',
  'Impersonating Civitai Staff',
  // ── acted on, only when the viewer's maturity ceiling is SFW ──
  'NSFW',
  'Suggestive',
  'Explicit',
  // ── scanned for telemetry, NOT acted on ──
  'Urine',
  'Diaper',
  'Scat',
  'Menstruation',
  'Celebrity',
] as const;

/**
 * Labels that withhold the output REGARDLESS of the viewer's maturity ceiling.
 * A mature-allowed (red) host does not license these.
 */
export const ALWAYS_WITHHOLD_LABELS: readonly string[] = [
  'Young',
  'Grooming',
  'Sex Trafficking',
  'Exploitation',
  'Bestiality',
  'Extremism',
  'Impersonating Civitai Staff',
] as const;

/**
 * Labels that withhold ONLY when the viewer's maturity ceiling is SFW.
 *
 * 🔴 THE SFW-NESS SOURCE IS `resolveBlockMaturity(claims).isGreen` — the block
 * token's SERVER-MINTED `maxBrowsingLevel` ceiling, minted from the request host
 * at issuance. It is the same source `'promptAudit'`, the txt2img path and the
 * customComfy path already use, and it is NEVER a request-body field: a block on
 * a SFW domain cannot opt itself into mature output by sending a flag.
 */
export const SFW_ONLY_WITHHOLD_LABELS: readonly string[] = [
  'NSFW',
  'Suggestive',
  'Explicit',
] as const;

/**
 * Labels scanned but deliberately NOT acted on — recorded here so the set is
 * enumerable and the tests can assert the three sets PARTITION the scan list
 * (no label silently drops out of the policy when someone edits one array).
 */
export const NOT_ACTED_ON_LABELS: readonly string[] = [
  'Urine',
  'Diaper',
  'Scat',
  'Menstruation',
  'Celebrity',
] as const;

/**
 * Normalize a label for comparison.
 *
 * 🔴 CASE-INSENSITIVE ON PURPOSE, AND THAT IS NOT TIDINESS. The label strings
 * that come back on `triggeredLabels` / `results[].label` are orchestrator-side
 * configuration, not a code-owned enum — the debug endpoint's own documented
 * example passes `"labels": ["young"]` while its `labelOverrides` example writes
 * `"label": "Young"`. An exact-match policy would therefore silently match
 * NOTHING for a casing this side does not control, and a policy that matches
 * nothing withholds nothing. Comparing on a normalized key removes a fail-OPEN
 * mode whose only symptom is that everything passes.
 */
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

const ALWAYS_WITHHOLD_KEYS: ReadonlySet<string> = new Set(
  ALWAYS_WITHHOLD_LABELS.map(normalizeLabel)
);
const SFW_ONLY_WITHHOLD_KEYS: ReadonlySet<string> = new Set(
  SFW_ONLY_WITHHOLD_LABELS.map(normalizeLabel)
);

/** The per-label result shape this policy reads off an XGuard scan. */
export type XGuardLabelResultLike = {
  label?: unknown;
  score?: unknown;
  triggered?: unknown;
};

/** The scan output shape this policy reads. */
export type XGuardScanOutputLike = {
  triggeredLabels?: unknown;
  results?: unknown;
};

/** What the policy decided about one scan. */
export type TextOutputScanVerdict = {
  /** True when the text may be released to the block. */
  released: boolean;
  /** The POLICY-ACTIONED labels that triggered. Empty on a release. */
  withholdingLabels: string[];
  /** Every label that triggered, actioned or not — telemetry, not policy. */
  triggeredLabels: string[];
  /** Per-label scores, for the trigger log. */
  scores: Record<string, number>;
  /**
   * 🔴 REQUESTED labels the scan did NOT come back with a result for. NON-EMPTY
   * FORCES A WITHHOLD, regardless of what did come back. See
   * {@link missingRequestedLabels}.
   */
  missingLabels: string[];
};

/**
 * The requested labels the scan produced NO `results[]` entry for.
 *
 * 🔴 THIS CLOSES A FAIL-OPEN THE GENERATED CLIENT DOCUMENTS IN SO MANY WORDS.
 * `types.gen.d.ts` on `xGuardModeration`'s `labels` input: *"Labels not found in
 * the defaults (or label overrides) are silently ignored."* So a renamed or
 * mistyped entry in `TEXT_OUTPUT_SCAN_LABELS` — an orchestrator-side rename this
 * codebase does not control, or a typo in a PR — is never evaluated, comes back
 * absent rather than errored, produces a clean verdict, and RELEASES. There is
 * no symptom: everything simply passes, which is the exact shape
 * `normalizeLabel`'s own comment claims to have removed on the CASING axis and
 * cannot remove on the RENAME axis.
 *
 * The only signal available is the one the scan returns: `results[]` carries one
 * entry per label the scanner actually evaluated. If a label we asked for is not
 * in there, we did not get the answer we asked for, and "no answer" must never
 * read as "clean" — the same rule `screenGeneratedText` already applies to a
 * missing scan output.
 *
 * 🔴 CONSEQUENCE, STATED PLAINLY BECAUSE IT IS SHARP: if the orchestrator ever
 * stops returning per-label results for a label we request, this posture
 * withholds EVERYTHING until someone updates the list. That is loud and
 * fail-closed, which is the correct direction for generated model output on a
 * trust root — and it is the opposite of the current behaviour, which is silent
 * and fail-open. The `stage: 'label-drift'` trigger log is what makes it
 * diagnosable in one query rather than a mystery.
 *
 * Compared on the NORMALIZED key, so a casing difference between what we send
 * and what comes back is not mistaken for a drop.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 PRE-ADOPTION GATE — RUN ONE LIVE PROBE BEFORE THE FIRST `'textOutput'`
 * ENTRY REGISTERS. Do not skip this because the tests are green, and do not
 * weaken the guard to hedge it.
 *
 * THE ASSUMPTION: that the deployed scanner returns a `results[]` entry for
 * EVERY requested label — including the ones that did NOT trigger. The whole
 * guard rests on it, because "requested but absent from `results[]`" is read
 * here as drift.
 *
 * WHY IT IS NOT YET EVIDENCE: the only thing that currently exhibits the shape
 * is this file's own test fixture, which builds `results[]` by mapping over
 * `TEXT_OUTPUT_SCAN_LABELS` — i.e. the fake encodes the same assumption the code
 * does, so the suite cannot disagree with it. That is a both-wrong-blind pair,
 * not a verification.
 *
 * WHAT HAPPENS IF THE ASSUMPTION IS WRONG: if the scanner returns only
 * TRIGGERED labels, then every clean scan comes back with an empty (or partial)
 * `results[]`, every clean scan reads as total drift, and the first adopting
 * entry withholds 100% of its output. That is loud, safe and fail-closed — but
 * it is a day-one capability outage, and it will present as "the feature does
 * not work" rather than as a scanner problem.
 *
 * THE PROBE (one call, before registering an entry): submit a text scan through
 * `createXGuardModerationRequest` with `labels: [...TEXT_OUTPUT_SCAN_LABELS]`
 * over benign content that triggers NOTHING, and read the returned step's
 * `output.results`. Expect 15 entries with `triggered: false`. If instead it
 * comes back empty or short, the drift guard needs a different signal for
 * "evaluated" — the fix is to find one the scanner actually emits, NOT to
 * loosen the withhold. The posture is dormant until then, which is why this is a
 * gate note rather than a defect.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function missingRequestedLabels(
  output: XGuardScanOutputLike | null | undefined,
  requestedLabels: readonly string[]
): string[] {
  const evaluated = new Set<string>();
  const rawResults = output?.results;
  if (Array.isArray(rawResults)) {
    for (const entry of rawResults as XGuardLabelResultLike[]) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.label === 'string' && entry.label.trim().length > 0) {
        evaluated.add(normalizeLabel(entry.label));
      }
    }
  }
  return requestedLabels.filter((label) => !evaluated.has(normalizeLabel(label)));
}

/**
 * The scan → verdict decision. PURE: no IO, no throws, fully mutation-testable
 * without an orchestrator.
 *
 * 🔴 IT READS `triggeredLabels` + THE PER-LABEL RESULTS, AND DELIBERATELY NOT
 * `output.blocked`. `blocked` is true only when a label whose configured ACTION
 * is `Block` triggers, and those action thresholds were tuned for IMAGE
 * moderation. Measured on this very capability: text scoring **0.99 on
 * `Explicit`** came back with `blocked: false`, because that label's action is
 * `Scan`. Keying on `blocked` would therefore release near-certain policy
 * violations. Each label's own `action` is ignored for the same reason — this
 * policy decides what to do, not the orchestrator's image-tuned config.
 *
 * 🔴 THE TWO TRIGGER SIGNALS ARE UNIONED, NOT PICKED BETWEEN.
 * `output.triggeredLabels` and `results[].triggered` are two views of the same
 * fact produced by a service on the other side of a network boundary; if they
 * ever disagree, the union withholds and the intersection releases. Union is
 * the fail-closed direction, so union is what this does.
 *
 * `modelReason` is NOT read: it came back EMPTY on every probe call against the
 * deployed scanner, so anything built on it would be built on a constant.
 */
export function decideTextOutputVerdict(
  output: XGuardScanOutputLike | null | undefined,
  opts: {
    isGreen: boolean;
    /**
     * 🔴 The labels the scan was ASKED for. REQUIRED — deliberately not
     * defaulted to `TEXT_OUTPUT_SCAN_LABELS`, because a default is precisely how
     * a caller ends up checking a list it did not send. Every requested label
     * must come back in `results[]` or the verdict withholds; see
     * `missingRequestedLabels`.
     */
    requestedLabels: readonly string[];
  }
): TextOutputScanVerdict {
  const triggered = new Set<string>();
  const scores: Record<string, number> = {};

  const rawTriggered = output?.triggeredLabels;
  if (Array.isArray(rawTriggered)) {
    for (const label of rawTriggered) {
      if (typeof label === 'string' && label.trim().length > 0) triggered.add(label.trim());
    }
  }

  const rawResults = output?.results;
  if (Array.isArray(rawResults)) {
    for (const entry of rawResults as XGuardLabelResultLike[]) {
      if (!entry || typeof entry !== 'object') continue;
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      if (label.length === 0) continue;
      if (typeof entry.score === 'number' && Number.isFinite(entry.score)) {
        scores[label] = entry.score;
      }
      if (entry.triggered === true) triggered.add(label);
    }
  }

  const triggeredLabels = [...triggered];
  const withholdingLabels = triggeredLabels.filter((label) => {
    const key = normalizeLabel(label);
    if (ALWAYS_WITHHOLD_KEYS.has(key)) return true;
    // 🔴 The maturity-gated tier. `isGreen` true == the token's ceiling is SFW.
    return opts.isGreen && SFW_ONLY_WITHHOLD_KEYS.has(key);
  });

  // 🔴 A LABEL WE ASKED FOR AND DID NOT GET AN ANSWER FOR WITHHOLDS, on its own,
  // even when nothing triggered. This is the rename/typo fail-open the generated
  // client documents ("silently ignored"); see `missingRequestedLabels`.
  const missingLabels = missingRequestedLabels(output, opts.requestedLabels);

  return {
    released: withholdingLabels.length === 0 && missingLabels.length === 0,
    withholdingLabels,
    triggeredLabels,
    scores,
    missingLabels,
  };
}

/** The message a block receives in place of withheld text. */
export const TEXT_OUTPUT_WITHHELD_MESSAGE =
  'This response was withheld because it did not pass Civitai’s content policy.';

/**
 * How long to wait for the scan before giving up and FAILING CLOSED.
 *
 * The scan is inline and blocking on a read path, so this is a user-visible
 * latency budget, not just a safety net. Measured on the deployed scanner:
 * ~1.8s median uncached, ~370ms on a repeat (there is a content cache).
 * `wait` is the orchestrator-side hold; `HARD_DEADLINE_MS` is this side's own
 * ceiling, and it exists because `wait` cannot cover a hung socket — a request
 * that never returns would hang the poll forever, not time out.
 */
export const SCAN_WAIT_SECONDS = 10;
const HARD_DEADLINE_MS = 12_000;

/**
 * The maximum joined content, in characters, this posture will scan.
 *
 * 🔴 THE COST/LATENCY THIS BOUNDS IS CALLER-CONTROLLED IN THREE DIMENSIONS AT
 * ONCE, which is why an unbounded scan on this path was a real defect and not a
 * tidiness note. `attachModeratedStepTextOutputs` runs on EVERY `pollWorkflow`
 * call; the poll CADENCE is chosen by untrusted block code; and the CONTENT
 * length is whatever the model produced. Scan cost is ~1 unit per label per
 * ~10k-char chunk over 15 labels, so a 200k-char reply was ~300 scan units and
 * 370ms–12s of inline latency PER POLL, indefinitely.
 *
 * 🔴 THE VALUE, AND WHY THIS ONE. 50,000 characters ≈ 5 chunks × 15 labels ≈ 75
 * scan units for the worst permitted single scan. It is ~12.5k tokens of
 * generated text — comfortably above any realistic single `chatCompletion`
 * reply, caption or short transcription, which is the population
 * `ACCEPTABLE_POSTURES_BY_TYPE` currently licenses — while capping the tail at a
 * number that will not surprise anyone reading a bill. It is a policy number,
 * not a physical limit: raise it deliberately, with the ~1-unit-per-label-per-
 * 10k-chars arithmetic in hand.
 *
 * 🔴 OVER THE CAP IS A WITHHOLD, NOT A TRUNCATION AND NOT A RELEASE. Truncating
 * would scan a prefix and publish the whole thing — the worst option available,
 * because it reports coverage it does not have. Releasing unscanned is the one
 * outcome this posture exists to prevent. So the cap fails CLOSED, exactly like
 * a scanner error, and an adopter that legitimately needs more has to come back
 * and design chunked scanning rather than discover the limit as a silent gap.
 */
export const MAX_SCANNED_CONTENT_CHARS = 50_000;

/**
 * How long a decided verdict stays reusable for identical content, and how many
 * such verdicts are held.
 *
 * 🔴 WHY MEMOIZE AT ALL: the dedup the orchestrator's own `contentHash` would
 * give us is DELIBERATELY bypassed on this path (no `entityType`/`entityId` — see
 * the header note), and the poll loop re-presents byte-identical content every
 * couple of seconds until the block stops polling. Without a host-side memo the
 * SAME text is rescanned tens of times per generation.
 */
const VERDICT_CACHE_TTL_MS = 5 * 60_000;
/**
 * The memory ceiling on the memo, in entries.
 *
 * EXPORTED ONLY so the eviction bound can be pinned by a test. It was
 * unpinned — raising it (or collapsing it to 1, which disables the memo
 * entirely) changed nothing any test could see.
 */
export const VERDICT_CACHE_MAX_ENTRIES = 1_000;

export type TextOutputScreenResult =
  | { released: true; texts: string[] }
  | { released: false; reason: string };

/**
 * Scan generated text and decide whether it may be released.
 *
 * 🔴 FAIL CLOSED. A scanner error, a timeout, a submit that returns no workflow,
 * a workflow that returns no `xGuardModeration` output — every one of these
 * WITHHOLDS.
 *
 * 🔴 THIS IS THE EXACT OPPOSITE OF `auditPromptServer`, AND THE ASYMMETRY IS
 * DELIBERATE — DO NOT "FIX" IT FOR CONSISTENCY. `auditPromptServer` fails SOFT:
 * it catches an `extModeration` outage internally and lets the prompt through,
 * because the text there is something the USER AUTHORED and blocking it during a
 * moderation-service outage would stop people working on their own content. The
 * text here is MODEL OUTPUT nobody has seen yet. If this failed soft, a scanner
 * outage would ship unscanned generated text to users, which is the single
 * outcome the posture exists to prevent. The next reader WILL assume the two
 * behave the same; they must not.
 *
 * 🔴 NO VIOLATION / AUTO-MUTE COUNTER IS TOUCHED, and that is the other reason
 * `auditPromptServer` is the wrong tool here rather than merely the wrong
 * failure mode. That function writes a `BlockedPromptEntry` and increments the
 * user's auto-mute counter on a hit. The user did not author this text — the
 * app's system prompt and the model did — so charging it against the user's
 * moderation record would mute people for what an app they installed generated.
 * The signal that matters is PER-APP, and it goes to the trigger log below: an
 * app whose outputs trigger constantly is telling you about its system prompt.
 */
export async function screenGeneratedText(opts: {
  /** The generated text pieces to scan. */
  texts: readonly string[];
  /** The token subject. */
  userId: number;
  /** 🔴 From `resolveBlockMaturity(claims).isGreen`. Never a request field. */
  isGreen: boolean;
  /** The OauthClient id off the verified block token — the per-app trigger key. */
  appId: string;
  /** The block instance, when the caller has one. */
  appBlockId?: string;
  /** The registry step id whose output this is. */
  stepId: string;
  /** The orchestrator `$type` that produced it. */
  model: string;
}): Promise<TextOutputScreenResult> {
  const texts = opts.texts.filter((t) => typeof t === 'string' && t.trim().length > 0);

  // Nothing was generated. There is no vacuity hazard in this direction — the
  // caller gets an EMPTY release, so no unscanned text reaches the block. (The
  // mirror-image case on the INPUT side is a real hazard, which is why
  // `'promptAudit'` rejects an empty prompt instead; see `./moderation`.)
  if (texts.length === 0) return { released: true, texts: [] };

  // One scan over the joined text rather than one per piece: cost is per ~10k
  // char chunk, so N pieces of a single reply cost the same joined as split,
  // while a single call has one latency hit instead of N.
  const content = texts.join('\n\n');

  // 🔴 THE CAP, CHECKED BEFORE THE NETWORK CALL AND FAILING CLOSED. See
  // `MAX_SCANNED_CONTENT_CHARS` for the value and the reasoning. Placed here,
  // ahead of the cache lookup, so an over-cap payload can never be answered from
  // a hit either.
  if (content.length > MAX_SCANNED_CONTENT_CHARS) {
    logScan({
      ...opts,
      stage: 'over-cap',
      contentChars: content.length,
      capChars: MAX_SCANNED_CONTENT_CHARS,
    });
    return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
  }

  // 🔴 THE PER-CONTENT MEMO. Keyed on (content, isGreen) and NOTHING ELSE, which
  // is both correct and deliberate:
  //   - `isGreen` IS in the key because the verdict genuinely depends on it (the
  //     SFW-only tier). Dropping it would let a mature-allowed host's release be
  //     served to a SFW one.
  //   - `userId` / `appId` are NOT, because the verdict does not depend on them
  //     and including them would defeat the memo across the poll loop of a
  //     multi-tab viewer for no safety gain. Nothing leaks: a hit requires
  //     presenting the identical content, which the caller already holds.
  // Only CONTENT verdicts are stored — never an error, timeout, missing output
  // or label drift. Caching those would be fail-closed but would also pin a
  // withhold through a recovery, turning a blip into a five-minute outage of the
  // capability. (The drift case is the one that was inconsistent until the
  // ordering fix below; see the `stage: 'label-drift'` branch.)
  //
  // 🔴 KNOWN COST OF THE KEY, RECORDED RATHER THAN LEFT FOR SOMEONE TO
  // DISCOVER: dropping `appId` also drops PER-APP TELEMETRY on a hit. A hit logs
  // NOTHING, so if a second app presents byte-identical withheld content within
  // the TTL, on the same pod, its withhold produces no `stage: 'withheld'` line
  // — and per-app trigger RATE is the signal this posture's design names as the
  // one that matters. The blindness is real; it is accepted here because the
  // obvious fix is worse, not because it is small:
  //   - Logging on EVERY hit would make the emitted rate a function of the poll
  //     CADENCE, which untrusted block code chooses. A skew an attacker sets is
  //     worse for a rate signal than an undercount.
  //   - Undercounting is bounded and one-directional: the first observation of
  //     any distinct content always logs, so an app whose outputs trigger at all
  //     still shows up; only the DUPLICATE of another app's identical text is
  //     lost, and only within one pod's 5-minute window.
  // If cross-app attribution ever has to be exact, the shape of the fix is to
  // store `appId` (plus the labels/scores) in the entry as a PAYLOAD — never in
  // the key — and log on a hit only when the stored `appId` differs. That keeps
  // the memo intact and the poll loop silent. Not built today: no `'textOutput'`
  // entry is registered yet, so the rate has no data to be wrong about.
  const cacheKey = verdictCacheKey(content, opts.isGreen);
  const cached = readCachedVerdict(cacheKey);
  if (cached !== undefined) {
    // 🔴 The caller's OWN `texts` are returned, never a stored copy. The key is
    // the JOINED content, so two callers can share a hit while having split
    // their pieces differently; replaying a stored array would hand one of them
    // the other's segmentation.
    return cached
      ? { released: true, texts }
      : { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
  }

  let output: XGuardScanOutputLike | null | undefined;
  try {
    output = await withHardDeadline(
      createXGuardModerationRequest({
        mode: 'text',
        content,
        userId: opts.userId,
        labels: [...TEXT_OUTPUT_SCAN_LABELS],
        // 🔴 `null`, not omitted. Omitting it makes the request builder default
        // to the standard text-moderation webhook, which drives
        // `recordXGuardScanFromWorkflow` and the scanner audit store. A
        // generated-output scan has no persistent entity for those rows to hang
        // off, so it takes the no-callback path.
        callbackUrl: null,
        wait: SCAN_WAIT_SECONDS,
      }).then((workflow) => {
        const steps = (workflow as { steps?: Array<Record<string, unknown>> } | undefined)?.steps;
        const step = (steps ?? []).find((s) => s?.$type === 'xGuardModeration');
        return (step as { output?: XGuardScanOutputLike } | undefined)?.output;
      })
    );
  } catch (err) {
    logScan({
      ...opts,
      stage: 'error',
      err: err instanceof Error ? err.message : String(err),
    });
    return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
  }

  // 🔴 A MISSING OUTPUT IS A WITHHOLD, NOT A PASS. `createXGuardModerationRequest`
  // resolves to `undefined` when the submit itself failed, and resolves to a
  // still-running workflow when `wait` elapsed before the scan finished — in
  // both cases there is no verdict, and "no verdict" must never read as "clean".
  if (!output) {
    logScan({ ...opts, stage: 'no-verdict' });
    return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
  }

  const verdict = decideTextOutputVerdict(output, {
    isGreen: opts.isGreen,
    // The list actually SENT above — one expression, so the check can never
    // drift from the request.
    requestedLabels: TEXT_OUTPUT_SCAN_LABELS,
  });

  // 🔴 LABEL DRIFT GETS ITS OWN STAGE, AND IS DELIBERATELY *NOT* MEMOIZED —
  // CHECKED BEFORE `writeCachedVerdict`, NOT AFTER. A withhold caused by "we
  // asked for a label the scanner never answered on" is an OPERATIONAL fault in
  // this file's own constant, not a content hit; the two need different
  // responses and must not be aggregated together in the trigger rates.
  //
  // 🔴 THE CALL, AND WHY. An earlier revision wrote the cache BEFORE this
  // branch, so a drift withhold WAS memoized for 5 minutes while a scanner
  // error was not — two members of the same category treated differently, on no
  // stated reasoning, and pinned by no test. Drift is now treated exactly like
  // an error, for the identical reason given at the memo below: caching a
  // withhold that an OPERATIONAL fix can clear pins it through the recovery,
  // turning a blip into a five-minute outage of the capability. Drift is
  // recoverable in precisely that way — a mid-deploy scanner fleet answering on
  // some instances and not others, or an orchestrator-side label config being
  // put back, clears on the very next call, and a memoized withhold would
  // survive it. The cost of not caching is the same cost the error path already
  // accepts (a rescan per poll while the fault lasts), bounded by
  // `MAX_SCANNED_CONTENT_CHARS`.
  //
  // Second-order, and the reason this ordering is load-bearing rather than
  // tidy: a memo HIT logs nothing at all, so caching drift would emit the
  // `stage: 'label-drift'` line for the FIRST observation only and then go
  // silent — which is exactly the "diagnosable in one query" property the drift
  // guard's own comment claims. Not caching keeps one line per observation.
  if (verdict.missingLabels.length > 0) {
    logScan({ ...opts, stage: 'label-drift', missingLabels: verdict.missingLabels });
    return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
  }

  // Only a CONTENT verdict — a release, or a policy-label withhold — is stored.
  writeCachedVerdict(cacheKey, verdict.released);
  if (verdict.released) return { released: true, texts };

  // 🔴 THE PER-APP TRIGGER LOG. `(userId, appBlockId, model, triggeredLabels,
  // scores)` per the approved policy, plus `appId` — the key trigger RATES are
  // aggregated on. The text itself is NOT logged: it is the thing being
  // withheld, and copying it into a log store would defeat that.
  logScan({
    ...opts,
    stage: 'withheld',
    withholdingLabels: verdict.withholdingLabels,
    triggeredLabels: verdict.triggeredLabels,
    scores: verdict.scores,
  });
  return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE VERDICT MEMO — a bounded, TTL'd, in-process map.
//
// 🔴 IN-PROCESS AND NOT REDIS, ON PURPOSE. What this has to collapse is a poll
// LOOP: the same viewer, the same workflow, the same bytes, every couple of
// seconds, served by one pod for the life of that generation. An in-process map
// catches essentially all of that for zero new dependencies and no new failure
// mode on a read path — a Redis outage here would have to fail-closed to be
// safe, i.e. it would take the capability down. Cross-pod reuse is the residual,
// and it is worth strictly less than the failure mode it would buy.
//
// 🔴 NOT a `cache-helpers` cache (`createCachedObject` &co), which is what the
// `no-module-scope-cache` lint rule governs — those are Redis-backed and
// dereference `REDIS_KEYS` at module scope. This is a plain `Map` with no IO.
// ─────────────────────────────────────────────────────────────────────────────

/** `released` per key, with the epoch-ms the entry expires at. */
const verdictCache = new Map<string, { released: boolean; expiresAt: number }>();

function verdictCacheKey(content: string, isGreen: boolean): string {
  // 🔴 A HASH, NOT THE TEXT. Holding the full generated text in a
  // process-lifetime map is a copy of the thing this posture may be about to
  // WITHHOLD; the digest is enough to answer "same content?" and carries none of
  // it back out. `sha256` (not a cheap non-cryptographic hash) because a
  // collision here would serve one text's verdict for another's.
  return `${isGreen ? 'g' : 'm'}:${createHash('sha256').update(content).digest('hex')}`;
}

function readCachedVerdict(key: string): boolean | undefined {
  const hit = verdictCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    verdictCache.delete(key);
    return undefined;
  }
  return hit.released;
}

function writeCachedVerdict(key: string, released: boolean): void {
  // Bounded by eviction of the OLDEST insertion — `Map` preserves insertion
  // order, so the first key is the least recently WRITTEN. Not a true LRU, and
  // it does not need to be: entries expire on a 5-minute TTL anyway, so the cap
  // is a memory ceiling for a burst, not a hit-rate strategy.
  if (verdictCache.size >= VERDICT_CACHE_MAX_ENTRIES) {
    const oldest = verdictCache.keys().next();
    if (!oldest.done) verdictCache.delete(oldest.value);
  }
  verdictCache.set(key, { released, expiresAt: Date.now() + VERDICT_CACHE_TTL_MS });
}

/**
 * Drop every memoized verdict. TEST-ONLY seam: a module-lifetime cache would
 * otherwise leak a verdict between test cases and make the second assertion in a
 * pair a statement about the first one's scan.
 */
export function __clearTextOutputVerdictCacheForTests(): void {
  verdictCache.clear();
}

function logScan(fields: Record<string, unknown>): void {
  const { texts: _texts, ...rest } = fields;
  logToAxiom({ name: 'block-step-text-output-moderation', type: 'warning', ...rest }, 'webhooks')
    // A telemetry failure must never turn a decided verdict into a thrown error
    // on a read path.
    .catch(() => null);
}

/**
 * Reject a promise that has not settled within {@link HARD_DEADLINE_MS}.
 *
 * 🔴 THE TIMER IS ALWAYS CLEARED. A `setTimeout` left pending after the race
 * settles keeps the event loop alive — under a test runner that manifests as a
 * hung file rather than a failure, which is exactly how a race-based timeout
 * hides its own bugs.
 */
async function withHardDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`text-output scan exceeded ${HARD_DEADLINE_MS}ms`)),
          HARD_DEADLINE_MS
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
