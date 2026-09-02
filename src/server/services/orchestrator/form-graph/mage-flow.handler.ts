/** Mage Flow handler for the form-graph lane — comfy imageGen, model by version id. */

import type {
  ComfyMageFlow4bCreateImageGenInput,
  ComfyMageFlow4bEditImageInput,
  ComfyMageFlow4bEditTurboImageInput,
  ComfyMageFlow4bTurboCreateImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { mageFlowVersionIds } from '~/shared/form-graph/generation/image/mage-flow.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

type MageFlowModel = '4b' | '4b-turbo' | '4b-edit' | '4b-edit-turbo';

const versionToModel = new Map<number, MageFlowModel>([
  [mageFlowVersionIds.txt2img_standard, '4b'],
  [mageFlowVersionIds.txt2img_turbo, '4b-turbo'],
  [mageFlowVersionIds.edit_standard, '4b-edit'],
  [mageFlowVersionIds.edit_turbo, '4b-edit-turbo'],
]);

const isTurboModel = (model: MageFlowModel) => model === '4b-turbo' || model === '4b-edit-turbo';

export const createMageFlowInput = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for Mage Flow workflows');

    const isTxt2Img = (data.workflow ?? '').startsWith('txt');
    const model = (data.model ? versionToModel.get(data.model.id) : undefined) ?? '4b';
    if (isTxt2Img !== (model === '4b' || model === '4b-turbo'))
      throw new Error(`Mage Flow model ${model} cannot be used for ${data.workflow}`);

    const turbo = isTurboModel(model);
    const baseInput = {
      engine: 'comfy',
      ecosystem: 'mageflow',
      prompt: data.prompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      steps: data.steps ?? (turbo ? 4 : 30),
      cfgScale: data.cfgScale ?? (turbo ? 1 : 5),
      quantity: data.quantity ?? 1,
      seed: data.seed,
      diffusionModel: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
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
  }
);
