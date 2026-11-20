import { logToAxiom } from '~/server/logging/client';

type FrameExtractionStep = {
  $type?: string;
  input?: { maxFrames?: number };
  output?: { frames?: unknown[] };
};

/** A video longer than the extraction cap is rated on its first `maxFrames` frames only. */
export function logFrameLimitHit({
  steps,
  imageId,
  workflowId,
}: {
  steps: unknown[];
  imageId: number;
  workflowId: string;
}) {
  let frames: number | undefined;
  let maxFrames: number | undefined;
  // Log-only: a malformed step must never fail the scan result.
  try {
    const step = (steps as FrameExtractionStep[]).find((x) => x.$type === 'videoFrameExtraction');
    maxFrames = step?.input?.maxFrames;
    frames = step?.output?.frames?.length;
  } catch {
    return;
  }
  if (!maxFrames || frames === undefined || frames < maxFrames) return;
  logToAxiom({
    name: 'image-scan-frame-limit',
    type: 'warning',
    message: `video frame extraction hit maxFrames (${maxFrames})`,
    imageId,
    workflowId,
    frames,
    maxFrames,
  }).catch(() => null);
}
