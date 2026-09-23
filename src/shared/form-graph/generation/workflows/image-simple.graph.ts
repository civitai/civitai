import { z } from 'zod';
import { defineGraph } from 'form-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import {
  preprocessKindParamSpecs,
  preprocessKinds,
  type PreprocessKind,
} from '~/shared/data-graph/generation/image-preprocess-graph';
import { imagesDef, sliderDef } from '../defs';

/**
 * The remaining standalone image workflows, ported from
 * `image-remove-background-graph.ts` and `image-preprocess-graph.ts`, plus
 * the two EMPTY graphs (`img2meta`, `prompt:enhance`) whose UIs are fully
 * self-contained panels — they exist so every workflow value has an arm.
 *
 * The preprocess kind list and per-kind param specs are imported from the v1
 * module: they mirror the @civitai/client `PreprocessImageInput` union, not
 * the graph engine, and duplicating 36 kinds' specs would only drift.
 */

export const imageRemoveBackground = defineGraph<GenerationCtx>().field('images', imagesDef({}));

const kindParamsSchema = z.record(z.string(), z.unknown());

export const imagePreprocess = defineGraph<GenerationCtx>()
  .field('images', imagesDef({ min: 1, max: 1 }))
  .field('preprocessKind', {
    input: z.enum(preprocessKinds).optional(),
    output: z.enum(preprocessKinds),
    default: 'canny' as PreprocessKind,
    meta: { options: preprocessKinds.map((value) => ({ label: value, value })) },
  })
  .field('preprocessResolution', sliderDef({ min: 64, max: 2048, step: 8, default: 512 }))
  .field('kindParams', ({ preprocessKind }) => ({
    input: kindParamsSchema.optional(),
    output: kindParamsSchema,
    default: {} as Record<string, unknown>,
    meta: {
      specs: preprocessKind ? preprocessKindParamSpecs[preprocessKind] : [],
    },
  }));

export const metadataExtraction = defineGraph<GenerationCtx>();

export const promptEnhancement = defineGraph<GenerationCtx>();
