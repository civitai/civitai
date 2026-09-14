/**
 * Video counterpart to `controlnets.helper.ts`, for engines whose control input
 * is a video rather than an image.
 *
 * The orchestrator's `controlVideo` operation REPLACES imageToVideo /
 * referenceToVideo — its input has no frame slots — so callers must gate it to a
 * frameless workflow or the user's images are silently dropped.
 *
 * Per-entry `mode`:
 *  - `'preprocessed'`: the user supplied an already-processed control map. Its
 *    URL is passed straight through and no preprocess step is emitted.
 *  - `'auto'` (default): a `preprocessVideo` step is emitted in front of the gen
 *    step and the control video becomes a `$ref` to that step's output blob.
 */

import type {
  PreprocessVideoInput,
  PreprocessVideoStepTemplate,
} from '@civitai/orchestration-client';
import type { VideoControlNetPreprocessorKey } from '~/shared/constants/controlnets.constants';
import { controlNetToPreprocessVideoKind } from '~/shared/constants/controlnets.constants';
import type { ControlVideoNodeValue } from '~/shared/data-graph/generation/common';
import { buildStepRef } from '../step-ref';

/** `$ref` output path for a `preprocessVideo` step's blob URL. */
const PREPROCESS_OUTPUT_REF_PATH = 'output.blob.url';

export interface BuildControlVideoResult {
  /**
   * `preprocessVideo` step templates to insert BEFORE the consuming gen step.
   * Empty when the control map was already preprocessed.
   */
  preprocessSteps: PreprocessVideoStepTemplate[];
  /**
   * Spread onto the gen step's input. `video` is a `$ref` object in `auto`
   * mode; the SDK types it `string`, hence the cast.
   */
  control: {
    video: string;
    strength: number;
    startPercent: number;
    endPercent: number;
  };
}

export function buildControlVideoStep(
  controlVideo: ControlVideoNodeValue | undefined,
  baseStepIndex: number
): BuildControlVideoResult | undefined {
  if (!controlVideo?.video?.url) return undefined;

  const shared = {
    strength: controlVideo.strength,
    startPercent: controlVideo.startPercent,
    endPercent: controlVideo.endPercent,
  };

  const kind =
    controlNetToPreprocessVideoKind[controlVideo.preprocessor as VideoControlNetPreprocessorKey];

  // No video preprocess recipe for this preprocessor — treat it as already
  // preprocessed rather than emitting a step the orchestrator would reject.
  if (controlVideo.mode !== 'auto' || !kind) {
    return { preprocessSteps: [], control: { ...shared, video: controlVideo.video.url } };
  }

  const preprocessStep: PreprocessVideoStepTemplate = {
    $type: 'preprocessVideo',
    input: { kind, video: controlVideo.video.url } as PreprocessVideoInput,
    metadata: { suppressOutput: true },
  } as PreprocessVideoStepTemplate;

  const ref = buildStepRef(baseStepIndex, PREPROCESS_OUTPUT_REF_PATH);
  return {
    preprocessSteps: [preprocessStep],
    control: { ...shared, video: ref as unknown as string },
  };
}
