import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { getAspectRatioOptions } from '~/shared/constants/generation.constants';
import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import {
  ecosystemToVersionDef,
  wanAspectRatios,
  wan21AspectRatiosByResolution,
  wan21Resolutions,
  wan22Resolutions,
  wan225bResolutions,
  wan25AspectRatiosByResolution,
  wan25Durations,
  wan25Resolutions,
  wanDurations,
  wanInterpolatorModels,
} from '~/shared/data-graph/generation/wan-graph';
import type { AspectRatioOption } from '~/shared/data-graph/generation/common';
import { checkpointDef } from './checkpoint';
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
} from './defs';
import { makeTextBlock, type VideoExt } from './shared';

/**
 * Wan (2.1 / 2.2 / 2.2-5b / 2.5 / 2.7 / 3.0), ported from `wan-graph.ts`.
 *
 * `.computed('wanVersion') + .discriminator('wanVersion', …)` becomes a TAGGED
 * branch, so the picked version is stamped into state under `wanVersion` and
 * the state union discriminates exactly as before. The parent's
 * workflow→ecosystem sync effect becomes a rule on the hub; v2.1's
 * resolution→ecosystem effect is a rule on v2.1 itself, auto-scoped by the tag.
 */

const versionOf = (ecosystem: string) => ecosystemToVersionDef.get(ecosystem)?.version ?? 'v2.1';

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

const RESOURCES = defFamily((limit: number) => resourcesDef(limit));
const RES_21 = enumDef({ options: wan21Resolutions, default: '480p' });
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
const SHIFT = { ...sliderDef({ min: 1, max: 20, step: 1, default: 8 }) };
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

// ---- the parent's shared nodes ---------------------------------------------
const shared = defineGraph<VideoExt>()
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
  // createCheckpointGraph() with no options — everything from ecosystem defaults
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field('seed', SEED)
  // Alibaba's wan3.0 API documents no cfgScale, so it is hidden there.
  .field('cfgScale', ({ _ext }) => (versionOf(_ext.ecosystem) === 'v3.0' ? null : CFG));

// ---- one graph per Wan version ---------------------------------------------
const v21 = defineGraph<VideoExt>()
  .use(shared)
  .field('resolution', RES_21)
  .field('aspectRatio', ({ images, resolution }) =>
    noImages(images as ImageEntry[] | undefined) ? AR_21(resolution) : null
  )
  .field('duration', DURATION_WAN)
  .field('resources', ({ _ext }) => RESOURCES(_ext.limits.maxResources))
  // wan2.1 has no negative prompt
  .use(makeTextBlock({ negativePrompt: false }));

const v22 = defineGraph<VideoExt>()
  .use(shared)
  .use(makeTextBlock())
  .field('resolution', RES_22)
  .field('aspectRatio', ({ images, resolution, _ext }) =>
    noImages(images as ImageEntry[] | undefined)
      ? (_ext.flags?.wan22MultiStep ? AR_22_MULTISTEP : AR_25)(resolution)
      : null
  )
  .field('shift', SHIFT)
  .field('duration', ({ _ext }) => (_ext.flags?.wan22MultiStep === true ? DURATION_WAN : null))
  .field('interpolatorModel', ({ _ext }) =>
    _ext.flags?.wan22MultiStep !== true ? INTERPOLATOR : null
  )
  .field('draft', ({ _ext }) => (_ext.flags?.wan22MultiStep !== true ? boolDef(false) : null))
  .field('resources', () => RESOURCES(2));

const v5b = defineGraph<VideoExt>()
  .use(shared)
  .field('aspectRatio', ({ images }) =>
    noImages(images as ImageEntry[] | undefined) ? AR_5B : null
  )
  .use(makeTextBlock())
  .field('resolution', RES_5B)
  .field('steps', STEPS_5B)
  .field('shift', SHIFT)
  .field('interpolatorModel', INTERPOLATOR)
  .field('resources', () => RESOURCES(2));

const v25 = defineGraph<VideoExt>()
  .use(shared)
  .use(makeTextBlock())
  .field('resolution', RES_25)
  .field('aspectRatio', ({ images, resolution }) =>
    noImages(images as ImageEntry[] | undefined) ? AR_25(resolution) : null
  )
  .field('duration', DURATION_25);

const v27 = defineGraph<VideoExt>()
  .use(shared)
  .field('video', ({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? VIDEO : null))
  // negativePrompt is unsupported on edit-video
  .use(
    makeTextBlock({
      negativePrompt: (ext) => ext.workflow !== 'vid2vid:edit',
      negativePromptIsEditor: false,
    })
  )
  .field('resolution', RES_27)
  .field('aspectRatio', ({ images, video, resolution }) =>
    noImages(images as ImageEntry[] | undefined) && !video?.url ? AR_27(resolution) : null
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

const v30 = defineGraph<VideoExt>()
  .use(shared)
  .use(makeTextBlock())
  .field('resolution', RES_30)
  .field('aspectRatio', ({ images, resolution }) =>
    noImages(images as ImageEntry[] | undefined) ? AR_30(resolution) : null
  )
  .field('duration', DURATION_30)
  .field('enablePromptEnhancer', boolDef(false))
  .field('usePrime', boolDef(false));

export const wan = branch('wanVersion', (ext: VideoExt) => versionOf(ext.ecosystem), {
  'v2.1': v21,
  'v2.2': v22,
  'v2.2-5b': v5b,
  'v2.5': v25,
  'v2.7': v27,
  'v3.0': v30,
});
