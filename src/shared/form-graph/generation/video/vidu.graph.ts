import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import { viduVersionIds } from '~/shared/data-graph/generation/version-ids';
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
 * Vidu (Q1 + Q3), ported from `vidu-graph.ts`. Q1 exposes style, movement
 * amplitude and the prompt enhancer; Q3 swaps those for resolution-scaled
 * ratios, duration, draft and audio toggles. Image-driven workflows emit NO
 * aspect ratio (v1 hides the node; the handler derives it from the source).
 * Q3 on ref2vid rewrites the workflow to img2vid — that rule lives in
 * `../reconcile.ts`.
 */

export { viduVersionIds };

// ---- copied from vidu-graph.ts, which dies with the data-graph engine -------

const viduVersionOptions = [
  { label: 'Q1', value: viduVersionIds.q1 },
  { label: 'Q3', value: viduVersionIds.q3 },
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

const resolutionPixels: Record<string, number> = {
  '360p': 360,
  '540p': 540,
  '720p': 720,
  '1080p': 1080,
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

// ---- end of vidu-graph.ts copies --------------------------------------------

const isQ3 = (model: unknown) => modelIdOf(model) === viduVersionIds.q3;

export const vidu = defineGraph<FamilyExt>({ scope: familyScope })
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (isWorkflowOrVariant(_ext.workflow, 'img2vid'))
        return imagesDef({
          slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
          warnOnMissingAiMetadata: true,
        });
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: 7, warnOnMissingAiMetadata: true });
      return null;
    })
  )
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: viduVersionOptions },
      defaultModelId: viduVersionIds.q1,
    })
  )
  .field('seed', SEED)
  .field('enablePromptEnhancer', ({ model }) =>
    !isQ3(model) ? { input: z.boolean().optional(), output: z.boolean(), default: true } : null
  )
  .field('style', ({ model, _ext }) =>
    !isQ3(model) && _ext.workflow === 'txt2vid'
      ? enumDef({ options: viduStyles, default: 'general' })
      : null
  )
  .field('resolution', ({ model }) =>
    isQ3(model) ? enumDef({ options: viduQ3Resolutions, default: '720p' }) : null
  )
  // image-driven workflows emit NO ratio: v1 hides the node and the handler
  // derives it from the source image
  .field('aspectRatio', ({ model, resolution, _ext }) => {
    const img2vid = isWorkflowOrVariant(_ext.workflow, 'img2vid');
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
    !isQ3(model) ? enumDef({ options: viduMovementAmplitudes, default: 'auto' }) : null
  )
  .field('duration', ({ model }) =>
    isQ3(model) ? sliderDef({ min: 1, max: 16, default: 5 }) : null
  )
  .field('draft', ({ model }) => (isQ3(model) ? boolDef(false) : null))
  .field('enableAudio', ({ model }) => (isQ3(model) ? boolDef(false) : null))
  .use(promptOnlyTextBlock);

export {
  viduVersionOptions,
  viduAspectRatios,
  viduStyles,
  viduMovementAmplitudes,
  viduQ3Resolutions,
  getViduQ3AspectRatios,
};
