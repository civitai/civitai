import { branch, defFamily, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import {
  SEED,
  aspectRatioDef,
  enumDef,
  sliderDef,
  img2imgImages,
  type AspectRatioOption,
} from '../defs';
import { familyResources, familyScope, makeTextBlock, modelIdOf, type FamilyExt } from '../shared';

/**
 * HiDream-O1 (full + dev), ported from `hi-dream-o1-graph.ts`. Both variants
 * carry LoRAs, a 1K/2K resolution tier, and a negative prompt; dev is the
 * distilled build (cfg 1). v1 omits its snippetsGraph entirely, so there is no
 * snippets key even with the wildcards flag on.
 */

// ---- copied from hi-dream-o1-graph.ts, which dies with the data-graph engine

export const hiDreamO1VersionIds = {
  full: 2939946,
  dev: 2939964,
} as const;

type HiDreamO1Variant = 'full' | 'dev';

const hiDreamO1VersionOptions = [
  { label: 'Full', value: hiDreamO1VersionIds.full },
  { label: 'Dev', value: hiDreamO1VersionIds.dev },
];

const versionIdToVariant = new Map<number, HiDreamO1Variant>([
  [hiDreamO1VersionIds.full, 'full'],
  [hiDreamO1VersionIds.dev, 'dev'],
]);

const hiDreamO1ResolutionOptions = [
  { label: '1K', value: '1K' },
  { label: '2K', value: '2K' },
] as const;

const hiDreamO1AspectRatiosByResolution: Record<string, AspectRatioOption[]> = {
  '1K': [
    { label: '16:9', value: '16:9', width: 1408, height: 768 },
    { label: '3:2', value: '3:2', width: 1216, height: 832 },
    { label: '4:3', value: '4:3', width: 1152, height: 896 },
    { label: '1:1', value: '1:1', width: 1024, height: 1024 },
    { label: '3:4', value: '3:4', width: 896, height: 1152 },
    { label: '2:3', value: '2:3', width: 832, height: 1216 },
    { label: '9:16', value: '9:16', width: 768, height: 1408 },
  ],
  '2K': [
    { label: '16:9', value: '16:9', width: 2816, height: 1536 },
    { label: '3:2', value: '3:2', width: 2432, height: 1664 },
    { label: '4:3', value: '4:3', width: 2304, height: 1792 },
    { label: '1:1', value: '1:1', width: 2048, height: 2048 },
    { label: '3:4', value: '3:4', width: 1792, height: 2304 },
    { label: '2:3', value: '2:3', width: 1664, height: 2432 },
    { label: '9:16', value: '9:16', width: 1536, height: 2816 },
  ],
};

// ---- end of hi-dream-o1-graph.ts copies -------------------------------------

type HiDreamO1ModeExt = FamilyExt & { model?: unknown };

const variantOf = (ext: HiDreamO1ModeExt): HiDreamO1Variant => {
  const id = modelIdOf(ext.model);
  return (id != null ? versionIdToVariant.get(id) : undefined) ?? 'dev';
};

const dev = defineGraph<HiDreamO1ModeExt>()
  .field('cfgScale', sliderDef({ min: 1, max: 20, default: 1, step: 0.5 }))
  .field('steps', sliderDef({ min: 1, max: 100, default: 28 }));

const full = defineGraph<HiDreamO1ModeExt>()
  .field('cfgScale', sliderDef({ min: 1, max: 20, default: 4.5, step: 0.5 }))
  .field('steps', sliderDef({ min: 1, max: 100, default: 50 }));

/** Tagged: v1's `hiDreamO1Variant` computed becomes the branch key. */
const variants = branch('hiDreamO1Variant', variantOf, { dev, full });

/** Aspect-ratio option sets vary per resolution tier; memoize per key. */
const AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options:
      hiDreamO1AspectRatiosByResolution[resolution] ?? hiDreamO1AspectRatiosByResolution['2K']!,
    default: '1:1',
  })
);

export const hiDreamO1 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ min: 1, max: 4 }))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: hiDreamO1VersionOptions },
      defaultModelId: hiDreamO1VersionIds.dev,
    })
  )
  .use(variants)
  .field('resources', familyResources)
  .field('resolution', enumDef({ options: hiDreamO1ResolutionOptions, default: '1K' }))
  .field('aspectRatio', ({ resolution }) => AR(resolution))
  .field('seed', SEED)
  // v1 registers negativePrompt at top level but never mounts snippetsGraph
  .use(makeTextBlock({ snippets: false }));

export { hiDreamO1VersionOptions };
