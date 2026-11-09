import type { ImageGenStepTemplate } from '@civitai/orchestration-client';
import type { InferData } from 'form-graph';
import type { fibo2 } from '~/shared/form-graph/generation/image/fibo2.graph';
import { fibo2ModelOf, fibo2VersionId } from '~/shared/form-graph/generation/image/fibo2.graph';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras } from './types';

// TODO(fibo2): swap for the client's ComfyFibo2* inputs once @civitai/orchestration-client ships them.
type Fibo2Input = {
  engine: 'comfy';
  ecosystem: 'fibo2';
  model: 'dev' | 'editTurbo';
  operation: 'createImage' | 'editImage';
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  quantity?: number;
  steps?: number;
  cfgScale?: number;
  loras?: Record<string, number>;
  diffusionModel?: string;
  images?: string[];
};

export type Fibo2Data = InferData<typeof fibo2> & { workflow: string; quantity?: number };

export const createFibo2Input = defineHandler<Fibo2Data, [ImageGenStepTemplate]>((data, ctx) => {
  const model = fibo2ModelOf(data.workflow);
  const isEdit = model === 'editTurbo';
  if (fibo2VersionId === undefined) throw new Error('Fibo 2.0 has no official version id set');
  // The official version runs the orchestrator's own weights; a fine-tune of `dev` rides as
  // diffusionModel.
  const checkpoint = 'model' in data ? data.model : undefined;
  const diffusionModel =
    checkpoint && checkpoint.id !== fibo2VersionId ? ctx.airs.getOrThrow(checkpoint.id) : undefined;

  return [
    {
      $type: 'imageGen',
      input: removeEmpty<Fibo2Input>({
        engine: 'comfy',
        ecosystem: 'fibo2',
        model,
        operation: isEdit ? 'editImage' : 'createImage',
        prompt: data.prompt,
        negativePrompt: data.negativePrompt,
        width: data.aspectRatio?.width,
        height: data.aspectRatio?.height,
        steps: data.steps,
        cfgScale: data.cfgScale,
        quantity: data.quantity ?? 1,
        seed: data.seed,
        loras: 'resources' in data ? resourcesToLoras(data.resources, ctx.airs) : undefined,
        diffusionModel,
        images: isEdit ? data.images?.map((x) => x.url) : undefined,
      }) as ImageGenStepTemplate['input'],
    },
  ];
});
