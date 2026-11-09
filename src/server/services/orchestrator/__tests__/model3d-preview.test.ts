import { describe, expect, it } from 'vitest';

import { buildModel3DPreviewStep } from '../handlers/model3d-preview';

describe('buildModel3DPreviewStep', () => {
  it('preserves the existing front-view GLB preview for current callers', () => {
    const step = buildModel3DPreviewStep(0);
    expect(step.input.format).toBe('glb');
    expect(step.input.cameraPoses).toEqual([
      { name: 'front', yaw: 0, pitch: 8, distance: 2.8, fov: 45 },
    ]);
  });

  it('references the IDOL result and selects all default PLY views', () => {
    const step = buildModel3DPreviewStep(3, 'ply');
    expect(step).toMatchObject({
      $type: 'model3DPreview',
      input: {
        model: { $ref: '$3', path: 'output.model.url' },
        format: 'ply',
        cameraPoses: [],
        width: 1024,
        height: 1024,
      },
      metadata: { suppressOutput: true },
    });
  });
});
