import type { NsfwLevel } from '@civitai/orchestration-client';
import type { Model3dBlob } from '@civitai/orchestration-client';
import { isMature } from '~/shared/constants/orchestrator.constants';
import { isGlbFormat } from '~/shared/orchestrator/model3d-output';

type PolyGenBaseModels = {
  model?: Model3dBlob | null;
  fbxModel?: Model3dBlob | null;
};

/**
 * The base mesh a PolyGen result delivers. Usually the GLB in `model`, but
 * Tripo with `quad: true` only produces an FBX: newer workflows leave `model`
 * null, older ones carry a GLB blob that never became available. In both
 * cases the FBX in `fbxModel` is the deliverable.
 */
export function getPolyGenPrimaryModel(output: PolyGenBaseModels): Model3dBlob | undefined {
  const { model, fbxModel } = output;
  if (!model) return fbxModel ?? undefined;
  if (!model.available && fbxModel?.available) return fbxModel;
  return model;
}

/**
 * Why a PolyGen result can't be posted yet, if it can't. The mesh is never rated, so its rating
 * comes from the preview render and auto-thumbnail; a non-GLB result has no preview render, and
 * with no rated thumbnail either it would otherwise pass every mature-content gate unrated.
 */
export function getPolyGenPostBlock({
  primaryModel,
  effectiveNsfwLevel,
  allowMatureContent,
}: {
  primaryModel: Pick<Model3dBlob, 'format'>;
  effectiveNsfwLevel: NsfwLevel | undefined;
  allowMatureContent: boolean | null | undefined;
}): string | undefined {
  if (!effectiveNsfwLevel && !isGlbFormat(primaryModel.format))
    return "This 3D model hasn't been rated yet. Try again in a few minutes.";
  if (allowMatureContent === false && isMature(effectiveNsfwLevel))
    return 'This 3D model was rated mature. Unlock it with Yellow Buzz before posting.';
}
