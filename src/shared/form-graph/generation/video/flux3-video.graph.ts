import { defFamily, defineGraph } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/generation/config/workflows';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { flux3VideoVersionIds } from '~/shared/generation/version-ids';
import { checkpointDef } from '../checkpoint';
import { aspectRatioDef, boolDef, enumDef, imagesDef, sliderDef, workflowScoped } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Flux 3 Video. Single version;
 * first/last-frame slots on img2vid; the aspect-ratio control only on txt2vid (image-driven ops send `auto`).
 * Resolution is emitted even in draft mode. The gate it would ride on
 * (`draft !== true`) is a FORWARD dep that never fires, since draft is declared
 * after it — so the field is left unconditional rather than falsely gated.
 */

export { flux3VideoVersionIds };

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

const AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options: getAspectRatioOptions(resolution as '720p' | '1080p', flux3VideoAspectRatioList),
    default: '16:9',
  })
);

export const flux3Video = defineGraph<FamilyExt>({ scope: familyScope })
  .field(
    'images',
    workflowScoped(({ _ext }) =>
      isWorkflowOrVariant(_ext.workflow, 'img2vid')
        ? imagesDef({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
            warnOnMissingAiMetadata: true,
          })
        : null
    )
  )
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: [{ label: 'v3.0', value: flux3VideoVersionIds['v3.0'] }] },
      defaultModelId: flux3VideoVersionIds['v3.0'],
    })
  )
  .field('draft', boolDef(false))
  .field('resolution', enumDef({ options: flux3VideoResolutions, default: '720p' }))
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' ? AR(resolution ?? '720p') : null
  )
  .field('duration', sliderDef({ min: 4, max: 20, default: 5 }))
  .field('generateAudio', boolDef(false))
  .use(promptOnlyTextBlock);

export { flux3VideoAspectRatioList, flux3VideoResolutions };
