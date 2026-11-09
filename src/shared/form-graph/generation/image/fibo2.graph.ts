import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SDXL_FULL_AR, SEED, sliderDef } from '../defs';
import { familyResources, familyScope, makeTextBlock, type FamilyExt } from '../shared';

/**
 * Fibo 2.0. One base model, but the orchestrator runs create and edit on different weights:
 * `dev` (a CFG model) for txt2img and `editTurbo` (few-step, CFG 1) for edits. Edit takes no
 * LoRAs, since they are trained against `dev`.
 */

// The official version id; the handler throws while it is unset. Registering this graph in the hub
// also needs quantity capped at 4, the orchestrator's limit for this model.
export const fibo2VersionId: number | undefined = undefined;

export type Fibo2Model = 'dev' | 'editTurbo';

export const fibo2ModelOf = (workflow: string): Fibo2Model =>
  workflow.startsWith('txt') ? 'dev' : 'editTurbo';

// Stored per orchestrator model so an edit's turbo values don't clamp the create sliders.
const modelSlider = (model: Fibo2Model, opts: Parameters<typeof sliderDef>[0]) => () => ({
  ...sliderDef(opts),
  scope: [model],
});

const dev = defineGraph<FamilyExt>()
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field('resources', familyResources)
  .field('cfgScale', modelSlider('dev', { min: 1, max: 10, step: 0.5, default: 5 }))
  .field('steps', modelSlider('dev', { min: 10, max: 60, default: 30 }));

// No `model` field: an edit always runs the official editTurbo weights, so a picked fine-tune would
// be credited for an image it never ran.
const editTurbo = defineGraph<FamilyExt>()
  .field('cfgScale', modelSlider('editTurbo', { min: 1, max: 5, step: 0.5, default: 1 }))
  .field('steps', modelSlider('editTurbo', { min: 1, max: 12, default: 4 }));

const models = branch('fibo2Model', (ext: FamilyExt) => fibo2ModelOf(ext.workflow), {
  dev,
  editTurbo,
});

export const fibo2 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 16 }))
  .use(models)
  .field('aspectRatio', SDXL_FULL_AR)
  .field('seed', SEED)
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));
