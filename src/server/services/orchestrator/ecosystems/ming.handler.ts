import type { ImageGenStepTemplate } from '@civitai/orchestration-client';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';
import { buildMingStep } from './ming-input';

type MingCtx = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }> & { ecosystem: 'Ming' };

export const createMingInput = defineHandler<MingCtx, [ImageGenStepTemplate]>((data, ctx) => {
  const loras: Record<string, number> = {};
  for (const resource of data.resources ?? []) {
    loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
  }
  return [buildMingStep(data, Object.keys(loras).length ? loras : undefined)];
});
