import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import {
  SDXL_FULL_AR_4MP,
  optionFallback,
  SEED,
  aspectRatioDef,
  boolDef,
  img2imgImages,
  type ResourceData,
} from '../defs';
import {
  familyResources,
  familyScope,
  perModelSlider,
  promptOnlyTextBlock,
  versionModeOf,
  type FamilyExt,
} from '../shared';

/**
 * Ideogram family. 4.0 and 4.5 share one ecosystem;
 * the model version id picks the branch. 4.0 has no negative prompt, sampler or scheduler.
 */

export type IdeogramVersion = 'v4.0' | 'v4.5';

export const ideogramVersionIds = {
  'v4.0': 3246186,
  'v4.5': 3375798,
} as const;

const ideogramTxt2ImgVersionOptions = [
  { label: 'v4.0', value: ideogramVersionIds['v4.0'] },
  { label: 'v4.5', value: ideogramVersionIds['v4.5'] },
];

const ideogramImg2ImgVersionOptions = [{ label: 'v4.5', value: ideogramVersionIds['v4.5'] }];

/** fal accepts only an explicit list of custom sizes; these are its ~4MP entries. */
const ideogram45AspectRatios = [
  { label: '21:9', value: '21:9', width: 3072, height: 1280 },
  { label: '16:9', value: '16:9', width: 2560, height: 1440 },
  { label: '3:2', value: '3:2', width: 2496, height: 1664 },
  { label: '4:3', value: '4:3', width: 2304, height: 1728 },
  { label: '5:4', value: '5:4', width: 2240, height: 1792 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '4:5', value: '4:5', width: 1792, height: 2240 },
  { label: '3:4', value: '3:4', width: 1728, height: 2304 },
  { label: '2:3', value: '2:3', width: 1664, height: 2496 },
  { label: '9:16', value: '9:16', width: 1440, height: 2560 },
  { label: '9:21', value: '9:21', width: 1280, height: 3072 },
];

const ideogram45PriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const ideogram45QualityOptions = ['high', 'medium', 'low'] as const;
type Ideogram45Quality = (typeof ideogram45QualityOptions)[number];

const ideogramVersionOf = versionModeOf<IdeogramVersion>(ideogramVersionIds, 'v4.0');

type IdeogramVersionExt = FamilyExt & { model?: ResourceData | number };

const ideogram4 = defineGraph<IdeogramVersionExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_FULL_AR_4MP)
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 4 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 25 }));

const ideogram45 = defineGraph<IdeogramVersionExt>()
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? aspectRatioDef({
          options: ideogram45AspectRatios,
          default: '1:1',
          priorityOptions: ideogram45PriorityRatios,
        })
      : null
  )
  .field('images', img2imgImages({ min: 1, max: 4 }))
  .field('quality', {
    input: z.enum(ideogram45QualityOptions).optional(),
    output: z.enum(ideogram45QualityOptions),
    default: 'medium' as Ideogram45Quality,
    correct: optionFallback(ideogram45QualityOptions, 'medium' as Ideogram45Quality),
    meta: {
      options: ideogram45QualityOptions.map((q) => ({
        label: q.charAt(0).toUpperCase() + q.slice(1),
        value: q,
      })),
    },
  })
  // fal defaults expansion ON; off so the prompt is sent as written.
  .field('enablePromptExpansion', ({ _ext }) =>
    _ext.workflow.startsWith('txt') ? boolDef(false) : null
  );

/** Tagged: the picked key is stamped into state as `ideogramVersion`. */
const versions = branch(
  'ideogramVersion',
  (ext: IdeogramVersionExt) => ideogramVersionOf(ext.model),
  { 'v4.0': ideogram4, 'v4.5': ideogram45 }
);

export const ideogram = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) => {
    const isEdit = _ext.workflow.startsWith('img2img:edit');
    return checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: isEdit ? ideogramImg2ImgVersionOptions : ideogramTxt2ImgVersionOptions },
      defaultModelId: isEdit ? ideogramVersionIds['v4.5'] : ideogramVersionIds['v4.0'],
    });
  })
  .use(versions)
  .use(promptOnlyTextBlock)
  .field('seed', SEED);
