import { logToAxiom } from '~/server/logging/client';
import {
  labelResultErrored,
  missingRequestedLabels,
  normalizeLabel,
  triggeredLabelKeys,
  type ScanLabelResultLike,
  type ScanOutputLike,
} from '~/server/services/moderation-label-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { hasScanLabelFlag, recordScanLabelFlag } from '~/server/services/scan-label-flag.service';

/** The orchestrator's image scan never sees an upload's prompt, so ingestion labels it here. */
export const UPLOAD_PROMPT_SCAN_LABELS = ['young'] as const;

const SCAN_WAIT_SECONDS = 10;
const HARD_DEADLINE_MS = 12_000;

export type UploadPromptVerdict = 'flagged' | 'clean' | 'unknown';
type UploadPromptScan = {
  verdict: UploadPromptVerdict;
  workflowId?: string;
  output?: ScanOutputLike;
};

export function decideUploadPromptVerdict(
  output: ScanOutputLike | null | undefined
): UploadPromptVerdict {
  if (!output) return 'unknown';
  if (missingRequestedLabels(output, UPLOAD_PROMPT_SCAN_LABELS).length) return 'unknown';
  const results = Array.isArray(output.results) ? (output.results as ScanLabelResultLike[]) : [];
  const requested = new Set<string>(UPLOAD_PROMPT_SCAN_LABELS);
  if (
    results.some(
      (entry) =>
        typeof entry?.label === 'string' &&
        requested.has(normalizeLabel(entry.label)) &&
        labelResultErrored(entry)
    )
  )
    return 'unknown';
  const triggered = triggeredLabelKeys(output);
  return UPLOAD_PROMPT_SCAN_LABELS.some((label) => triggered.has(label)) ? 'flagged' : 'clean';
}

/**
 * Scans an uploaded image's prompt. Never throws: a scan that fails or does not finish in time is
 * `unknown`.
 */
export async function scanUploadPrompt({
  imageId,
  userId,
  prompt,
  negativePrompt,
}: {
  imageId: number;
  userId: number;
  prompt: string;
  negativePrompt?: string;
}): Promise<UploadPromptScan> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const workflow = await Promise.race([
      createXGuardModerationRequest({
        mode: 'prompt',
        positivePrompt: prompt,
        negativePrompt,
        userId,
        labels: [...UPLOAD_PROMPT_SCAN_LABELS],
        // No callback: the verdict is read from the waited response, and an ingestion scan has no
        // entity for the text-moderation webhook to record against.
        callbackUrl: null,
        wait: SCAN_WAIT_SECONDS,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('upload prompt scan timed out')),
          HARD_DEADLINE_MS
        );
      }),
    ]);
    const { id: workflowId, steps } = (workflow ?? {}) as {
      id?: string;
      steps?: Array<{ $type?: string; output?: ScanOutputLike }>;
    };
    const output = steps?.find((step) => step?.$type === 'xGuardModeration')?.output;
    const verdict = decideUploadPromptVerdict(output);
    if (verdict === 'unknown')
      logToAxiom({
        name: 'upload-prompt-scan',
        type: 'warning',
        message: 'no verdict',
        imageId,
      }).catch(() => null);
    return { verdict, workflowId, output };
  } catch (error) {
    logToAxiom({
      name: 'upload-prompt-scan',
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      imageId,
    }).catch(() => null);
    return { verdict: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Labels an NSFW upload whose prompt the scan flags, for moderators to verify. A label only: it
 * never changes the image. Scans nothing while the label queue writer is off, and nothing for an
 * image that already has a prompt label, so a redelivered webhook does not scan twice.
 */
export async function labelUploadPrompt({
  imageId,
  userId,
  prompt,
  negativePrompt,
}: {
  imageId: number;
  userId: number;
  prompt: string;
  negativePrompt?: string;
}) {
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.SCAN_LABEL_QUEUE_WRITER, String(imageId)))) return;
    if (await hasScanLabelFlag(imageId, 'xguard-prompt')) return;
  } catch (error) {
    logToAxiom({
      name: 'upload-prompt-scan',
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      imageId,
    }).catch(() => null);
    return;
  }
  const scan = await scanUploadPrompt({ imageId, userId, prompt, negativePrompt });
  // The workflow id is the flag's idempotency key; a scan without one has nothing to record.
  if (scan.verdict !== 'flagged' || !scan.workflowId) return;

  const results = Array.isArray(scan.output?.results)
    ? (scan.output.results as ScanLabelResultLike[]).map(
        ({ label, score, threshold, triggered }) => ({
          label,
          score,
          threshold,
          triggered,
        })
      )
    : [];
  await recordScanLabelFlag({
    imageId,
    source: 'xguard-prompt',
    reason: [...triggeredLabelKeys(scan.output)].join(','),
    workflowId: scan.workflowId,
    flaggedAt: new Date(),
    snapshot: { results },
    oncePerImage: true,
  });
}
