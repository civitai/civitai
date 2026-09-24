import type { ImageGenStepTemplate } from '@civitai/orchestration-client';
import { defineHandler } from '../ecosystems/handler-factory';
import { buildMingStep } from '../ecosystems/ming-input';
import { resourcesToLoras, type EcosystemData } from './types';

export const createMingInput = defineHandler<EcosystemData<'Ming'>, [ImageGenStepTemplate]>(
  (data, ctx) => [buildMingStep(data, resourcesToLoras(data.resources, ctx.airs))]
);
