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
};

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
  opts: { isGreen: boolean }
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

  return {
    released: withholdingLabels.length === 0,
    withholdingLabels,
    triggeredLabels,
    scores,
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

  const verdict = decideTextOutputVerdict(output, { isGreen: opts.isGreen });
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
