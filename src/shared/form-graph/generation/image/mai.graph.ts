import { defFamily, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, enumDef, imagesDef, workflowScoped } from '../defs';
import { familyScope, modelIdOf, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * MAI Image 2.5 / 2.7 / 2.7 Flash. No LoRAs, sampler, cfg, steps, or CLIP skip.
 * 2.7 edit sends no width or height, only the resolution; the provider picks the output size.
 */

export const maiVersionIds = {
  '2.5': 3002140,
  '2.7': 3478899,
  '2.7-flash': 3478900,
} as const;

const maiVersionOptions = [
  { label: '2.5', value: maiVersionIds['2.5'] },
  { label: '2.7', value: maiVersionIds['2.7'], newUntil: new Date('2026-12-18') },
  { label: '2.7 Flash', value: maiVersionIds['2.7-flash'], newUntil: new Date('2026-12-18') },
];

export function isMai27(modelId: number | undefined) {
  return modelId === maiVersionIds['2.7'] || modelId === maiVersionIds['2.7-flash'];
}

/** Matches MaiImageCreateFalImageGenInput.aspectRatio. */
const mai25AspectRatios = [
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

/**
 * The ratios of 2.7's size presets, sent as explicit width/height. Per fal's MAI Image 2.7 API
 * docs, each side is at least 768 and rounded down to a multiple of 16, with at most 2048² pixels;
 * 2K doubles each 1K side.
 */
const mai27AspectRatios1K = [
  { label: '16:9', value: '16:9', width: 1360, height: 768 },
  { label: '3:2', value: '3:2', width: 1248, height: 832 },
  { label: '4:3', value: '4:3', width: 1152, height: 864 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:4', value: '3:4', width: 864, height: 1152 },
  { label: '2:3', value: '2:3', width: 832, height: 1248 },
  { label: '9:16', value: '9:16', width: 768, height: 1360 },
];

const mai27Resolutions = [
  { label: '1K', value: '1K' },
  { label: '2K', value: '2K' },
] as const;

const maiPriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

/** 2.5 edit uploads must crop to a supported output ratio. */
export const maiCropAspectRatios = mai25AspectRatios.map((r) => r.value as `${number}:${number}`);

const MAI25_AR = aspectRatioDef({
  options: mai25AspectRatios,
  default: '1:1',
  priorityOptions: maiPriorityRatios,
});

const MAI27_AR = defFamily((resolution: string) => {
  const scale = resolution === '2K' ? 2 : 1;
  return aspectRatioDef({
    options: mai27AspectRatios1K.map((r) => ({
      ...r,
      width: r.width * scale,
      height: r.height * scale,
    })),
    default: '1:1',
    priorityOptions: maiPriorityRatios,
  });
});

const MAI27_RESOLUTION = enumDef({ options: mai27Resolutions, default: '1K' });

const MAI27_IMAGES = imagesDef({ max: 5 });

const MAI25_IMAGES = imagesDef({ max: 1, aspectRatios: maiCropAspectRatios });

export const mai = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: maiVersionOptions },
      defaultModelId: maiVersionIds['2.7'],
    })
  )
  .use(promptOnlyTextBlock)
  .field('resolution', ({ model }) => (isMai27(modelIdOf(model)) ? MAI27_RESOLUTION : null))
  .field('aspectRatio', ({ model, resolution, _ext }) => {
    if (!_ext.workflow.startsWith('txt')) return null;
    return isMai27(modelIdOf(model)) ? MAI27_AR(resolution ?? '1K') : MAI25_AR;
  })
  .field(
    'images',
    workflowScoped(({ model, _ext }) => {
      if (_ext.workflow.startsWith('txt')) return null;
      return isMai27(modelIdOf(model)) ? MAI27_IMAGES : MAI25_IMAGES;
    })
  )
  .field('seed', SEED);
