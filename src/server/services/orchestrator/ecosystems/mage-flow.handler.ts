/**
 * Mage Flow Ecosystem Handler
 *
 * Handles MageFlow workflows using the imageGen step type (comfy engine).
 *
 * The orchestrator exposes four models — `4b` / `4b-turbo` for create and
 * `4b-edit` / `4b-edit-turbo` for edit. Upstream's Base checkpoints have no
 * orchestrator model, so they are download-only and never reach the picker.
 *
 * `steps`, `cfgScale`, and `quantity` are required by the input contract, so
 * they fall back to the model card's recommended values rather than being
 * dropped by `removeEmpty`.
 */

import type {
  ComfyMageFlow4bCreateImageGenInput,
  ComfyMageFlow4bEditImageInput,
  ComfyMageFlow4bEditTurboImageInput,
  ComfyMageFlow4bTurboCreateImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { mageFlowVersionIds } from '~/shared/data-graph/generation/mage-flow-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MageFlowCtx = EcosystemGraphOutput & { ecosystem: 'MageFlow' };

type MageFlowModel = '4b' | '4b-turbo' | '4b-edit' | '4b-edit-turbo';

const versionToModel = new Map<number, MageFlowModel>([
  [mageFlowVersionIds.txt2img_standard, '4b'],
  [mageFlowVersionIds.txt2img_turbo, '4b-turbo'],
  [mageFlowVersionIds.edit_standard, '4b-edit'],
  [mageFlowVersionIds.edit_turbo, '4b-edit-turbo'],
]);

const isTurbo = (model: MageFlowModel) => model === '4b-turbo' || model === '4b-edit-turbo';

export const createMageFlowInput = defineHandler<MageFlowCtx, [ImageGenStepTemplate]>((data) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Mage Flow workflows');

  const isTxt2Img = data.workflow.startsWith('txt');
  const model = (data.model ? versionToModel.get(data.model.id) : undefined) ?? '4b';
  if (isTxt2Img !== (model === '4b' || model === '4b-turbo'))
    throw new Error(`Mage Flow model ${model} cannot be used for ${data.workflow}`);

  const turbo = isTurbo(model);
  const baseInput = {
    engine: 'comfy',
    ecosystem: 'mageflow',
    prompt: data.prompt,
    width: data.aspectRatio.width,
    height: data.aspectRatio.height,
    steps: ('steps' in data ? data.steps : undefined) ?? (turbo ? 4 : 30),
    cfgScale: ('cfgScale' in data ? data.cfgScale : undefined) ?? (turbo ? 1 : 5),
    quantity: data.quantity ?? 1,
    seed: data.seed,
  } as const;

  if (isTxt2Img) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({ ...baseInput, operation: 'createImage', model }) as
          | ComfyMageFlow4bCreateImageGenInput
          | ComfyMageFlow4bTurboCreateImageGenInput,
      } as ImageGenStepTemplate,
    ];
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...baseInput,
        operation: 'editImage',
        model,
        images: data.images?.map((x) => x.url) ?? [],
      }) as ComfyMageFlow4bEditImageInput | ComfyMageFlow4bEditTurboImageInput,
    } as ImageGenStepTemplate,
  ];
});
