import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, resourcesDef, type AspectRatioOption } from '../defs';
import { familyScope, modelIdOf, perModelSlider, textBlock, type FamilyExt } from '../shared';

/**
 * Lens (base + turbo), ported from `lens-graph.ts`. Both variants carry LoRAs
 * (raw resourcesNode — no cross-ecosystem filter); resolution is a
 * parent-level node so it survives variant switches, and aspect-ratio dims
 * follow it. Negative prompt supported.
 */

// ---- copied from lens-graph.ts, which dies with the data-graph engine -------

export const lensVersionIds = {
  base: 2982236,
  turbo: 2982241,
} as const;

type LensVariant = 'base' | 'turbo';

const lensVersionOptions = [
  { label: 'Base', value: lensVersionIds.base },
  { label: 'Turbo', value: lensVersionIds.turbo },
];

const versionIdToVariant = new Map<number, LensVariant>([
  [lensVersionIds.base, 'base'],
  [lensVersionIds.turbo, 'turbo'],
]);

const lensResolutionOptions = ['1024', '1440'] as const;

const lensAspectRatiosByResolution: Record<string, AspectRatioOption[]> = {
  '1024': [
    { label: '1:2', value: '1:2', width: 720, height: 1440 },
    { label: '9:16', value: '9:16', width: 768, height: 1376 },
    { label: '2:3', value: '2:3', width: 832, height: 1248 },
    { label: '3:4', value: '3:4', width: 880, height: 1184 },
    { label: '1:1', value: '1:1', width: 1024, height: 1024 },
    { label: '4:3', value: '4:3', width: 1184, height: 880 },
    { label: '3:2', value: '3:2', width: 1248, height: 832 },
    { label: '16:9', value: '16:9', width: 1376, height: 768 },
    { label: '2:1', value: '2:1', width: 1440, height: 720 },
  ],
  '1440': [
    { label: '1:2', value: '1:2', width: 1024, height: 2032 },
    { label: '9:16', value: '9:16', width: 1088, height: 1920 },
    { label: '2:3', value: '2:3', width: 1184, height: 1760 },
    { label: '3:4', value: '3:4', width: 1248, height: 1664 },
    { label: '1:1', value: '1:1', width: 1440, height: 1440 },
    { label: '4:3', value: '4:3', width: 1664, height: 1248 },
    { label: '3:2', value: '3:2', width: 1760, height: 1184 },
    { label: '16:9', value: '16:9', width: 1920, height: 1088 },
    { label: '2:1', value: '2:1', width: 2032, height: 1024 },
  ],
};

const lensPriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// ---- end of lens-graph.ts copies --------------------------------------------

type LensModeExt = FamilyExt & { model?: unknown };

const variantOf = (ext: LensModeExt): LensVariant => {
  const id = modelIdOf(ext.model);
  return (id != null ? versionIdToVariant.get(id) : undefined) ?? 'base';
};

const RESOURCES = ({ _ext }: { _ext: FamilyExt }) =>
  resourcesDef({
    ecosystem: _ext.ecosystem,
    limit: _ext.limits.maxResources,
    filterIncompatible: false,
  });

const base = defineGraph<LensModeExt>()
  .field('resources', RESOURCES)
  .field('cfgScale', perModelSlider({ min: 1, max: 20, default: 5, step: 0.5 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 20 }));

const turbo = defineGraph<LensModeExt>()
  .field('resources', RESOURCES)
  .field('cfgScale', perModelSlider({ min: 1, max: 2, step: 0.1, default: 1 }))
  .field('steps', perModelSlider({ min: 1, max: 12, default: 4 }));

/** Tagged: v1's `lensVariant` computed becomes the branch key. */
const variants = branch('lensVariant', variantOf, { base, turbo });

const RESOLUTION = {
  input: z.enum(lensResolutionOptions).optional(),
  output: z.enum(lensResolutionOptions),
  default: '1024' as (typeof lensResolutionOptions)[number],
  meta: { options: lensResolutionOptions.map((r) => ({ label: r, value: r })) },
};

/** Aspect-ratio option sets vary per resolution; memoize per key. */
const AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options: lensAspectRatiosByResolution[resolution] ?? lensAspectRatiosByResolution['1024']!,
    default: '1:1',
    priorityOptions: lensPriorityRatios,
  })
);

export const lens = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: lensVersionOptions },
      defaultModelId: lensVersionIds.base,
    })
  )
  .use(variants)
  .field('resolution', RESOLUTION)
  .field('aspectRatio', ({ resolution }) => AR(resolution))
  .use(textBlock)
  .field('seed', SEED);

export { lensVersionOptions };
