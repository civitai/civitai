import { z } from 'zod';
import { defineGraph } from 'form-graph';
import type { GenerationCtx } from '~/shared/generation/context';
import {
  preprocessKindParamSpecs,
  preprocessKinds,
  type PreprocessKind,
} from '~/shared/generation/preprocess-specs';
import { optionFallback, imagesDef, sliderDef } from '../defs';

/**
 * The remaining standalone image workflows — remove-background and preprocess, plus
 * the two EMPTY graphs (`img2meta`, `prompt:enhance`) whose UIs are fully
 * self-contained panels — they exist so every workflow value has an arm.
 *
 * The preprocess kind list and per-kind param specs are imported from the shared
 * module: they mirror the @civitai/orchestration-client `PreprocessImageInput` union, not
 * the graph engine, and duplicating 36 kinds' specs would only drift.
 */

export const backgroundRemovalModels = ['birefnet', 'rmbg3'] as const;
export type BackgroundRemovalModel = (typeof backgroundRemovalModels)[number];

export const imageRemoveBackground = defineGraph<GenerationCtx>()
  .field('images', imagesDef({}))
  .field('backgroundRemovalModel', {
    input: z.enum(backgroundRemovalModels).optional(),
    output: z.enum(backgroundRemovalModels),
    default: 'birefnet' as BackgroundRemovalModel,
    correct: optionFallback(backgroundRemovalModels, 'birefnet' as BackgroundRemovalModel),
    meta: {
      options: [
        { label: 'Standard', value: 'birefnet' },
        { label: 'RMBG 3.0', value: 'rmbg3' },
      ] as { label: string; value: BackgroundRemovalModel }[],
    },
  });

const kindParamsSchema = z.record(z.string(), z.unknown());
const kindParamsInput = kindParamsSchema.optional();

export const imagePreprocess = defineGraph<GenerationCtx>()
  .field('images', imagesDef({ min: 1, max: 1 }))
  .field('preprocessKind', {
    input: z.enum(preprocessKinds).optional(),
    output: z.enum(preprocessKinds),
    default: 'canny' as PreprocessKind,
    correct: optionFallback(preprocessKinds, 'canny' as PreprocessKind),
    meta: { options: preprocessKinds.map((value) => ({ label: value, value })) },
  })
  .field('preprocessResolution', sliderDef({ min: 64, max: 2048, step: 8, default: 512 }))
  .field('kindParams', ({ preprocessKind }) => ({
    input: kindParamsInput,
    output: kindParamsSchema,
    default: {} as Record<string, unknown>,
    meta: {
      specs: preprocessKind ? preprocessKindParamSpecs[preprocessKind] : [],
    },
  }));

export const metadataExtraction = defineGraph<GenerationCtx>();

export const promptEnhancement = defineGraph<GenerationCtx>();
