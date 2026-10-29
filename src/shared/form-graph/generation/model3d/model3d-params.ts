/**
 * The one place 3D generation params are named for people and for history:
 * the form's control labels, the published 3D model's details panel, and the
 * translation of field names the graphs have since dropped.
 */

import { hunyuan3dModelVersionOptions, hunyuan3dOctreeResolutionOptions } from './hunyuan3d.graph';
import {
  polygenModelTypeOptions,
  polygenPoseModeOptions,
  polygenSymmetryOptions,
  polygenTextModeOptions,
  polygenTopologyOptions,
  polygenVersionOptions,
} from './polygen.graph';
import {
  tripoGeometryQualityOptions,
  tripoOrientationOptions,
  tripoTextureAlignmentOptions,
  tripoTextureOptions,
  tripoVersionOptions,
} from './tripo.graph';

/** Label per 3D graph field, shared by the form controls and the details panel. */
export const model3dFieldLabels = {
  version: 'Version',
  mode: 'Mode',
  prompt: 'Prompt',
  enablePromptExpansion: 'Enhance prompt',
  shouldTexture: 'Generate texture',
  targetPolycount: 'Target polycount',
  topology: 'Topology',
  symmetryMode: 'Symmetry',
  poseMode: 'Pose',
  modelType: 'Model type',
  ultraMode: 'Ultra fidelity',
  texture: 'Texture',
  geometryQuality: 'Geometry quality',
  textureAlignment: 'Texture alignment',
  orientation: 'Orientation',
  quad: 'Quad topology',
  autoSize: 'Auto size',
  faceLimit: 'Face limit',
  steps: 'Steps',
  cfgScale: 'CFG scale',
  octreeResolution: 'Octree resolution',
  texturePrompt: 'Texture prompt',
  shouldRemesh: 'Remesh',
  enablePbr: 'PBR textures',
  enableAnimation: 'Animate',
  riggingHeightMeters: 'Character height (m)',
  animationActionId: 'Animation preset',
  seed: 'Seed',
  textureSeed: 'Texture seed',
} as const;

export type Model3dField = keyof typeof model3dFieldLabels;

/** Field names stored by earlier generations (workflow metadata, `Model3D.generationParams`). */
const legacyFieldNames: Record<string, Model3dField> = {
  polygenVersion: 'version',
  polygenMode: 'mode',
  hunyuanPrompt: 'prompt',
  hunyuanModelVersion: 'version',
  hunyuanSteps: 'steps',
  hunyuanCfgScale: 'cfgScale',
  hunyuanOctreeResolution: 'octreeResolution',
  pbr: 'enablePbr',
};

/** Renames legacy 3D param keys to the current field names; a current key wins over a legacy one. */
export function migrateModel3dParams<T extends Record<string, unknown>>(params: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const current = legacyFieldNames[key];
    if (!current) out[key] = value;
    else if (params[current] === undefined) out[current] = value;
  }
  // Tripo had no version picker before H3.1, so a versionless Tripo record ran v2.5
  if (out.ecosystem === 'Tripo' && out.version === undefined) out.version = 'v2.5';
  return out as T;
}

type Option = { label: string; value: string | number };

// `version` and `mode` mean different things per ecosystem, so option labels are keyed by both.
const optionsByEcosystem: Record<string, Partial<Record<Model3dField, readonly Option[]>>> = {
  PolyGen: {
    version: polygenVersionOptions,
    mode: polygenTextModeOptions,
    topology: polygenTopologyOptions,
    symmetryMode: polygenSymmetryOptions,
    poseMode: polygenPoseModeOptions,
    modelType: polygenModelTypeOptions,
  },
  Tripo: {
    version: tripoVersionOptions,
    texture: tripoTextureOptions,
    geometryQuality: tripoGeometryQualityOptions,
    textureAlignment: tripoTextureAlignmentOptions,
    orientation: tripoOrientationOptions,
  },
  Hunyuan3D: {
    version: hunyuan3dModelVersionOptions,
    octreeResolution: hunyuan3dOctreeResolutionOptions,
  },
};

// Seeds and ids read wrong with digit grouping; only counts get it.
const countFields = new Set<Model3dField>(['targetPolycount', 'faceLimit']);

/**
 * The stored params of a 3D generation as `[field, label, value]` rows, in form
 * order. Enum values show their option label; booleans show Yes / No.
 */
export function getModel3dDetailRows(params: Record<string, unknown>) {
  const migrated = migrateModel3dParams(params);
  const ecosystem = typeof migrated.ecosystem === 'string' ? migrated.ecosystem : 'PolyGen';
  const options = optionsByEcosystem[ecosystem] ?? {};

  const rows: Array<{ field: Model3dField; label: string; value: string }> = [];
  for (const field of Object.keys(model3dFieldLabels) as Model3dField[]) {
    const value = migrated[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      continue;
    const option = options[field]?.find((o) => o.value === value);
    rows.push({
      field,
      label: model3dFieldLabels[field],
      value: option
        ? option.label
        : typeof value === 'boolean'
        ? value
          ? 'Yes'
          : 'No'
        : typeof value === 'number' && countFields.has(field)
        ? value.toLocaleString()
        : String(value),
    });
  }
  return rows;
}
