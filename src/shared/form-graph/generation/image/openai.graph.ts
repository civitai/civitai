import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SEED, aspectRatioDef, boolDef } from '../defs';
import { familyScope, modelIdOf, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * OpenAI (v1 / v1.5 / v2), ported from `openai-graph.ts`. GPT-1 builds expose
 * a transparency toggle; both expose quality. Seed lives at the top level
 * even though GPT-2 ignores it (keeps the ctx union shape consistent). No
 * negative prompt.
 */

// ---- copied from openai-graph.ts, which dies with the data-graph engine -----

export const openaiVersionIds = {
  v1: 1733399,
  'v1.5': 2512167,
  v2: 2880272,
} as const;

const openaiModeVersionOptions = [
  { label: 'v1', value: openaiVersionIds.v1 },
  { label: 'v1.5', value: openaiVersionIds['v1.5'] },
  { label: 'v2', value: openaiVersionIds.v2 },
];

const defaultOpenaiVersionId = Object.values(openaiVersionIds).slice(-1)[0];

type OpenAIVariant = 'gpt1' | 'gpt2';

const versionIdToVariant = new Map<number, OpenAIVariant>([
  [openaiVersionIds.v1, 'gpt1'],
  [openaiVersionIds['v1.5'], 'gpt1'],
  [openaiVersionIds.v2, 'gpt2'],
]);

const openaiAspectRatios = [
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1536, height: 1024 },
  { label: '2:3', value: '2:3', width: 1024, height: 1536 },
];

export const qualityOptions = ['high', 'medium', 'low'] as const;
type OpenAIQuality = (typeof qualityOptions)[number];

const QUALITY = {
  input: z.enum(qualityOptions).optional(),
  output: z.enum(qualityOptions),
  default: 'high' as OpenAIQuality,
  meta: {
    options: qualityOptions.map((q) => ({
      label: q.charAt(0).toUpperCase() + q.slice(1),
      value: q,
    })),
  },
};

// ---- end of openai-graph.ts copies ------------------------------------------

type OpenAIModeExt = FamilyExt & { model?: unknown };

const variantOf = (ext: OpenAIModeExt): OpenAIVariant => {
  const id = modelIdOf(ext.model);
  return (id != null ? versionIdToVariant.get(id) : undefined) ?? 'gpt2';
};

const gpt1 = defineGraph<OpenAIModeExt>()
  .scope(familyScope)
  .field('transparent', boolDef(false))
  .field('quality', QUALITY);

const gpt2 = defineGraph<OpenAIModeExt>().scope(familyScope).field('quality', QUALITY);

/** Tagged: v1's `openaiVariant` computed becomes the branch key. */
const variants = branch('openaiVariant', variantOf, { gpt1, gpt2 });

export const openai = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('images', img2imgImages({ max: 7 }))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: openaiModeVersionOptions },
      defaultModelId: defaultOpenaiVersionId,
    })
  )
  .field('aspectRatio', aspectRatioDef({ options: openaiAspectRatios, default: '1:1' }))
  .field('seed', SEED)
  .use(variants)
  .use(promptOnlyTextBlock);

export { openaiModeVersionOptions };
