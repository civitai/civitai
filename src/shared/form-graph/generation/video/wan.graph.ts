import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { getAspectRatioOptions } from '~/shared/constants/generation.constants';
import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import type { FieldDef } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import type { AspectRatioOption, NumberMeta } from '../defs';
import {
  SEED,
  VIDEO,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  resourcesDef,
  sliderDef,
  type ImageEntry,
} from '../defs';
import { makeTextBlock, type FamilyExt } from '../shared';

/**
 * Wan (2.1 / 2.2 / 2.2-5b / 2.5 / 2.7 / 3.0), ported from `wan-graph.ts`.
 *
 * `.computed('wanVersion') + .discriminator('wanVersion', …)` becomes a TAGGED
 * branch, so the picked version is stamped into state under `wanVersion` and
 * the state union discriminates exactly as before. The parent's
 * workflow→ecosystem sync effect becomes a rule on the hub; v2.1's
 * resolution→ecosystem effect is a rule on v2.1 itself, auto-scoped by the tag.
 */

// ---- copied from wan-graph.ts, which dies with the data-graph engine --------

/** Wan version definitions - single source of truth for versions, ecosystems, and models */
const wanVersionDefs = [
  {
    version: 'v2.1',
    label: '2.1',
    ecosystems: {
      t2v: 'WanVideo14B_T2V',
      i2v: 'WanVideo14B_I2V_720p',
      // v2.1 has resolution-dependent I2V variants
      i2v_480p: 'WanVideo14B_I2V_480p',
    },
    // Extra ecosystem keys that also map to this version (root WanVideo)
    extraEcosystems: ['WanVideo'] as string[],
  },
  {
    version: 'v2.2',
    label: '2.2',
    ecosystems: { t2v: 'WanVideo-22-T2V-A14B', i2v: 'WanVideo-22-I2V-A14B' },
  },
  {
    version: 'v2.2-5b',
    label: '2.2 5B',
    ecosystems: { t2v: 'WanVideo-22-TI2V-5B', i2v: 'WanVideo-22-TI2V-5B' },
  },
  {
    version: 'v2.5',
    label: '2.5',
    ecosystems: { t2v: 'WanVideo-25-T2V', i2v: 'WanVideo-25-I2V' },
  },
  { version: 'v2.7', label: '2.7', ecosystems: { t2v: 'WanVideo27', i2v: 'WanVideo27' } },
  { version: 'v3.0', label: '3.0', ecosystems: { t2v: 'WanVideo30', i2v: 'WanVideo30' } },
] as const;

/** Reverse lookup: ecosystem key → Wan version def */
export const ecosystemToVersionDef = new Map(
  wanVersionDefs.flatMap((def) => {
    const entries: [string, typeof def][] = Object.values(def.ecosystems).map((eco) => [eco, def]);
    if ('extraEcosystems' in def) {
      for (const eco of def.extraEcosystems) entries.push([eco, def]);
    }
    return entries;
  })
);

/** Wan aspect ratio options (basic 3 — used by v2.2-5b; 1024×1024 1:1 diverges from table) */
const wanAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

const wan21AspectRatioList: GenerationAspectRatio[] = ['16:9', '3:2', '1:1', '2:3', '9:16'];
const wan25AspectRatioList: GenerationAspectRatio[] = ['16:9', '1:1', '9:16'];

const wan21AspectRatiosByResolution: Record<string, typeof wanAspectRatios> = {
  '480p': getAspectRatioOptions('480p', wan21AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan21AspectRatioList),
};
const wan25AspectRatiosByResolution: Record<string, typeof wanAspectRatios> = {
  '480p': getAspectRatioOptions('480p', wan25AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan25AspectRatioList),
  '1080p': getAspectRatioOptions('1080p', wan25AspectRatioList),
};

const wan21Resolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
];
const wan22Resolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
];
const wan225bResolutions = [
  { label: '580p', value: '580p' },
  { label: '720p', value: '720p' },
];
const wan25Resolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

const wanDurations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
];
const wan25Durations = [
  { label: '5 seconds', value: 5 },
  { label: '10 seconds', value: 10 },
];

/** Wan interpolator models (v2.2 and v2.2-5b) */
const wanInterpolatorModels = [
  { label: 'None', value: 'none' },
  { label: 'FILM', value: 'film' },
  { label: 'RIFE', value: 'rife' },
];

// ---- end of wan-graph.ts copies ---------------------------------------------

const versionOf = (ecosystem: string) => ecosystemToVersionDef.get(ecosystem)?.version ?? 'v2.1';

/** Whether an ecosystem key belongs to the Wan family (any version, any variant). */
export const isWanEcosystem = (ecosystem: string) => ecosystemToVersionDef.has(ecosystem);

/**
 * The backend ecosystem for a Wan generation, DERIVED from what the user
 * actually chose. v1 stored this derived value in the same `ecosystem` key as
 * the user's selection and kept the conflation consistent with an iterating
 * effect; here it is a pure function used where its inputs exist — the model
 * definition (declared after `resolution`) and the submission boundary.
 * Non-wan selections pass through unchanged.
 */
function deriveWanBackendEcosystem(
  selection: string,
  workflow: string,
  resolution?: string
): string {
  const def = ecosystemToVersionDef.get(selection);
  if (!def) return selection;
  const isImg2vid = workflow === 'img2vid';
  if (def.version === 'v2.1') {
    if (!isImg2vid) return def.ecosystems.t2v;
    return resolution === '720p'
      ? def.ecosystems.i2v
      : (def.ecosystems as { i2v_480p: string }).i2v_480p;
  }
  return isImg2vid ? def.ecosystems.i2v : def.ecosystems.t2v;
}

// Lists that wan-graph.ts keeps module-local; the option tables they build are
// re-derived here from the same shared helper, and pinned by the differential.
const wan22AspectRatioList: GenerationAspectRatio[] = [
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '5:4',
  '4:5',
];
const wan27AspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];
const wan30AspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const arByResolution = (
  table: Record<string, AspectRatioOption[]>,
  fallback: string,
  dflt: string
) =>
  defFamily((resolution: string) =>
    aspectRatioDef({ options: table[resolution] ?? table[fallback]!, default: dflt })
  );

const wan22MultiStepAspectRatiosByResolution = {
  '480p': getAspectRatioOptions('480p', wan22AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan22AspectRatioList),
};
const wan27AspectRatiosByResolution = {
  '720p': getAspectRatioOptions('720p', wan27AspectRatioList),
  '1080p': getAspectRatioOptions('1080p', wan27AspectRatioList),
};
const wan30AspectRatiosByResolution = {
  '480p': getAspectRatioOptions('480p', wan30AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan30AspectRatioList),
  '1080p': getAspectRatioOptions('1080p', wan30AspectRatioList),
};

const AR_21 = arByResolution(wan21AspectRatiosByResolution, '480p', '1:1');
const AR_22_MULTISTEP = arByResolution(wan22MultiStepAspectRatiosByResolution, '480p', '1:1');
const AR_25 = arByResolution(wan25AspectRatiosByResolution, '480p', '1:1');
const AR_27 = arByResolution(wan27AspectRatiosByResolution, '720p', '16:9');
const AR_30 = arByResolution(wan30AspectRatiosByResolution, '720p', '16:9');
const AR_5B = aspectRatioDef({ options: wanAspectRatios, default: '1:1' });

const RES_21 = enumDef({ options: wan21Resolutions, default: '480p' });
// (RES_* stay individually named so RESOLUTION_BY_VERSION reads as the table it is)
const RES_22 = enumDef({ options: wan22Resolutions, default: '480p' });
const RES_5B = enumDef({ options: wan225bResolutions, default: '580p' });
const RES_25 = enumDef({ options: wan25Resolutions, default: '480p' });
const RES_27 = enumDef({
  options: [
    { label: '720p', value: '720p' },
    { label: '1080p', value: '1080p' },
  ],
  default: '720p',
});
const RES_30 = enumDef({
  options: [
    { label: '480p', value: '480p' },
    { label: '720p', value: '720p' },
    { label: '1080p', value: '1080p' },
  ],
  default: '720p',
});

const DURATION_WAN = enumDef({ options: wanDurations, default: 5 });
const DURATION_25 = enumDef({ options: wan25Durations, default: 5 });
const DURATION_30 = sliderDef({ min: 2, max: 30, step: 1, default: 5 });
// hand-written in wan-graph.ts: out-of-range REFUSES (falls to default), no snap
const SHIFT: FieldDef<number, NumberMeta> = {
  input: z.coerce.number().min(1).max(20).optional(),
  output: z.number().min(1).max(20),
  default: 8,
  meta: { min: 1, max: 20, step: 1 },
};
const STEPS_5B = sliderDef({ min: 20, max: 60, default: 40 });
const INTERPOLATOR = {
  input: z.enum(['none', 'film', 'rife']).optional(),
  output: z.enum(['none', 'film', 'rife']),
  default: 'none' as const,
  meta: { options: wanInterpolatorModels },
};
const CFG = sliderDef({
  min: 1,
  max: 10,
  step: 0.5,
  default: 3.5,
  presets: [
    { label: 'Low', value: 2 },
    { label: 'Balanced', value: 3.5 },
    { label: 'High', value: 6 },
  ],
});

const noImages = (images: ImageEntry[] | undefined) =>
  !(Array.isArray(images) && images.length > 0);

const RESOLUTION_BY_VERSION = {
  'v2.1': RES_21,
  'v2.2': RES_22,
  'v2.2-5b': RES_5B,
  'v2.5': RES_25,
  'v2.7': RES_27,
  'v3.0': RES_30,
} as const;

// ---- the parent's shared nodes ---------------------------------------------
const shared = defineGraph<FamilyExt>()
  .field('images', ({ _ext }) => {
    const version = versionOf(_ext.ecosystem);
    const isV27 = version === 'v2.7';
    const isRef2vid = _ext.workflow === 'img2vid:ref2vid';
    const isImg2vid = _ext.workflow === 'img2vid' || _ext.workflow === 'img2vid:first-last';
    const isEditVideo = _ext.workflow.startsWith('vid2vid');

    // v3.0 takes startImage + optional endImage, same slot shape as v2.7.
    if ((isV27 || version === 'v3.0') && isImg2vid) {
      return imagesDef({
        slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
        warnOnMissingAiMetadata: true,
      });
    }
    if (isV27 && isRef2vid) {
      return imagesDef({ warnOnMissingAiMetadata: true, max: 5 });
    }
    return !_ext.workflow.startsWith('txt') && !isEditVideo
      ? imagesDef({ warnOnMissingAiMetadata: true })
      : null;
  })
  .field('seed', SEED)
  // every version has a resolution — only the option set is version-specific
  .field('resolution', ({ _ext }) => RESOLUTION_BY_VERSION[versionOf(_ext.ecosystem)])
  // THE two-facts split: the selection stays in `ecosystem` (hub field,
  // shadowed off the wire by this emit); the backend target is derived where
  // its inputs exist and carries the wire name. Only v2.1 consults resolution.
  .computed(
    'backendEcosystem',
    ({ resolution, _ext }) => deriveWanBackendEcosystem(_ext.ecosystem, _ext.workflow, resolution),
    { emit: 'ecosystem' }
  )
  // checkpointDef's defaults and locked substitution are per BACKEND ecosystem
  // (v2.1's 480p and 720p I2V variants have different default models)
  .field('model', ({ backendEcosystem, _ext }) =>
    checkpointDef({ ecosystem: backendEcosystem, workflow: _ext.workflow, ext: _ext })
  )
  // Alibaba's wan3.0 API documents no cfgScale, so it is hidden there.
  .field('cfgScale', ({ _ext }) => (versionOf(_ext.ecosystem) === 'v3.0' ? null : CFG));

// ---- one graph per Wan version ---------------------------------------------
const v21 = defineGraph<FamilyExt>()
  .use(shared)
  .field('aspectRatio', ({ images, resolution }) => (noImages(images) ? AR_21(resolution) : null))
  .field('duration', DURATION_WAN)
  .field('resources', ({ backendEcosystem, _ext }) =>
    resourcesDef({ ecosystem: backendEcosystem, limit: _ext.limits.maxResources })
  )
  // wan2.1 has no negative prompt
  .use(makeTextBlock({ negativePrompt: false }));

const v22 = defineGraph<FamilyExt>()
  .use(shared)
  .use(makeTextBlock())
  .field('aspectRatio', ({ images, resolution, _ext }) =>
    noImages(images) ? (_ext.flags?.wan22MultiStep ? AR_22_MULTISTEP : AR_25)(resolution) : null
  )
  .field('shift', SHIFT)
  .field('duration', ({ _ext }) => (_ext.flags?.wan22MultiStep === true ? DURATION_WAN : null))
  .field('interpolatorModel', ({ _ext }) =>
    _ext.flags?.wan22MultiStep !== true ? INTERPOLATOR : null
  )
  .field('draft', ({ _ext }) => (_ext.flags?.wan22MultiStep !== true ? boolDef(false) : null))
  .field('resources', ({ backendEcosystem }) =>
    resourcesDef({ ecosystem: backendEcosystem, limit: 2 })
  );

const v5b = defineGraph<FamilyExt>()
  .use(shared)
  .field('aspectRatio', ({ images }) => (noImages(images) ? AR_5B : null))
  .use(makeTextBlock())
  .field('steps', STEPS_5B)
  .field('shift', SHIFT)
  .field('interpolatorModel', INTERPOLATOR)
  .field('resources', ({ backendEcosystem }) =>
    resourcesDef({ ecosystem: backendEcosystem, limit: 2 })
  );

const v25 = defineGraph<FamilyExt>()
  .use(shared)
  .use(makeTextBlock())
  .field('aspectRatio', ({ images, resolution }) => (noImages(images) ? AR_25(resolution) : null))
  .field('duration', DURATION_25);

const v27 = defineGraph<FamilyExt>()
  .use(shared)
  .field('video', ({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? VIDEO : null))
  // negativePrompt is unsupported on edit-video
  .use(
    makeTextBlock({
      negativePrompt: (ext) => ext.workflow !== 'vid2vid:edit',
      negativePromptIsEditor: false,
    })
  )
  .field('aspectRatio', ({ images, video, resolution }) =>
    noImages(images) && !video?.url ? AR_27(resolution) : null
  )
  .field('duration', ({ _ext }) => {
    const max = _ext.workflow === 'img2vid:ref2vid' || _ext.workflow === 'vid2vid:edit' ? 10 : 15;
    return {
      ...sliderDef({ min: 2, max, step: 1, default: 5 }),
      correct: (value: number) => {
        const clamped = Math.min(Math.max(value, 2), max);
        return clamped === value
          ? undefined
          : { value: clamped, reason: 'duration_range', detail: { max } };
      },
    };
  })
  .field('enablePromptEnhancer', ({ _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid' ? boolDef(false) : null
  );

const v30 = defineGraph<FamilyExt>()
  .use(shared)
  .use(makeTextBlock())
  .field('aspectRatio', ({ images, resolution }) => (noImages(images) ? AR_30(resolution) : null))
  .field('duration', DURATION_30)
  .field('enablePromptEnhancer', boolDef(false))
  .field('usePrime', boolDef(false));

export const wan = branch('wanVersion', (ext: FamilyExt) => versionOf(ext.ecosystem), {
  'v2.1': v21,
  'v2.2': v22,
  'v2.2-5b': v5b,
  'v2.5': v25,
  'v2.7': v27,
  'v3.0': v30,
});
