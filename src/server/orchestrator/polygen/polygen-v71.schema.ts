/**
 * PolyGen v7.1 (Meshy v7.1 via Fal)
 *
 * v7.1 brings text-to-3D back alongside v7's single- and multi-image
 * operations, swaps v7's ultra/low-poly options for a smart-topology model
 * type and a geometry resolution, and keeps v7's pose/rigging/animation
 * controls. As on v7, the image operation is derived from the image count.
 */

import type {
  MeshyV71ImageTo3dFalPolyGenInput,
  MeshyV71MultiImageTo3dFalPolyGenInput,
  MeshyV71TextTo3dFalPolyGenInput,
} from '@civitai/orchestration-client';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { dropUndefined } from '~/server/orchestrator/polygen/polygen.schema';
import {
  toMeshyV7LineSharedInput,
  type MeshyV7LineSharedData,
} from '~/server/orchestrator/polygen/polygen-v7.schema';

export const polygenV71ModelTypes = ['standard', 'smart-topology'] as const;
export const polygenV71GeometryResolutions = ['standard', '2k', '4k'] as const;

type MeshyV71ModelType = (typeof polygenV71ModelTypes)[number];
type MeshyV71GeometryResolution = (typeof polygenV71GeometryResolutions)[number];

export type MeshyV71PolyGenInput =
  | MeshyV71TextTo3dFalPolyGenInput
  | MeshyV71ImageTo3dFalPolyGenInput
  | MeshyV71MultiImageTo3dFalPolyGenInput;

export type PolyGenV71GenerationData = MeshyV7LineSharedData & {
  process: 'textTo3D' | 'imageTo3D';
  prompt?: string;
  mode?: 'preview' | 'full';
  enablePromptExpansion?: boolean;
  seed?: number;
  sourceImages?: SourceImageProps[];
  shouldTexture?: boolean;
  modelType?: MeshyV71ModelType;
  geometryResolution?: MeshyV71GeometryResolution;
};

export function toMeshyV71PolyGenInput(data: PolyGenV71GenerationData): MeshyV71PolyGenInput {
  // 2K/4K geometry requires the standard model type.
  const geometryResolution =
    data.modelType === 'smart-topology' ? undefined : data.geometryResolution;

  const shared = toMeshyV7LineSharedInput(data, 'v7.1');

  if (data.process === 'textTo3D') {
    return dropUndefined({
      ...shared,
      operation: 'textTo3D' as const,
      prompt: data.prompt ?? '',
      mode: data.mode,
      enablePromptExpansion: data.enablePromptExpansion,
      seed: data.seed,
      modelType: data.modelType,
      geometryResolution,
    });
  }

  const images = data.sourceImages ?? [];
  if (images.length > 1) {
    return dropUndefined({
      ...shared,
      operation: 'multiImageTo3D' as const,
      imageUrls: images.map((image) => image.url),
      shouldTexture: data.shouldTexture,
      // Multi-image tops out at 2K and has no model type.
      geometryResolution:
        data.geometryResolution === '4k' ? ('2k' as const) : data.geometryResolution,
    });
  }

  return dropUndefined({
    ...shared,
    operation: 'imageTo3D' as const,
    imageUrl: images[0]?.url ?? '',
    shouldTexture: data.shouldTexture,
    modelType: data.modelType,
    geometryResolution,
  });
}
