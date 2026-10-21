import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/generation/config/workflows';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { flux3VideoVersionIds } from '~/shared/generation/version-ids';
import { checkpointDef } from '../checkpoint';
import {
  aspectRatioDef,
  boolDef,
  enumDef,
  imageEntryListDef,
  imagesDef,
  SEED,
  sliderDef,
  workflowScoped,
  type ImageEntryValue,
  type ResourceData,
} from '../defs';
import { familyScope, promptOnlyTextBlock, versionModeOf, type FamilyExt } from '../shared';

export { flux3VideoVersionIds };

export const FLUX3_KEYFRAMES_WORKFLOW = 'img2vid:keyframes';
export const FLUX3_KEYFRAMES_LIMIT = 10;
export const FLUX3_VIDEO_FPS = 24;

export type Flux3VideoVersion = 'v3' | 'max';

export const flux3VideoVersionOf = versionModeOf<Flux3VideoVersion>(
  { v3: flux3VideoVersionIds['v3.0'], max: flux3VideoVersionIds['v3.0-max'] },
  'v3'
);

const flux3VideoVersionOptions = [
  { label: 'v3.0', value: flux3VideoVersionIds['v3.0'] },
  { label: 'v3.0 Max', value: flux3VideoVersionIds['v3.0-max'] },
];

const flux3VideoAspectRatioList: GenerationAspectRatio[] = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
];

const flux3VideoResolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

const flux3MaxReasoningLevels = [
  { label: 'Low', value: 'low' },
  { label: 'High', value: 'high' },
] as const;

const AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options: getAspectRatioOptions(resolution as '720p' | '1080p', flux3VideoAspectRatioList),
    default: '16:9',
  })
);

const firstLastFrames = () =>
  imagesDef({
    slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
    warnOnMissingAiMetadata: true,
  });

export type Flux3KeyframeEntry = ImageEntryValue<{ frameIndex: z.ZodNumber }>;

const keyframesBase = imageEntryListDef({
  fields: { frameIndex: z.number().int().min(0) },
  defaults: { frameIndex: 0 },
  limit: FLUX3_KEYFRAMES_LIMIT,
  min: 1,
  noun: { one: 'keyframe', many: 'keyframes' },
  refinements: [
    [
      (entries) => new Set(entries.map((e) => e.frameIndex)).size === entries.length,
      'Each keyframe needs its own frame',
    ],
  ],
  meta: { fps: FLUX3_VIDEO_FPS },
});

/**
 * Spread from `keyframesBase` so the schemas keep one identity across passes (the store reports a
 * field that mints new ones). A clamp that lands on a taken frame is left to the uniqueness check,
 * whose error the input renders.
 */
const keyframesDef = (maxFrame: number) => ({
  ...keyframesBase,
  correct: (value: Flux3KeyframeEntry[] | undefined) => {
    const capped = keyframesBase.correct(value);
    const entries = capped?.value ?? value;
    if (!entries) return undefined;
    const clamped = entries.map((e) =>
      e.frameIndex > maxFrame ? { ...e, frameIndex: maxFrame } : e
    );
    if (clamped.some((e, i) => e !== entries[i]))
      return { value: clamped, reason: capped?.reason ?? 'frame_out_of_range' };
    return capped;
  },
  meta: { ...keyframesBase.meta, maxFrame },
});

type Flux3VideoExt = FamilyExt & { model?: ResourceData };

const v3 = defineGraph<Flux3VideoExt>()
  .field(
    'images',
    workflowScoped(({ _ext }) =>
      isWorkflowOrVariant(_ext.workflow, 'img2vid') ? firstLastFrames() : null
    )
  )
  .field('draft', boolDef(false))
  .field('resolution', enumDef({ options: flux3VideoResolutions, default: '720p' }))
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' ? AR(resolution ?? '720p') : null
  )
  .field('duration', sliderDef({ min: 4, max: 20, default: 5 }))
  .field('generateAudio', { ...boolDef(false), scope: 'v3' })
  .use(promptOnlyTextBlock);

const max = defineGraph<Flux3VideoExt>()
  .field(
    'images',
    workflowScoped(({ _ext }) =>
      isWorkflowOrVariant(_ext.workflow, 'img2vid') ? firstLastFrames() : null
    )
  )
  .field('resolution', enumDef({ options: flux3VideoResolutions, default: '720p' }))
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' ? AR(resolution ?? '720p') : null
  )
  .field('duration', sliderDef({ min: 5, max: 20, default: 5 }))
  .field(
    'keyframes',
    workflowScoped(({ duration, _ext }) =>
      _ext.workflow === FLUX3_KEYFRAMES_WORKFLOW
        ? keyframesDef((duration ?? 5) * FLUX3_VIDEO_FPS)
        : null
    )
  )
  .field('generateAudio', { ...boolDef(true), scope: 'max' })
  .field('reasoningLevel', enumDef({ options: flux3MaxReasoningLevels, default: 'high' }))
  .field('seed', SEED)
  .use(promptOnlyTextBlock);

/** Stamps the picked key into state as `flux3VideoVersion` (the handler narrows on it). */
const versions = branch(
  'flux3VideoVersion',
  (ext: Flux3VideoExt): Flux3VideoVersion => flux3VideoVersionOf(ext.model),
  { v3, max }
);

export const flux3Video = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) => {
    const base = checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: flux3VideoVersionOptions },
      defaultModelId: flux3VideoVersionIds['v3.0'],
    });
    return {
      ...base,
      correct: (value: ResourceData | undefined) => {
        // Keyframes exist only on Max, so the workflow wins over the picked version.
        if (
          _ext.workflow === FLUX3_KEYFRAMES_WORKFLOW &&
          value?.id !== flux3VideoVersionIds['v3.0-max']
        ) {
          return {
            value: {
              id: flux3VideoVersionIds['v3.0-max'],
              model: { type: 'Checkpoint' },
            } as ResourceData,
            reason: 'keyframes_require_max',
          };
        }
        return base.correct?.(value);
      },
    };
  })
  .use(versions);

export { flux3VideoAspectRatioList, flux3VideoResolutions };
