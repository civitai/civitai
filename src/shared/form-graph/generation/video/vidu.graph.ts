import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/generation/config/workflows';
import { viduVersionIds } from '~/shared/generation/version-ids';
import { checkpointDef } from '../checkpoint';
import {
  SEED,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  sliderDef,
  workflowScoped,
  type AspectRatioOption,
} from '../defs';
import { familyScope, modelIdOf, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Vidu (Q1 + Q3 + Q4). Q1 exposes style, movement
 * amplitude and the prompt enhancer; Q3 swaps those for resolution-scaled
 * ratios, duration, draft and audio toggles. Q4 is image-driven only: one start
 * frame on img2vid, up to 15 references on ref2vid. Image-driven workflows emit NO
 * aspect ratio — the handler derives it from the source — except Q4 ref2vid.
 * Q3 on ref2vid and Q4 on txt2vid rewrite the workflow — those rules live in
 * `../reconcile.ts`.
 */

export { viduVersionIds };

const viduVersionOptions = [
  { label: 'Q1', value: viduVersionIds.q1 },
  { label: 'Q3', value: viduVersionIds.q3 },
  { label: 'Q4', value: viduVersionIds.q4 },
];

const viduAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

const viduStyles = [
  { label: 'General', value: 'general' },
  { label: 'Anime', value: 'anime' },
] as const;

const viduMovementAmplitudes = [
  { label: 'Auto', value: 'auto' },
  { label: 'Small', value: 'small' },
  { label: 'Medium', value: 'medium' },
  { label: 'Large', value: 'large' },
] as const;

const viduQ3Resolutions = [
  { label: '360p', value: '360p' },
  { label: '540p', value: '540p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

const viduQ4Resolutions = [
  { label: '540p', value: '540p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
  { label: '2K', value: '2K' },
  { label: '4K', value: '4K' },
] as const;

const resolutionPixels: Record<string, number> = {
  '360p': 360,
  '540p': 540,
  '720p': 720,
  '1080p': 1080,
  '2K': 1440,
  '4K': 2160,
};

function getViduQ3AspectRatios(resolution: string): AspectRatioOption[] {
  const res = resolutionPixels[resolution] ?? 720;
  return [
    { label: '16:9', value: '16:9', width: Math.round((res * 16) / 9), height: res },
    { label: '1:1', value: '1:1', width: res, height: res },
    { label: '9:16', value: '9:16', width: res, height: Math.round((res * 16) / 9) },
    { label: '4:3', value: '4:3', width: Math.round((res * 4) / 3), height: res },
    { label: '3:4', value: '3:4', width: res, height: Math.round((res * 4) / 3) },
  ];
}

const isQ3 = (model: unknown) => modelIdOf(model) === viduVersionIds.q3;
const isQ4 = (model: unknown) => modelIdOf(model) === viduVersionIds.q4;
/** Q1 is the only build with style, movement amplitude and the prompt enhancer. */
const isQ1 = (model: unknown) => !isQ3(model) && !isQ4(model);

export const vidu = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: viduVersionOptions },
      defaultModelId: viduVersionIds.q1,
    })
  )
  .field(
    'images',
    workflowScoped(({ model, _ext }) => {
      if (isWorkflowOrVariant(_ext.workflow, 'img2vid'))
        return imagesDef({
          slots: isQ4(model)
            ? [{ label: 'First Frame', required: true }]
            : [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
          warnOnMissingAiMetadata: true,
        });
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: isQ4(model) ? 15 : 7, warnOnMissingAiMetadata: true });
      return null;
    })
  )
  .field('seed', SEED)
  .field('enablePromptEnhancer', ({ model }) =>
    isQ1(model) ? { input: z.boolean().optional(), output: z.boolean(), default: true } : null
  )
  .field('style', ({ model, _ext }) =>
    isQ1(model) && _ext.workflow === 'txt2vid'
      ? enumDef({ options: viduStyles, default: 'general' })
      : null
  )
  .field('resolution', ({ model }) => {
    if (isQ3(model)) return enumDef({ options: viduQ3Resolutions, default: '720p' });
    if (isQ4(model)) return enumDef({ options: viduQ4Resolutions, default: '720p' });
    return null;
  })
  // image-driven workflows emit NO ratio: the handler
  // derives it from the source image
  .field('aspectRatio', ({ model, resolution, _ext }) => {
    const img2vid = isWorkflowOrVariant(_ext.workflow, 'img2vid');
    if (isQ4(model)) {
      return _ext.workflow === 'img2vid:ref2vid'
        ? aspectRatioDef({ options: getViduQ3AspectRatios(resolution ?? '720p'), default: '16:9' })
        : null;
    }
    if (isQ3(model)) {
      return img2vid
        ? null
        : aspectRatioDef({ options: getViduQ3AspectRatios(resolution ?? '720p'), default: '1:1' });
    }
    if (img2vid) return null;
    return _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? aspectRatioDef({ options: viduAspectRatios, default: '1:1' })
      : null;
  })
  .field('movementAmplitude', ({ model }) =>
    isQ1(model) ? enumDef({ options: viduMovementAmplitudes, default: 'auto' }) : null
  )
  .field('duration', ({ model, _ext }) => {
    if (isQ3(model)) return sliderDef({ min: 1, max: 16, default: 5 });
    // Q4 image-to-video starts at 3s, reference-to-video at 1s
    if (isQ4(model))
      return sliderDef({ min: _ext.workflow === 'img2vid:ref2vid' ? 1 : 3, max: 16, default: 5 });
    return null;
  })
  .field('draft', ({ model }) => (isQ3(model) ? boolDef(false) : null))
  // Q4 image-to-video always generates audio; only its ref2vid takes the toggle
  .field('enableAudio', ({ model, _ext }) =>
    isQ3(model) || (isQ4(model) && _ext.workflow === 'img2vid:ref2vid') ? boolDef(false) : null
  )
  .use(promptOnlyTextBlock);

export {
  viduVersionOptions,
  viduAspectRatios,
  viduStyles,
  viduMovementAmplitudes,
  viduQ3Resolutions,
  viduQ4Resolutions,
  getViduQ3AspectRatios,
};
