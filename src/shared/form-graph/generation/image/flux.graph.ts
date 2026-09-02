import { branch, defineGraph } from 'form-graph';
import { fluxControlNetPreprocessors } from '~/shared/constants/controlnets.constants';
import { checkpointDef } from '../checkpoint';
import {
  SDXL_SQUARE_AR,
  SEED,
  aspectRatioDef,
  boolDef,
  guidancePresetsLowBalHigh,
  controlNetsDef,
  sliderDef,
  type ResourceData,
} from '../defs';
import {
  familyResources,
  familyScope,
  promptOnlyTextBlock,
  versionModeOf,
  type FamilyExt,
} from '../shared';

/**
 * Flux family (Flux1 + FluxKrea), ported from `flux-graph.ts`. No negative
 * prompt, no sampler, no CLIP skip. The MODE (draft/standard/pro/krea/ultra)
 * derives from the model version id and picks the mode branch; the mounted
 * branch's pick sees `model` because ctx-so-far merges over ext.
 *
 * The draft coupling is v1's two sync effects, resolved at parse the way the
 * oracle resolves them (probed 2026-09-01): the WORKFLOW wins — a draft
 * workflow forces the draft model even over an explicit selection, and a
 * non-draft workflow snaps the draft model back to standard. Both are
 * `correct` policies on the model, keyed on the upstream workflow.
 */

// ---- copied from flux-graph.ts, which dies with the data-graph engine -------

export type FluxMode = 'draft' | 'standard' | 'pro' | 'krea' | 'ultra';

const fluxVersionIds = {
  draft: 699279,
  standard: 691639,
  pro: 922358,
  krea: 2068000,
  ultra: 1088507,
} as const;

const fluxModeVersionOptions = [
  { label: 'Draft', value: fluxVersionIds.draft },
  { label: 'Standard', value: fluxVersionIds.standard },
  { label: 'Krea', value: fluxVersionIds.krea },
  { label: 'Pro 1.1', value: fluxVersionIds.pro },
  { label: 'Ultra', value: fluxVersionIds.ultra },
];

const fluxUltraAspectRatios = [
  { label: '21:9', value: '21:9', width: 3136, height: 1344 },
  { label: '16:9', value: '16:9', width: 2752, height: 1536 },
  { label: '4:3', value: '4:3', width: 2368, height: 1792 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '3:4', value: '3:4', width: 1792, height: 2368 },
  { label: '9:16', value: '9:16', width: 1536, height: 2752 },
  { label: '9:21', value: '9:21', width: 1344, height: 3136 },
];

// ---- end of flux-graph.ts copies --------------------------------------------

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const fluxModeOf = versionModeOf(fluxVersionIds, 'standard');

const AR = SDXL_SQUARE_AR;
const AR_ULTRA = aspectRatioDef({ options: fluxUltraAspectRatios, default: '1:1' });
const CFG = sliderDef({
  min: 2,
  max: 20,
  default: 3.5,
  step: 0.5,
  presets: guidancePresetsLowBalHigh,
});
const STEPS = sliderDef({ min: 20, max: 50, default: 25 });
const CONTROL_NETS = controlNetsDef({ preprocessors: fluxControlNetPreprocessors, limit: 1 });

type FluxModeExt = FamilyExt & { model?: ResourceData | number };

const draft = defineGraph<FluxModeExt>()
  .scope(familyScope)
  .field('aspectRatio', AR)
  .field('seed', SEED);

const pro = defineGraph<FluxModeExt>()
  .scope(familyScope)
  .field('aspectRatio', AR)
  .field('cfgScale', CFG)
  .field('steps', STEPS)
  .field('seed', SEED);

/** standard and krea share this shape (v1 mounts one graph for both). */
const standard = defineGraph<FluxModeExt>()
  .scope(familyScope)
  .field('aspectRatio', AR)
  .field('cfgScale', CFG)
  .field('steps', STEPS)
  .field('controlNets', ({ _ext }) => (_ext.workflow === 'txt2img' ? CONTROL_NETS : null))
  .field('seed', SEED)
  .field('resources', familyResources);

const ultra = defineGraph<FluxModeExt>()
  .scope(familyScope)
  .field('aspectRatio', AR_ULTRA)
  .field('fluxUltraRaw', boolDef(false))
  .field('seed', SEED);

/** Tagged: v1's `fluxMode` computed becomes the branch key, same state shape. */
const modes = branch('fluxMode', (ext: FluxModeExt) => fluxModeOf(ext.model), {
  draft,
  standard,
  krea: standard,
  pro,
  ultra,
});

export const flux = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('model', ({ _ext }) => {
    const isDraftWorkflow = _ext.workflow === 'txt2img:draft';
    const base = checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: fluxModeVersionOptions },
      modelLocked: isDraftWorkflow,
    });
    return {
      ...base,
      correct: (value) => {
        const isDraftModel = value?.id === fluxVersionIds.draft;
        if (isDraftWorkflow && !isDraftModel) {
          return {
            value: { id: fluxVersionIds.draft, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'draft_workflow_forces_draft_model',
          };
        }
        if (!isDraftWorkflow && isDraftModel) {
          return {
            value: { id: fluxVersionIds.standard, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'draft_model_needs_draft_workflow',
          };
        }
        return base.correct?.(value);
      },
    };
  })
  .use(modes)
  .use(promptOnlyTextBlock);

export { fluxModeVersionOptions, fluxVersionIds };
