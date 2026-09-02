/** Hunyuan video handler for the form-graph lane — array-shaped loras. */

import type { HunyuanVdeoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

export const createHunyuanInput = defineHandler<LooseGenerationData, [VideoGenStepTemplate]>(
  (data, ctx) => {
    const loras: { air: string; strength: number }[] = [];
    for (const resource of data.resources ?? []) {
      loras.push({
        air: ctx.airs.getOrThrow(resource.id),
        strength: resource.strength ?? 1,
      });
    }

    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          engine: 'hunyuan',
          prompt: data.prompt,
          width: data.aspectRatio?.width,
          height: data.aspectRatio?.height,
          cfgScale: data.cfgScale,
          steps: data.steps,
          duration: (data as { duration?: number }).duration,
          quantity: data.quantity ?? 1,
          seed: data.seed,
          loras: loras.length > 0 ? loras : undefined,
        }) as HunyuanVdeoGenInput,
      },
    ];
  }
);
