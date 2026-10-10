import type { ImageGenStepTemplate } from '@civitai/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { isTrustedOrchestratorUrl } from '~/server/services/orchestrator/trusted-blob-url';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { findAvatarStarter } from '~/shared/constants/avatar-starters';
import type { AvatarEditModel, AvatarStyle } from '~/shared/constants/avatar-styles.constants';
import {
  AVATAR_RESTYLE_NEGATIVE_PROMPT,
  AVATAR_SIZE,
  AVATAR_WORKFLOW,
  avatarEditModelByVersionId,
  avatarStyleByKey,
  buildAvatarEditPrompt,
  buildAvatarRestylePrompt,
} from '~/shared/constants/avatar-styles.constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationHandlerCtx, StepInput } from '../handlers';
import type { GenerationData, LooseGenerationData } from './types';
import { resourcesToLoras } from './types';

const KREA_STEPS = 30;
const KREA_CFG_SCALE = 3;

function getStyle(key: unknown) {
  const style = typeof key === 'string' ? avatarStyleByKey.get(key) : undefined;
  if (!style) throw throwBadRequestError('Unknown avatar style');
  return style;
}

function getModel(model: unknown) {
  const versionId = (model as { id?: number } | undefined)?.id;
  const editModel = versionId != null ? avatarEditModelByVersionId.get(versionId) : undefined;
  if (!editModel) throw throwBadRequestError('Unknown avatar model');
  return editModel;
}

/**
 * A stored starter on our CDN. Free-palette styles send the greyscale copy, so the prompt rather
 * than the reference decides the colours.
 */
function starterReferenceUrl(style: AvatarStyle, reference: string) {
  const starter = findAvatarStarter(style.key, reference);
  if (!starter) throw throwBadRequestError('Pick a reference image');
  return getEdgeUrl(style.fixedPalette ? starter.colour.url : starter.grey.url, { original: true });
}

/**
 * Fills in the reference, the prompt and (for Krea 2) the style's LoRA, so pricing and image
 * metadata see what is actually sent. The reference is a stored starter or, when refining, an earlier
 * result, which goes in as it is: its colours are part of what is being refined.
 */
export function expandAvatarData(data: GenerationData): GenerationData {
  if (data.workflow !== AVATAR_WORKFLOW) return data;
  const loose = data as LooseGenerationData;
  const style = getStyle(loose.avatarStyle);
  const model = getModel(loose.model);
  if (!loose.images?.[0]?.url) throw throwBadRequestError('A portrait image is required');

  const reference = typeof loose.avatarReference === 'string' ? loose.avatarReference : '';
  const parent = typeof loose.avatarParentImage === 'string' ? loose.avatarParentImage : '';
  const refining = !!parent && reference === parent && isTrustedOrchestratorUrl(parent);
  const options = {
    palette: loose.avatarPalette as string | undefined,
    character: loose.avatarCharacter as string | undefined,
    refining,
  };

  if (!model.usesReference)
    return {
      ...data,
      ...(refining ? { avatarReferenceUrl: parent } : {}),
      resources: style.lora ? [{ id: style.lora, strength: 1, model: { type: 'LORA' } }] : [],
      prompt: buildAvatarRestylePrompt(style, options),
      negativePrompt: AVATAR_RESTYLE_NEGATIVE_PROMPT,
    } as unknown as GenerationData;

  return {
    ...data,
    avatarReferenceUrl: refining ? parent : starterReferenceUrl(style, reference),
    resources: [],
    prompt: buildAvatarEditPrompt(style, options),
  } as unknown as GenerationData;
}

export function createAvatarSteps(
  data: LooseGenerationData,
  ctx: GenerationHandlerCtx
): StepInput[] {
  const model = getModel(data.model);
  const portrait = data.images?.[0]?.url;
  const reference = (data as { avatarReferenceUrl?: string }).avatarReferenceUrl;
  if (!portrait || (model.usesReference && !reference))
    throw throwBadRequestError('Avatar images were not resolved');
  const images = reference ? [portrait, reference] : [portrait];
  const prompt = data.prompt ?? '';
  const quantity = data.quantity ?? 1;

  const inputs: Record<AvatarEditModel, () => Record<string, unknown>> = {
    'nano-banana-2': () => ({
      engine: 'google',
      model: 'nano-banana-2',
      images,
      prompt,
      aspectRatio: '1:1',
      numImages: quantity,
      seed: data.seed,
    }),
    'nano-banana-pro': () => ({
      engine: 'google',
      model: 'nano-banana-pro',
      images,
      prompt,
      aspectRatio: '1:1',
      numImages: quantity,
      seed: data.seed,
    }),
    'gpt-image-2.5-flare': () => ({
      engine: 'openai',
      model: 'gpt-image-2.5-flare',
      operation: 'editImage',
      images,
      prompt,
      quality: 'medium',
      quantity,
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
    }),
    'krea2-raw': () => ({
      engine: 'comfy',
      ecosystem: 'krea2',
      model: 'edit',
      operation: 'editImage',
      diffusionModel: ctx.airs.getOrThrow(model.versionId),
      images,
      prompt,
      negativePrompt: data.negativePrompt,
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      steps: KREA_STEPS,
      cfgScale: KREA_CFG_SCALE,
      sampler: 'euler',
      scheduler: 'simple',
      seed: data.seed,
      quantity,
      loras: resourcesToLoras(data.resources, ctx.airs),
    }),
  };
  const input = inputs[model.key]();
  return [{ $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate as StepInput];
}
