import { describe, expect, it } from 'vitest';

import {
  isFbxOnlyDelivered,
  isGlbFormat,
  isInlineViewableModel3DFile,
  normalizeModel3DFormat,
  pickModel3DPreviewFile,
} from '~/shared/orchestrator/model3d-output';

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

describe('pickModel3DPreviewFile', () => {
  const file = (id: number, format: string, variant: string, isPrimary = false) => ({
    id,
    format,
    variant,
    isPrimary,
  });

  it('previews a GLB variant when the primary is FBX', () => {
    const glb = file(2, 'glb', 'rigged');
    expect(pickModel3DPreviewFile([file(1, 'fbx', 'primary', true), glb])).toBe(glb);
  });

  it('keeps a viewable primary over other GLBs', () => {
    const primary = file(1, 'glb', 'primary', true);
    expect(pickModel3DPreviewFile([file(2, 'glb', 'walking'), primary])).toBe(primary);
  });

  // An armature-only GLB has no geometry, so the FBX primary's download fallback is the better result.
  it('skips armature-only GLBs and falls back to the primary', () => {
    const primary = file(1, 'fbx', 'primary', true);
    expect(pickModel3DPreviewFile([primary, file(2, 'glb', 'walking-armature')])).toBe(primary);
  });

  it('falls back to the first file when none is primary or viewable', () => {
    const first = file(1, 'obj', 'primary');
    expect(pickModel3DPreviewFile([first, file(2, 'fbx', 'rigged')])).toBe(first);
  });

  it('returns null for no files', () => {
    expect(pickModel3DPreviewFile([])).toBeNull();
  });
});

describe('isGlbFormat', () => {
  it.each(['glb', 'GLB', '.glb', ' GLB '])('accepts %j', (format) => {
    expect(isGlbFormat(format)).toBe(true);
  });

  it.each(['fbx', 'gltf', '', null, undefined])('rejects %j', (format) => {
    expect(isGlbFormat(format)).toBe(false);
  });
});

describe('normalizeModel3DFormat', () => {
  it.each([
    ['GLB', 'glb'],
    ['.glb', 'glb'],
    [' .GLTF ', 'gltf'],
    ['fbx', 'fbx'],
    [null, ''],
  ])('%j → %j', (format, expected) => {
    expect(normalizeModel3DFormat(format)).toBe(expected);
  });
});

describe('isInlineViewableModel3DFile', () => {
  it('keeps a GLB whose stored format is not normalised', () => {
    expect(isInlineViewableModel3DFile({ format: '.glb', variant: 'primary' })).toBe(true);
    expect(isInlineViewableModel3DFile({ format: ' GLB ', variant: null })).toBe(true);
  });

  it('drops FBX files and armature-only meshes', () => {
    expect(isInlineViewableModel3DFile({ format: 'fbx', variant: 'primary' })).toBe(false);
    expect(isInlineViewableModel3DFile({ format: 'glb', variant: 'walking-armature' })).toBe(false);
  });
});
