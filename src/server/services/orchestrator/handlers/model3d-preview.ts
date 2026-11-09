import type { Model3dPreviewStepTemplate } from '@civitai/orchestration-client';

import { buildStepRef } from '../step-ref';

const MODEL_3D_PREVIEW_SIZE = 1024;
const MODEL_3D_PREVIEW_CAMERA_POSE = {
  name: 'front',
  yaw: 0,
  pitch: 8,
  distance: 2.8,
  fov: 45,
} as const;

export function buildModel3DPreviewStep(
  baseStepIndex: number,
  format: 'glb' | 'ply' = 'glb'
): Model3dPreviewStepTemplate {
  return {
    $type: 'model3DPreview',
    input: {
      model: buildStepRef(baseStepIndex, 'output.model.url') as unknown as string,
      format,
      width: MODEL_3D_PREVIEW_SIZE,
      height: MODEL_3D_PREVIEW_SIZE,
      outputFormat: 'png',
      // An empty pose list selects the backend's eight default views.
      cameraPoses: format === 'ply' ? [] : [MODEL_3D_PREVIEW_CAMERA_POSE],
    },
    metadata: { suppressOutput: true },
  };
}
