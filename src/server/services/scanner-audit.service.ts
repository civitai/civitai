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
import type { Workflow, XGuardModerationStep } from '@civitai/client';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';

/**
 * Age-classifier topK band names that count as minor. Includes Teenager 13-20
 * intentionally — the band spans both minor and adult ages, but for FN-browse
 * purposes we want the score to reflect "how close to a minor classification"
 * the model put this image, not just whether isMinor flipped.
 */
const MINOR_AGE_BANDS = new Set(['Child 0-12', 'Teenager 13-20']);

type MediaRatingOutput = {
  nsfwLevel: string;
  isBlocked: boolean;
  blockedReason?: string;
  ageClassification?: {
    detections: Array<{
      isMinor: boolean;
      confidence: number;
      topK?: Record<string, number>;
    }>;
  };
  faceRecognition?: { faces: Array<unknown> };
  aiRecognition?: { label: string; confidence: number };
  animeRecognition?: { label: string; confidence: number };
};

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
  }));

  try {
    await clickhouse.insert({
      table: 'scanner_label_results',
      values: rows,
      format: 'JSONEachRow',
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

  await insertRows({
    workflowId: workflow.id,
    scanner: mode === 'text' ? 'xguard_text' : 'xguard_prompt',
    contentHash,
    entityType,
    entityId: entityIdRaw !== undefined ? String(entityIdRaw) : '',
    modelVersion: (workflow.metadata.version as string | undefined) ?? '1',
    startedAt: workflow.startedAt,
    completedAt: workflow.completedAt,
    labels,
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
  labels.push({
    label: 'nsfw_level',
    labelValue: mediaRating.nsfwLevel,
    score: 1,
    threshold: null,
    triggered: 1,
    version: '1',
    matchedText: [],
    matchedPositivePrompt: [],
    matchedNegativePrompt: [],
  });
  labels.push({
    label: 'is_blocked',
    labelValue: '',
    score: mediaRating.isBlocked ? 1 : 0,
    threshold: null,
    triggered: mediaRating.isBlocked ? 1 : 0,
    version: '1',
    matchedText: [],
    matchedPositivePrompt: [],
    matchedNegativePrompt: [],
  });

  if (mediaRating.ageClassification) {
    const detections = mediaRating.ageClassification.detections ?? [];
    const minorScore = detections.reduce((max, d) => {
      const topK = d.topK ?? {};
      const probSum = Object.entries(topK).reduce(
        (sum, [band, p]) => (MINOR_AGE_BANDS.has(band) ? sum + p : sum),
        0
      );
      return Math.max(max, probSum);
    }, 0);
    labels.push({
      label: 'minor',
      labelValue: '',
      score: minorScore,
      threshold: null,
      triggered: detections.some((d) => d.isMinor) ? 1 : 0,
      version: '1',
      matchedText: [],
      matchedPositivePrompt: [],
      matchedNegativePrompt: [],
    });
  }

  if (mediaRating.aiRecognition) {
    labels.push({
      label: 'ai',
      labelValue: mediaRating.aiRecognition.label,
      score: mediaRating.aiRecognition.confidence,
      threshold: null,
      triggered: mediaRating.aiRecognition.label === 'AI' ? 1 : 0,
      version: '1',
      matchedText: [],
      matchedPositivePrompt: [],
      matchedNegativePrompt: [],
    });
  }

  if (mediaRating.animeRecognition) {
    labels.push({
      label: 'anime',
      labelValue: mediaRating.animeRecognition.label,
      score: mediaRating.animeRecognition.confidence,
      threshold: null,
      triggered: mediaRating.animeRecognition.label === 'anime' ? 1 : 0,
      version: '1',
      matchedText: [],
      matchedPositivePrompt: [],
      matchedNegativePrompt: [],
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
