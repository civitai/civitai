/**
 * Shared helper for mapping the graph's `controlNets` value into the
 * `ImageJobControlNet[]` shape the orchestrator expects, optionally prepending
 * `preprocessImage` steps for entries whose `mode === 'auto'`.
 *
 * Per-entry `mode`:
 *  - `'preprocessed'`: the user supplied an already-processed image. We pass
 *    `entry.image.url` straight through. No preprocess step is emitted.
 *  - `'auto'` (default): we emit a `preprocessImage` step in front of the gen
 *    step and rewrite the controlNet's `image` to a `$ref` pointing at that
 *    step's output blob. `baseStepIndex` tells us where the gen step sits in
 *    the final flat steps array — needed because the snippets-overlay loop in
 *    `orchestration-new.service.ts` concatenates per-variant steps into one
 *    array, so refs MUST use the global index, not a per-variant one.
 */

import type {
  ImageJobControlNet,
  ImageTransformer,
  PreprocessImageInput,
  PreprocessImageStepTemplate,
} from '@civitai/client';
import type { ControlNetPreprocessorKey } from '~/shared/constants/controlnets.constants';
import { controlNetToPreprocessKind } from '~/shared/constants/controlnets.constants';
import type { ControlNetsNodeValue } from '~/shared/data-graph/generation/common';
import { buildStepRef } from '../step-ref';

/** `$ref` output path for a `preprocessImage` step's preview blob URL. */
const PREPROCESS_OUTPUT_REF_PATH = 'output.blob.url';

export interface BuildControlNetStepsResult {
  /**
   * `preprocessImage` step templates to insert into the steps array BEFORE
   * the consuming gen step. Indices in this array correspond to the offsets
   * applied to `baseStepIndex` when building each entry's step-ref.
   */
  preprocessSteps: PreprocessImageStepTemplate[];
  /**
   * Orchestrator-shaped controlNets array. For `auto` entries, `image` is a
   * `$ref` to the matching preprocessImage step's output; for `preprocessed`
   * entries, it's the raw URL the user supplied.
   *
   * The `$ref` object is structurally compatible with the wire format but
   * the SDK types `image` as `string | null`, so it's coerced via `unknown`.
   * (This mirrors the existing pattern in ace-audio.handler.ts where
   * `imageUrl: { $ref, path }` is cast to string for the same reason.)
   */
  controlNets: ImageJobControlNet[];
}

/**
 * Build the orchestrator's `ImageJobControlNet[]` plus any `preprocessImage`
 * steps required by `auto`-mode entries.
 *
 * @param controlNets  Validated graph value (`output` shape from
 *   `controlNetsNode`). May be `undefined` when the node isn't active.
 * @param baseStepIndex  The index at which the FIRST emitted preprocess step
 *   will sit in the final flat steps array (i.e. the current `steps.length`
 *   when the consuming handler is invoked). The gen step itself sits at
 *   `baseStepIndex + preprocessSteps.length`.
 */
export function buildControlNetSteps(
  controlNets: ControlNetsNodeValue | undefined,
  baseStepIndex: number
): BuildControlNetStepsResult {
  if (!controlNets?.length) return { preprocessSteps: [], controlNets: [] };

  const preprocessSteps: PreprocessImageStepTemplate[] = [];
  const mapped: ImageJobControlNet[] = [];

  for (const entry of controlNets) {
    const base: Omit<ImageJobControlNet, 'image'> = {
      preprocessor: entry.preprocessor as ImageTransformer,
      weight: entry.weight,
      startStep: entry.startStep,
      endStep: entry.endStep,
    };

    if (entry.mode === 'auto') {
      const kind = controlNetToPreprocessKind[entry.preprocessor as ControlNetPreprocessorKey];
      if (kind) {
        const stepIndex = baseStepIndex + preprocessSteps.length;
        preprocessSteps.push({
          $type: 'preprocessImage',
          input: { kind, image: entry.image.url } as PreprocessImageInput,
          metadata: { suppressOutput: true },
        } as PreprocessImageStepTemplate);

        const ref = buildStepRef(stepIndex, PREPROCESS_OUTPUT_REF_PATH);
        mapped.push({ ...base, image: ref as unknown as string });
        continue;
      }
      // Falls through when no preprocess kind exists for this preprocessor —
      // treat as 'preprocessed' and pass the raw URL.
    }

    mapped.push({ ...base, image: entry.image.url });
  }

  return { preprocessSteps, controlNets: mapped };
}

/**
 * Legacy single-output helper for callers that don't need preprocess wiring
 * (e.g., legacy comfy flows that already preprocess server-side, or whatIf
 * estimation paths). Equivalent to `buildControlNetSteps(...).controlNets`
 * but assumes all entries are `preprocessed` mode (no refs).
 *
 * @deprecated Prefer `buildControlNetSteps` so `auto` mode wires up correctly.
 */
export function mapControlNetsToJobInput(
  controlNets: ControlNetsNodeValue | undefined
): ImageJobControlNet[] | undefined {
  if (!controlNets?.length) return undefined;
  return controlNets.map((entry) => ({
    preprocessor: entry.preprocessor as ImageTransformer,
    weight: entry.weight,
    startStep: entry.startStep,
    endStep: entry.endStep,
    image: entry.image.url,
  }));
}
