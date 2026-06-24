/**
 * Scanner audit log writer (ClickHouse `scanner_label_results`).
 *
 * The table is an AggregatingMergeTree keyed by `(scanner, label, contentHash,
 * version)`. Each insert is treated as one occurrence of a decision; the
 * engine merges duplicate inserts in the background and queries do GROUP BY
 * to see the merged view. This collapses repeated identical inputs (a user
 * iterating on the same prompt under the same policy) into one logical row
 * with `occurrences` summed and `workflowIds` accumulated.
 *
 * Writes are fire-and-forget: any ClickHouse failure is logged to Axiom but
 * never propagates back to the operational webhook path.
 */
import crypto from 'crypto';
import type { MediaRatingOutput, Workflow, XGuardModerationStep } from '@civitai/client';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import {
  applyDerivedLabels,
  type DerivedLabelInput,
  type DerivedLabelMode,
} from '~/server/services/scanner-derived-labels.service';
import { matchAllLabels } from '~/server/services/scanner-label-regex';
import { buildRegexShadowRows } from '~/server/services/scanner-regex-shadow.builder';

/**
 * Age-classifier topK band names that count as minor. Stored in normalized
 * form (lowercase, ASCII hyphen) and matched after normalizing the input key,
 * so locale variants ("Child 0–12" with en-dash, lowercase, etc.) still hit.
 * Includes Teenager 13-20 intentionally — the band spans both minor and adult
 * ages, but for FN-browse purposes we want the score to reflect "how close
 * to a minor classification" the model put this image, not just isMinor.
 */
const MINOR_AGE_BANDS_NORMALIZED = new Set(['child 0-12', 'teenager 13-20']);

function normAgeBandKey(k: string): string {
  return k.trim().toLowerCase().replace(/[–—]/g, '-');
}

/** Normalize classifier label output (lowercase + trim) so casing drift in
 *  the orchestrator response doesn't fracture the audit table. The 'na'
 *  sentinel from the NsfwLevel union is the one value we deliberately drop —
 *  it means "not analyzed", not a real rating. */
function normClassifierLabel(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/**
 * ClickHouse async_insert settings. Audit-table inserts run at high frequency
 * once image scanning ramps up — one insert per scan, 5-10 rows each. Without
 * server-side batching that's hundreds of small parts per partition per
 * second and we hit `parts_to_throw_insert` (~300 active parts) fast.
 *
 * async_insert tells ClickHouse to buffer incoming rows server-side and flush
 * them as a single part when either `busy_timeout_ms` elapses since the first
 * buffered row OR `max_data_size` bytes are accumulated. The wait-flag is 0
 * because every caller of insertRows / writeRegexShadowComparison is
 * fire-and-forget — we don't need to know the row landed before we return.
 *
 * Worst-case durability: server crash during the ~1s buffer window loses
 * those rows. Acceptable for an audit log (we already swallow ClickHouse
 * errors and log to Axiom; same defensive posture).
 */
const CLICKHOUSE_AUDIT_INSERT_SETTINGS = {
  async_insert: 1,
  wait_for_async_insert: 0,
  async_insert_busy_timeout_ms: 1000,
  async_insert_max_data_size: '10000000',
} as const;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

type LabelRowSeed = {
  label: string;
  labelValue: string;
  score: number;
  threshold: number | null;
  triggered: 0 | 1;
  version: string;
  matchedText: string[];
  matchedPositivePrompt: string[];
  matchedNegativePrompt: string[];
  /** True for derivation-synthesized rows (see scanner-derived-labels.service).
   * Defaults to false everywhere else. */
  synthetic?: boolean;
  /** Contributing input label names for synthetic rows. Empty for non-synthetic. */
  derivedFrom?: string[];
};

type WriteParams = {
  workflowId: string;
  scanner: 'image_ingestion' | 'xguard_text' | 'xguard_prompt';
  contentHash: string;
  entityType: string;
  entityId: string;
  modelVersion: string;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  labels: LabelRowSeed[];
};

function computeContentHash(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

function toClickhouseDateTime(input: Date | string | null | undefined): string | null {
  if (!input) return null;
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return null;
  // ClickHouse DateTime format: 'YYYY-MM-DD HH:MM:SS' (UTC, no T/Z).
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function insertRows({
  workflowId,
  scanner,
  contentHash,
  entityType,
  entityId,
  modelVersion,
  startedAt,
  completedAt,
  labels,
}: WriteParams) {
  if (!clickhouse) return;
  if (!labels.length) return;

  const startedAtStr = toClickhouseDateTime(startedAt);
  const completedAtStr = toClickhouseDateTime(completedAt);
  const durationMs =
    startedAtStr && completedAtStr
      ? Math.max(0, new Date(completedAtStr).getTime() - new Date(startedAtStr).getTime())
      : 0;

  // The `lastSeenAt` / `firstSeenAt` columns drive partition pruning and are
  // what queries filter on. Use completedAt (workflow event time) so the
  // partition reflects when the scan actually happened, not when this insert
  // ran. Fall back to now() so we still land in a sensible partition if the
  // workflow didn't surface a timestamp.
  const seenAtStr = completedAtStr ?? new Date().toISOString().slice(0, 19).replace('T', ' ');

  const rows = labels.map((l) => ({
    contentHash,
    version: l.version,
    label: l.label,
    scanner,
    entityType,
    labelValue: l.labelValue,
    modelVersion,
    score: l.score,
    threshold: l.threshold,
    triggered: l.triggered,
    matchedText: l.matchedText,
    matchedPositivePrompt: l.matchedPositivePrompt,
    matchedNegativePrompt: l.matchedNegativePrompt,
    durationMs,
    firstSeenAt: seenAtStr,
    lastSeenAt: seenAtStr,
    occurrences: 1,
    workflowIds: [workflowId],
    entityIds: entityId ? [entityId] : [],
    synthetic: l.synthetic ? 1 : 0,
    derivedFrom: l.derivedFrom ?? [],
  }));

  try {
    await clickhouse.insert({
      table: 'scanner_label_results',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: CLICKHOUSE_AUDIT_INSERT_SETTINGS,
    });
  } catch (e) {
    const error = e as Error;
    await logToAxiom({
      name: 'scanner-audit-write-failed',
      type: 'error',
      message: error.message,
      workflowId,
      scanner,
      entityType,
      entityId,
      contentHash,
      labelRowCount: rows.length,
    });
  }
}

/**
 * Cheap script-detection gate for the regex shadow pass. Returns true when
 * the text is plausibly English (mostly Latin script). Non-English prompts
 * skip the regex matcher — the regex term lists are English-only by design;
 * see docs/features/scanner-label-architecture.md for the tiered detection
 * plan.
 */
function isLikelyEnglishForRegex(text: string): boolean {
  if (!text) return false;
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec
  const nonLatin = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Hebrew}]/gu
  );
  if (!nonLatin) return true;
  return nonLatin.length / text.length < 0.05; // <5% non-Latin chars = treat as English
}

/**
 * Shadow-write: compare regex-detector output to XGuard for each atomic
 * label and persist the comparison to `scanner_regex_shadow_results` for
 * later audit. Phase 1 of the regex-rollout plan in
 * docs/features/scanner-label-architecture.md — does not change the audit
 * data the moderator queue sees.
 *
 * Fire-and-forget: any failure here is logged to Axiom but does not
 * propagate. We never block the main audit write on regex shadow data.
 */
async function writeRegexShadowComparison(args: {
  workflowId: string;
  contentHash: string;
  scanner: 'xguard_prompt' | 'xguard_text';
  positivePrompt: string;
  xguardLabels: LabelRowSeed[];
  scannedAt: Date;
}) {
  if (!clickhouse) return;
  if (!isLikelyEnglishForRegex(args.positivePrompt)) return;

  try {
    const regexResults = matchAllLabels(args.positivePrompt);
    if (regexResults.length === 0) return;

    const rows = buildRegexShadowRows({
      workflowId: args.workflowId,
      contentHash: args.contentHash,
      scanner: args.scanner,
      regexResults,
      xguardLabels: args.xguardLabels,
      scannedAt: args.scannedAt,
    });

    await clickhouse.insert({
      table: 'scanner_regex_shadow_results',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: CLICKHOUSE_AUDIT_INSERT_SETTINGS,
    });
  } catch (e) {
    const error = e as Error;
    await logToAxiom({
      name: 'scanner-regex-shadow-write-failed',
      type: 'error',
      message: error.message,
      workflowId: args.workflowId,
      contentHash: args.contentHash,
    });
  }
}

/**
 * Pull the per-label results off a succeeded XGuard workflow and write them
 * to the audit log. No-op if `metadata.recordForReview` isn't set, or if no
 * xGuardModeration step output is present.
 *
 * `contentHash` is computed from the step *input* (text or positive+negative
 * prompt) — this is the dedup unit. Two scans of identical text under the
 * same version will land on the same AggregatingMergeTree merge key and
 * collapse to one logical row.
 */
export async function recordXGuardScanFromWorkflow(workflow: Workflow) {
  if (!clickhouse) return;
  if (workflow.metadata?.recordForReview !== true) return;

  const steps = (workflow.steps ?? []) as unknown as XGuardModerationStep[];
  const step = steps.find((s) => s.$type === 'xGuardModeration');
  if (!step?.output || !workflow.id) return;

  const mode = (workflow.metadata.mode as 'text' | 'prompt' | undefined) ?? 'text';

  // Hash the input the model actually evaluated. For text mode this is the
  // bare text body; for prompt mode it's positive + newline + negative so we
  // dedupe correctly on the (positive, negative) pair.
  const input = step.input as {
    mode?: string;
    text?: string;
    positivePrompt?: string;
    negativePrompt?: string | null;
  };
  const hashInput =
    mode === 'text'
      ? input.text ?? ''
      : `${input.positivePrompt ?? ''}\n${input.negativePrompt ?? ''}`;
  const contentHash = computeContentHash(hashInput);

  const results = step.output.results;
  const labels: LabelRowSeed[] = results.map((r) => {
    const triggered = r.triggered ? 1 : 0;
    return {
      // Normalize to lowercase at the storage boundary — the orchestrator
      // sometimes returns labels uppercased (e.g. 'NSFW'). One canonical key
      // keeps the dedup merge, queue queries, and verdict joins simple.
      label: r.label.toLowerCase(),
      labelValue: '',
      score: r.score,
      threshold: r.threshold,
      triggered,
      version: r.policyHash ?? '',
      // modelReason is intentionally NOT stored here — it lives on the workflow
      // and is resolved lazily by scanner-content.service when the moderator
      // opens an item. Snapshot writes preserve it past the orchestrator's TTL.
      matchedText: r.matchedTerms?.text ?? [],
      matchedPositivePrompt: r.matchedTerms?.positivePrompt ?? [],
      matchedNegativePrompt: r.matchedTerms?.negativePrompt ?? [],
    };
  });

  const entityType = (workflow.metadata.entityType as string | undefined) ?? '';
  const entityIdRaw = workflow.metadata.entityId as number | string | undefined;

  // Phase 1 (shadow mode) regex comparison. Doesn't change what's recorded
  // to scanner_label_results — purely an analytical sidecar in
  // scanner_regex_shadow_results so we can audit regex accuracy vs XGuard on
  // real production traffic before flipping the regex authoritative. Prompt
  // mode + English-only; see writeRegexShadowComparison.
  if (mode === 'prompt' && workflow.id && input.positivePrompt) {
    void writeRegexShadowComparison({
      workflowId: workflow.id,
      contentHash,
      scanner: 'xguard_prompt',
      positivePrompt: input.positivePrompt,
      xguardLabels: labels,
      scannedAt: workflow.completedAt ? new Date(workflow.completedAt) : new Date(),
    });
  }

  // Apply derived-label rules — suppress redundant rows (e.g. `suggestive`
  // when `explicit` also triggered) and synthesize computed rows (e.g.
  // `csam` from `young` + sexual-signal). The transform is mode-scoped and
  // pure; see scanner-derived-labels.service.ts and
  // docs/features/scanner-derived-labels-plan.md.
  const derivedInput: DerivedLabelInput[] = labels.map((l) => ({
    label: l.label,
    score: l.score,
    threshold: l.threshold,
    triggered: l.triggered,
    version: l.version,
    matchedText: l.matchedText,
    matchedPositivePrompt: l.matchedPositivePrompt,
    matchedNegativePrompt: l.matchedNegativePrompt,
  }));
  const derived = applyDerivedLabels(derivedInput, mode as DerivedLabelMode);
  const derivedLabels: LabelRowSeed[] = derived.map((d) => ({
    label: d.label,
    labelValue: '',
    score: d.score,
    threshold: d.threshold,
    triggered: d.triggered,
    version: d.version,
    matchedText: d.matchedText,
    matchedPositivePrompt: d.matchedPositivePrompt,
    matchedNegativePrompt: d.matchedNegativePrompt,
    synthetic: d.synthetic,
    derivedFrom: d.derivedFrom,
  }));

  await insertRows({
    workflowId: workflow.id,
    scanner: mode === 'text' ? 'xguard_text' : 'xguard_prompt',
    contentHash,
    entityType,
    entityId: entityIdRaw !== undefined ? String(entityIdRaw) : '',
    modelVersion: (workflow.metadata.version as string | undefined) ?? '1',
    startedAt: workflow.startedAt,
    completedAt: workflow.completedAt,
    labels: derivedLabels,
  });
}

/**
 * Translate the `mediaRating` step output into per-label rows for
 * `scanner_label_results`. Always emits `nsfw_level` and `is_blocked`; emits
 * `minor`/`ai`/`anime` only when the corresponding classifier was included in
 * the step (transition-period workflows may have just `nsfwLevel` + `isBlocked`).
 *
 * `contentHash` is derived from the imageId — the dedup unit for images is
 * the image itself, so a rescan of the same image collapses on the same row.
 * Policy + model version are hardcoded to '1' as placeholders until image-side
 * policy versioning lands.
 */
export async function recordImageScan({
  workflowId,
  imageId,
  mediaRating,
  startedAt,
  completedAt,
}: {
  workflowId: string;
  imageId: number;
  mediaRating: MediaRatingOutput;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
}) {
  if (!clickhouse) return;

  const labels: LabelRowSeed[] = [];

  // Shared row defaults — image rows have no text-side matched-term arrays
  // and no per-row threshold. Spread this into each push to keep them tidy.
  const baseRow = {
    threshold: null,
    version: '1',
    matchedText: [] as string[],
    matchedPositivePrompt: [] as string[],
    matchedNegativePrompt: [] as string[],
  };

  // --- 1. NSFW level → the LEVEL itself becomes the label name -------------
  // pg / pg13 / r / x / xxx are queryable directly. 'na' is the orchestrator's
  // "not analyzed" sentinel — recorded as a distinct audit signal, not a real
  // rating. Anything else (case drift, future variant) gets surfaced as
  // unknown_nsfw_level so an audit trail exists for new shapes.
  // nsfw_level — label IS the level. Skip the 'na' sentinel.
  const nsfwLevel = normClassifierLabel(mediaRating.nsfwLevel);
  if (nsfwLevel && nsfwLevel !== 'na') {
    labels.push({
      ...baseRow,
      label: nsfwLevel,
      labelValue: 'nsfw_level',
      score: 1,
      triggered: 1,
    });
  }

  // is_blocked — emit when blocked, with blockedReason in labelValue.
  if (mediaRating.isBlocked) {
    labels.push({
      ...baseRow,
      label: 'is_blocked',
      labelValue: mediaRating.blockedReason ?? '',
      score: 1,
      triggered: 1,
    });
  }

  // content_label — one row per orchestrator-provided label.
  for (const orchLabel of mediaRating.labels ?? []) {
    if (!orchLabel) continue;
    labels.push({
      ...baseRow,
      label: 'content_label',
      labelValue: orchLabel,
      score: 1,
      triggered: 1,
    });
  }

  // minor — score is sum of minor-band topK probabilities (max across
  // detections); triggered tracks isMinor; labelValue carries the joined
  // ageLabel(s) so mods can see 'Teenager 13-20' vs 'Adult 21-44'.
  const detections = mediaRating.ageClassification?.detections ?? [];
  if (detections.length > 0) {
    const minorScore = detections.reduce((max, d) => {
      const topK = d.topK ?? {};
      const probSum = Object.entries(topK).reduce(
        (sum, [band, p]) => (MINOR_AGE_BANDS_NORMALIZED.has(normAgeBandKey(band)) ? sum + p : sum),
        0
      );
      return Math.max(max, probSum);
    }, 0);
    const ageLabels = detections
      .map((d) => d.ageLabel)
      .filter((x): x is string => !!x)
      .join(', ');
    labels.push({
      ...baseRow,
      label: 'minor',
      labelValue: ageLabels,
      score: clamp01(minorScore),
      triggered: detections.some((d) => d.isMinor) ? 1 : 0,
    });
  }

  // ai_recognition / anime_recognition — emit whatever the classifier said.
  // labelValue carries the detector source so 'real' rows from the two
  // classifiers don't collide on the `label` column.
  if (mediaRating.aiRecognition?.label) {
    labels.push({
      ...baseRow,
      label: normClassifierLabel(mediaRating.aiRecognition.label),
      labelValue: 'ai_recognition',
      score: clamp01(mediaRating.aiRecognition.confidence),
      triggered: 1,
    });
  }
  if (mediaRating.animeRecognition?.label) {
    labels.push({
      ...baseRow,
      label: normClassifierLabel(mediaRating.animeRecognition.label),
      labelValue: 'anime_recognition',
      score: clamp01(mediaRating.animeRecognition.confidence),
      triggered: 1,
    });
  }

  // faces — emit when the classifier detected any. score carries the count
  // so a query can still filter by "images with > N faces". boundingBoxes,
  // landmarks, embeddings, and similarityMatrix are intentionally not
  // persisted (high-cardinality, partly PII).
  const faces = mediaRating.faceRecognition?.faces ?? [];
  if (faces.length > 0) {
    labels.push({
      ...baseRow,
      label: 'faces',
      labelValue: '',
      score: faces.length,
      triggered: 1,
    });
  }

  await insertRows({
    workflowId,
    scanner: 'image_ingestion',
    contentHash: computeContentHash(`image:${imageId}`),
    entityType: 'image',
    entityId: String(imageId),
    modelVersion: '1',
    startedAt,
    completedAt,
    labels,
  });
}
