import { describe, expect, it } from 'vitest';
import {
  getModel3dDetailRows,
  migrateModel3dParams,
} from '~/shared/form-graph/generation/model3d/model3d-params';

describe('migrateModel3dParams', () => {
  it('renames the old prefixed Hunyuan and PolyGen keys', () => {
    expect(
      migrateModel3dParams({
        ecosystem: 'Hunyuan3D',
        hunyuanPrompt: 'a chair',
        hunyuanModelVersion: 'v2.1',
        hunyuanSteps: 30,
        hunyuanCfgScale: 5,
        hunyuanOctreeResolution: 384,
      })
    ).toEqual({
      ecosystem: 'Hunyuan3D',
      prompt: 'a chair',
      version: 'v2.1',
      steps: 30,
      cfgScale: 5,
      octreeResolution: 384,
    });
    expect(
      migrateModel3dParams({ polygenVersion: 'v7', polygenMode: 'preview', pbr: true })
    ).toEqual({ version: 'v7', mode: 'preview', enablePbr: true });
  });

  it('treats a versionless Tripo record as v2.5', () => {
    expect(migrateModel3dParams({ ecosystem: 'Tripo', pbr: false })).toEqual({
      ecosystem: 'Tripo',
      enablePbr: false,
      version: 'v2.5',
    });
  });

  it('keeps a current key over a legacy one', () => {
    expect(migrateModel3dParams({ polygenVersion: 'v6', version: 'v7' })).toEqual({
      version: 'v7',
    });
  });
});

describe('getModel3dDetailRows', () => {
  it('shows a Tripo model with its option labels', () => {
    const rows = getModel3dDetailRows({
      ecosystem: 'Tripo',
      workflow: 'img2model3d',
      version: 'h3.1',
      texture: 'HD',
      geometryQuality: 'detailed',
      faceLimit: 200000,
      pbr: true,
      seed: 1234567,
    });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Version', 'H3.1'],
      ['Texture', 'HD'],
      ['Geometry quality', 'Detailed'],
      ['Face limit', (200000).toLocaleString()],
      ['PBR textures', 'Yes'],
      ['Seed', '1234567'],
    ]);
  });

  it('reads a legacy PolyGen row', () => {
    const rows = getModel3dDetailRows({
      ecosystem: 'PolyGen',
      polygenVersion: 'v7',
      topology: 'quad',
      enableRigging: true,
    });
    expect(rows.map((r) => r.label)).toEqual(['Version', 'Topology']);
    expect(rows[0].value).toBe('v7');
  });
});
