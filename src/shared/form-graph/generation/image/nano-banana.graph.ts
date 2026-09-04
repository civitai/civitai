import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SEED, aspectRatioDef, boolDef, type AspectRatioOption } from '../defs';
import { versionModeOf, familyScope, makeTextBlock, type FamilyExt } from '../shared';

/**
 * Nano Banana (standard / pro / v2 / v2 lite), ported from
 * `nano-banana-graph.ts`. Modes by version id: standard is seed-only, pro adds
 * negative prompt + resolution tiers, v2 swaps the negative prompt for a
 * web-search toggle, v2 lite is aspect ratio + seed at 1K.
 */

// ---- copied from nano-banana-graph.ts / version-ids.ts ----------------------

export type NanoBananaMode = 'standard' | 'pro' | 'v2' | 'v2lite';

export const nanoBananaVersionIds = {
  standard: 2154472,
  pro: 2436219,
  v2: 2725610,
  v2lite: 3086021,
} as const;

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const nanoBananaModeOf = versionModeOf(nanoBananaVersionIds, 'standard');

const nanoBananaModeVersionOptions = [
  { label: 'Standard', value: nanoBananaVersionIds.standard },
  { label: 'Pro', value: nanoBananaVersionIds.pro },
  { label: 'V2', value: nanoBananaVersionIds.v2 },
  { label: 'V2 Lite', value: nanoBananaVersionIds.v2lite },
];

const nanoBananaBaseAspectRatios: AspectRatioOption[] = [
  { label: '21:9', value: '21:9', width: 2520, height: 1080 },
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '3:2', value: '3:2', width: 1620, height: 1080 },
  { label: '4:3', value: '4:3', width: 1440, height: 1080 },
  { label: '5:4', value: '5:4', width: 1350, height: 1080 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:5', value: '4:5', width: 1080, height: 1350 },
  { label: '3:4', value: '3:4', width: 1080, height: 1440 },
  { label: '2:3', value: '2:3', width: 1080, height: 1620 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

const nanoBananaPriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const resolutionOptions = ['1K', '2K', '4K'] as const;

const resolutionMultiplier: Record<string, number> = { '1K': 1, '2K': 2, '4K': 4 };

function getNanoBananaAspectRatios(resolution: string): AspectRatioOption[] {
  const multiplier = resolutionMultiplier[resolution] ?? 1;
  return nanoBananaBaseAspectRatios.map((ar) => ({
    ...ar,
    width: ar.width * multiplier,
    height: ar.height * multiplier,
  }));
}

// ---- end of nano-banana-graph.ts copies -------------------------------------

type NanoBananaModeExt = FamilyExt & { model?: unknown };

const RESOLUTION = {
  input: z.enum(resolutionOptions).optional(),
  output: z.enum(resolutionOptions),
  default: '1K' as (typeof resolutionOptions)[number],
  meta: { options: resolutionOptions.map((r) => ({ label: r, value: r })) },
};

/** Aspect-ratio dims scale with the resolution tier; memoize per key. */
const AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options: getNanoBananaAspectRatios(resolution),
    default: '1:1',
    priorityOptions: nanoBananaPriorityRatios,
  })
);

const standard = defineGraph<NanoBananaModeExt>().field('seed', SEED);

const pro = defineGraph<NanoBananaModeExt>()
  .field('resolution', RESOLUTION)
  .field('aspectRatio', ({ resolution }) => AR(resolution))
  .field('seed', SEED);

const v2 = defineGraph<NanoBananaModeExt>()
  .field('resolution', RESOLUTION)
  .field('aspectRatio', ({ resolution }) => AR(resolution))
  .field('enableWebSearch', boolDef(false))
  .field('seed', SEED);

const v2lite = defineGraph<NanoBananaModeExt>()
  .field(
    'aspectRatio',
    aspectRatioDef({
      options: nanoBananaBaseAspectRatios,
      default: '1:1',
      priorityOptions: nanoBananaPriorityRatios,
    })
  )
  .field('seed', SEED);

/** Tagged: v1's `nanoBananaMode` computed becomes the branch key. */
const modes = branch('nanoBananaMode', (ext: NanoBananaModeExt) => nanoBananaModeOf(ext.model), {
  standard,
  pro,
  v2,
  v2lite,
});

export const nanoBanana = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 7 }))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: nanoBananaModeVersionOptions },
      defaultModelId: nanoBananaVersionIds.standard,
    })
  )
  .use(modes)
  // negativePrompt exists only in pro mode; its in-branch snippet
  // registration never fires
  .use(
    makeTextBlock({
      negativePrompt: (ext) => nanoBananaModeOf(ext.model) === 'pro',
      negativePromptRegistersTarget: false,
    })
  );

export { nanoBananaModeVersionOptions };
