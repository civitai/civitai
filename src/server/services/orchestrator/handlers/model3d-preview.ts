/**
 * Shared model3DPreview step builder for 3D-model ecosystems (PolyGen, Tripo,
 * Hunyuan3D). Every polyGen-based ecosystem chains the same controllable 2D
 * preview render after its generation step, so the camera pose + step shape
 * live here rather than being copy-pasted into each `*-graph.handler.ts`.
 */

import { buildStepRef } from '../step-ref';

/** Square dimensions of the generated 2D preview (matches the queue card aspect). */
const MODEL_3D_PREVIEW_SIZE = 1024;

/**
 * Single hero camera for the 2D preview render. The PolyGen output already
 * carries a `thumbnail`, but its angle isn't controllable — this straight-on
 * front pose (no yaw, slight downward tilt) keeps the mesh centered and
 * upright rather than the skewed 3/4 view. `distance`/`fov` come from the
 * orchestrator's reference poses.
 */
const MODEL_3D_PREVIEW_CAMERA_POSE = {
  name: 'front',
  yaw: 0,
  pitch: 8,
  distance: 2.8,
  fov: 45,
} as const;

/**
 * Build the chained `model3DPreview` step that renders a single controllable
 * 2D preview of the generated mesh. It references the generation step's GLB via
 * `$ref` — the orchestrator resolves `$<baseStepIndex>` positionally at
 * runtime. `suppressOutput` keeps its image out of the generic output
 * grid/counters; the queue card's 3D renderer reads it directly as the
 * thumbnail.
 */
export function buildModel3DPreviewStep(baseStepIndex: number) {
  return {
    $type: 'model3DPreview',
    input: {
      model: buildStepRef(baseStepIndex, 'output.model.url') as unknown as string,
      format: 'glb',
      width: MODEL_3D_PREVIEW_SIZE,
      height: MODEL_3D_PREVIEW_SIZE,
      outputFormat: 'png',
      cameraPoses: [MODEL_3D_PREVIEW_CAMERA_POSE],
    },
    metadata: { suppressOutput: true },
  };
}
