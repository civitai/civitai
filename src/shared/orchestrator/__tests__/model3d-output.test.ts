import { describe, expect, it } from 'vitest';

import { isFbxOnlyDelivered } from '~/shared/orchestrator/model3d-output';

const mesh = (format: string, available = true) => ({ type: 'model3d', available, format });
const polyGen = (status: string, output: ReturnType<typeof mesh>[]) => ({
  $type: 'polyGen',
  status,
  output,
});
const failedPreview = { $type: 'model3DPreview', status: 'canceled', output: [] };

describe('isFbxOnlyDelivered', () => {
  it('is true for a succeeded FBX-only mesh whose preview was canceled', () => {
    expect(isFbxOnlyDelivered([polyGen('succeeded', [mesh('fbx')]), failedPreview])).toBe(true);
  });

  // A GLB result whose preview failed is a real failure and keeps its own status.
  it('is false for a GLB mesh', () => {
    expect(isFbxOnlyDelivered([polyGen('succeeded', [mesh('GLB')]), failedPreview])).toBe(false);
  });

  it('is false when the generation step itself did not succeed', () => {
    expect(isFbxOnlyDelivered([polyGen('failed', [mesh('fbx')])])).toBe(false);
  });

  it('is false while the FBX is not available yet', () => {
    expect(isFbxOnlyDelivered([polyGen('succeeded', [mesh('fbx', false)])])).toBe(false);
  });
});

describe('isUnratedOutput — 3D meshes', () => {
  const base = {
    type: 'model3d' as const,
    available: true,
    nsfwLevel: undefined,
    blockedReason: null,
  };

  it('holds an unrated FBX-only mesh', async () => {
    const { isUnratedOutput } = await import('~/shared/orchestrator/workflow-data');
    expect(isUnratedOutput({ ...base, format: 'fbx' })).toBe(true);
  });

  it('never holds a GLB mesh, which is rated through its preview render', async () => {
    const { isUnratedOutput } = await import('~/shared/orchestrator/workflow-data');
    expect(isUnratedOutput({ ...base, format: 'glb' })).toBe(false);
  });
});
