import { branch, defineGraph } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, boolDef, imagesDef, sliderDef, workflowScoped } from '../defs';
import {
  familyResources,
  familyScope,
  makeTextBlock,
  modelIdOf,
  versionModeOf,
  type FamilyExt,
} from '../shared';

/**
 * MiniMax H3, ported from `minimax-graph.ts`. Two builds behind one version
 * picker: the API build (no extra knobs) and the comfy build (LoRAs, seed, a
 * turbo toggle that reshapes the steps range). Prompt is required even with
 * images (H3 rejects text-less requests). No negative prompt.
 */

// ---- copied from minimax-graph.ts, which dies with the data-graph engine ----

export const minimaxVersionIds = {
  'v1.0': 3183239,
  comfy: 3216500,
} as const;

export type MinimaxVariant = 'api' | 'comfy';

const minimaxAspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const minimaxAspectRatios = getAspectRatioOptions('2K', minimaxAspectRatioList);

const COMFY_DIMENSION_MULTIPLE = 32;
const snapDown = (n: number) =>
  Math.max(
    COMFY_DIMENSION_MULTIPLE,
    Math.floor(n / COMFY_DIMENSION_MULTIPLE) * COMFY_DIMENSION_MULTIPLE
  );

export const minimaxComfyAspectRatios = getAspectRatioOptions('720p', minimaxAspectRatioList).map(
  (option) => ({ ...option, width: snapDown(option.width), height: snapDown(option.height) })
);

export const MINIMAX_DEFAULT_ASPECT_RATIO = '16:9';

const MAX_REFERENCE_IMAGES = 9;

// ---- end of minimax-graph.ts copies -----------------------------------------

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const minimaxVariantOf = versionModeOf(
  { comfy: minimaxVersionIds.comfy } as Record<MinimaxVariant, number>,
  'api'
);

const api = defineGraph<FamilyExt>();

const comfy = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('seed', SEED)
  .field('turbo', boolDef(false))
  .field('steps', ({ turbo }) =>
    turbo === true
      ? sliderDef({ min: 1, max: 20, default: 8 })
      : sliderDef({ min: 10, max: 60, default: 30 })
  );

type MinimaxExt = FamilyExt & { model?: unknown };

/** Tagged: v1's `minimaxVariant` computed becomes the branch key. */
const variants = branch('minimaxVariant', (ext: MinimaxExt) => minimaxVariantOf(ext.model), {
  api,
  comfy,
});

export const minimax = defineGraph<FamilyExt>({ scope: familyScope })
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      // isWorkflowOrVariant matches by the config's variantOf, so ref2vid is
      // NOT an img2vid variant here — it takes plain references, not slots
      if (isWorkflowOrVariant(_ext.workflow, 'img2vid')) {
        return imagesDef({
          slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
          warnOnMissingAiMetadata: true,
        });
      }
      if (_ext.workflow === 'img2vid:ref2vid') {
        return imagesDef({ max: MAX_REFERENCE_IMAGES, warnOnMissingAiMetadata: true });
      }
      return null;
    })
  )
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: {
        options: [
          { label: 'H3 (Comfy)', value: minimaxVersionIds.comfy },
          { label: 'H3 (API)', value: minimaxVersionIds['v1.0'] },
        ],
      },
      defaultModelId: minimaxVersionIds.comfy,
    })
  )
  // frame workflows derive the ratio from the source image (H3's 'adaptive',
  // or the comfy build taking its dimensions from the frame)
  .field('aspectRatio', ({ model, _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? aspectRatioDef({
          options:
            modelIdOf(model) === minimaxVersionIds.comfy
              ? minimaxComfyAspectRatios
              : minimaxAspectRatios,
          default: MINIMAX_DEFAULT_ASPECT_RATIO,
        })
      : null
  )
  .field('duration', sliderDef({ min: 4, max: 15, default: 6 }))
  .use(variants)
  .use(makeTextBlock({ negativePrompt: false, promptAlwaysRequired: true }));

export { minimaxAspectRatios };
