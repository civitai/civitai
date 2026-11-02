import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { klingVersionIds } from '~/shared/generation/version-ids';
import { checkpointDef } from '../checkpoint';
import { getAspectRatioOptions } from '~/shared/constants/generation.constants';
import {
  optionFallback,
  SEED,
  VIDEO,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  sliderDef,
  workflowScoped,
  refusingRangeDef,
  type ResourceData,
} from '../defs';
import { familyScope, makeTextBlock, modelIdOf, textBlock, type FamilyExt } from '../shared';

/**
 * Kling (V1.6 / V2 / V2.5 Turbo on the legacy engine, V3 on kling-v3, V4 on
 * kling-v4). ref2vid exists only on V3 and V4, so that workflow forces any
 * other model to V3 — the workflow wins over the model-driven fallback.
 * vid2vid:edit is V4-only. Multi-shot prompts, elements and voices are not
 * built for V3 or V4. Legacy carries the negative prompt; V3 and V4 do not.
 * V4 always generates audio, so it has no audio toggle.
 */

const klingVersionOptions = [
  { label: 'V1.6', value: klingVersionIds.v1_6 },
  { label: 'V2', value: klingVersionIds.v2 },
  { label: 'V2.5 Turbo', value: klingVersionIds.v2_5_turbo },
  { label: 'V3', value: klingVersionIds.v3 },
  { label: 'V4', value: klingVersionIds.v4 },
];

const klingAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

const klingModes = [
  { label: 'Standard', value: 'standard' },
  { label: 'Professional', value: 'professional' },
] as const;

const klingDurations = [
  { label: '5 seconds', value: '5' },
  { label: '10 seconds', value: '10' },
] as const;

const KLING_MODE_INFO =
  'Standard mode is faster to generate and more cost-effective. Professional takes longer to generate and has higher quality output.';

export type KlingVersion = 'legacy' | 'v3' | 'v4';

export type KlingV3Operation = 'text-to-video' | 'image-to-video' | 'reference-to-video';

function getV3Operation(workflow: string): KlingV3Operation {
  if (workflow === 'img2vid:ref2vid') return 'reference-to-video';
  if (workflow.startsWith('img2vid')) return 'image-to-video';
  return 'text-to-video';
}

export { klingVersionIds };

type KlingExt = FamilyExt & { model?: ResourceData };

const legacy = defineGraph<KlingExt>()
  .field(
    'images',
    workflowScoped(({ _ext }) =>
      !_ext.workflow.startsWith('txt') ? imagesDef({ warnOnMissingAiMetadata: true }) : null
    )
  )
  .field('seed', SEED)
  .field('enablePromptEnhancer', boolDef(true))
  .use(textBlock)
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow !== 'img2vid'
      ? aspectRatioDef({ options: klingAspectRatios, default: '1:1' })
      : null
  )
  .field('mode', ({ _ext }) =>
    modelIdOf(_ext.model) === klingVersionIds.v1_6
      ? {
          input: z.enum(['standard', 'professional']).optional(),
          output: z.enum(['standard', 'professional']),
          default: 'standard' as const,
          correct: optionFallback(['standard', 'professional'] as const, 'standard'),
          meta: { options: klingModes, info: KLING_MODE_INFO },
        }
      : null
  )
  // scoped per version arm: legacy's STRING enum and v3's number range share
  // this address in one family bucket — either value fails the other's schema
  .field('duration', { ...enumDef({ options: klingDurations, default: '5' }), scope: 'legacy' })
  .field(
    'cfgScale',
    sliderDef({
      min: 0.1,
      max: 1,
      step: 0.1,
      default: 0.5,
      presets: [
        { label: 'Low', value: 0.3 },
        { label: 'Medium', value: 0.5 },
        { label: 'High', value: 0.7 },
      ],
    })
  );

const V3_DURATION = refusingRangeDef({ min: 5, max: 15, default: 5 });

const v3 = defineGraph<KlingExt>()
  .computed('operation', ({ _ext }) => getV3Operation(_ext.workflow))
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (_ext.workflow.startsWith('img2vid') && _ext.workflow !== 'img2vid:ref2vid') {
        return imagesDef({
          slots: [{ label: 'Start Image', required: true }, { label: 'End Image' }],
          warnOnMissingAiMetadata: true,
        });
      }
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: 7, warnOnMissingAiMetadata: true });
      return null;
    })
  )
  .field('seed', SEED)
  .field('mode', {
    ...enumDef({ options: klingModes, default: 'standard' }),
    meta: { options: klingModes, info: KLING_MODE_INFO },
  })
  .field('duration', { ...V3_DURATION, scope: 'v3' })
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? aspectRatioDef({ options: klingAspectRatios, default: '1:1' })
      : null
  )
  .field('generateAudio', boolDef(false))
  .use(makeTextBlock({ negativePrompt: false, promptAlwaysRequired: true }));

const klingV4Resolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

const klingV4AspectRatios = getAspectRatioOptions('720p', ['16:9', '9:16', '1:1', '21:9']);

const V4_DURATION = refusingRangeDef({ min: 3, max: 30, default: 5 });

const V4_MAX_REFERENCE_IMAGES = 10;

export type KlingV4Operation =
  | 'textToVideo'
  | 'imageToVideo'
  | 'referenceToVideo'
  | 'videoToVideoEdit';

function getV4Operation(workflow: string): KlingV4Operation {
  if (workflow === 'vid2vid:edit') return 'videoToVideoEdit';
  if (workflow === 'img2vid:ref2vid') return 'referenceToVideo';
  if (workflow.startsWith('img2vid')) return 'imageToVideo';
  return 'textToVideo';
}

const v4 = defineGraph<KlingExt>()
  .computed('operation', ({ _ext }) => getV4Operation(_ext.workflow))
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: V4_MAX_REFERENCE_IMAGES, warnOnMissingAiMetadata: true });
      if (_ext.workflow === 'vid2vid:edit') return imagesDef({ max: V4_MAX_REFERENCE_IMAGES });
      if (_ext.workflow.startsWith('img2vid')) {
        return imagesDef({
          slots: [{ label: 'Start Image', required: true }, { label: 'End Image' }],
          warnOnMissingAiMetadata: true,
        });
      }
      return null;
    })
  )
  .field(
    'video',
    workflowScoped(({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? VIDEO : null))
  )
  .field('resolution', enumDef({ options: klingV4Resolutions, default: '720p' }))
  .field('duration', ({ _ext }) =>
    _ext.workflow === 'vid2vid:edit' ? null : { ...V4_DURATION, scope: 'v4' }
  )
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? aspectRatioDef({ options: klingV4AspectRatios, default: '16:9' })
      : null
  )
  .use(makeTextBlock({ negativePrompt: false, promptAlwaysRequired: true }));

const versionOf = (ext: KlingExt): KlingVersion => {
  const id = modelIdOf(ext.model);
  if (id === klingVersionIds.v4) return 'v4';
  if (id === klingVersionIds.v3) return 'v3';
  return 'legacy';
};

/** Tagged: the picked key is stamped into state as `klingVersion`. */
const versions = branch('klingVersion', versionOf, { legacy, v3, v4 });

export const kling = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) => {
    const base = checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: klingVersionOptions },
      defaultModelId: klingVersionIds.v2_5_turbo,
    });
    return {
      ...base,
      correct: (value: ResourceData | undefined) => {
        // ref2vid exists only on V3 and V4 — the workflow wins
        if (
          _ext.workflow === 'img2vid:ref2vid' &&
          value?.id !== klingVersionIds.v3 &&
          value?.id !== klingVersionIds.v4
        ) {
          return {
            value: { id: klingVersionIds.v3, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'ref2vid_requires_v3',
          };
        }
        // video edit exists only on V4; `excludeModelVersionIds` filters nothing at runtime
        if (_ext.workflow === 'vid2vid:edit' && value?.id !== klingVersionIds.v4) {
          return {
            value: { id: klingVersionIds.v4, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'edit_requires_v4',
          };
        }
        return base.correct?.(value);
      },
    };
  })
  .use(versions);

export { klingVersionOptions, klingAspectRatios, klingModes, klingDurations };
