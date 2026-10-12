/** Hunyuan video handler for the form-graph lane — array-shaped loras. */

import type { HunyuanVdeoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

export const createHunyuanInput = defineHandler<EcosystemData<'HyV1'>, [VideoGenStepTemplate]>(
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
          // Unnamed, the orchestrator picks its own Hunyuan build, which the site's coverage never saw.
          model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
          prompt: data.prompt,
          width: data.aspectRatio?.width,
          height: data.aspectRatio?.height,
          cfgScale: data.cfgScale,
          steps: data.steps,
          duration: data.duration,
          quantity: data.quantity ?? 1,
          seed: data.seed,
          loras: loras.length > 0 ? loras : undefined,
        }) as HunyuanVdeoGenInput,
      },
    ];
  }
);
