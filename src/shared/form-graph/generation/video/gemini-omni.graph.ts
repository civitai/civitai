import { defineGraph } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/generation/config/workflows';
import { checkpointDef } from '../checkpoint';
import { aspectRatioDef, enumDef, imagesDef, sliderDef, workflowScoped } from '../defs';
import { familyScope, promptOnlyTextBlock, versionModeOf, type FamilyExt } from '../shared';

/** Keyed by the engine's model value. */
export const geminiOmniVersionIds = {
  '1.1-flash': 3465116,
  '1.2-flash': 3465115,
} as const;

const geminiOmniVersionOptions = [
  { label: '1.2 Flash', value: geminiOmniVersionIds['1.2-flash'] },
  { label: '1.1 Flash', value: geminiOmniVersionIds['1.1-flash'] },
];

export const geminiOmniAspectRatios = [
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

const geminiOmniResolutions = [
  { label: '360p', value: '360p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
  { label: '4K', value: '4k' },
] as const;

const FIRST_LAST_FRAMES = imagesDef({
  slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
  warnOnMissingAiMetadata: true,
});
const ASPECT_RATIO = aspectRatioDef({ options: geminiOmniAspectRatios, default: '16:9' });
const REFERENCES = imagesDef({ min: 3, max: 6, warnOnMissingAiMetadata: true });
const DURATION = sliderDef({ min: 3, max: 15, default: 10 });
// The engine caps first/last-frame generation at 10 seconds.
const FIRST_LAST_DURATION = sliderDef({ min: 3, max: 10, default: 10 });

const isFrameWorkflow = (workflow: string) => isWorkflowOrVariant(workflow, 'img2vid');

export const geminiOmniModelOf = versionModeOf(geminiOmniVersionIds, '1.2-flash');

/** The engine picks its operation from the image count (1 image, 2 first/last, 3+ references), so the per-workflow image limits are what keep a request on the operation the user chose. */
export const geminiOmni = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: geminiOmniVersionOptions },
      defaultModelId: geminiOmniVersionIds['1.2-flash'],
    })
  )
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (_ext.workflow === 'img2vid:ref2vid') return REFERENCES;
      if (isFrameWorkflow(_ext.workflow)) return FIRST_LAST_FRAMES;
      return null;
    })
  )
  .field('resolution', enumDef({ options: geminiOmniResolutions, default: '720p' }))
  // Image to video takes its orientation from the first frame (see the handler).
  .field('aspectRatio', ({ _ext }) => (isFrameWorkflow(_ext.workflow) ? null : ASPECT_RATIO))
  .field('duration', ({ model, images }) => {
    if (geminiOmniModelOf(model) !== '1.2-flash') return null;
    return images?.length === 2 ? FIRST_LAST_DURATION : DURATION;
  })
  .use(promptOnlyTextBlock);
