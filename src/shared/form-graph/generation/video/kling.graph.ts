import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { klingVersionIds } from '~/shared/data-graph/generation/version-ids';
import { checkpointDef } from '../checkpoint';
import {
  SEED,
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
 * Kling (V1.6 / V2 / V2.5 Turbo on the legacy engine, V3 on kling-v3),
 * ported from `kling-graph.ts`. ref2vid exists only on V3, so that workflow
 * FORCES the model to V3 (probed — v1's workflow-triggered effect wins over
 * its model-triggered fallback). V3's `multiShot`/`klingElements` subtree is
 * dead in v1 (`when: false` root) and is not ported. V3 derives an
 * `operation` from the workflow; legacy carries the negative prompt, V3 does
 * not.
 */

// ---- copied from kling-graph.ts, which dies with the data-graph engine ------

const klingVersionOptions = [
  { label: 'V1.6', value: klingVersionIds.v1_6 },
  { label: 'V2', value: klingVersionIds.v2 },
  { label: 'V2.5 Turbo', value: klingVersionIds.v2_5_turbo },
  { label: 'V3', value: klingVersionIds.v3 },
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

export type KlingVersion = 'legacy' | 'v3';

export type KlingV3Operation = 'text-to-video' | 'image-to-video' | 'reference-to-video';

function getV3Operation(workflow: string): KlingV3Operation {
  if (workflow === 'img2vid:ref2vid') return 'reference-to-video';
  if (workflow.startsWith('img2vid')) return 'image-to-video';
  return 'text-to-video';
}

// ---- end of kling-graph.ts copies -------------------------------------------

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
          meta: { options: klingModes },
        }
      : null
  )
  .field('duration', enumDef({ options: klingDurations, default: '5' }))
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
  .field('mode', enumDef({ options: klingModes, default: 'standard' }))
  .field('duration', V3_DURATION)
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? aspectRatioDef({ options: klingAspectRatios, default: '1:1' })
      : null
  )
  .field('generateAudio', boolDef(false))
  .use(makeTextBlock({ negativePrompt: false, promptAlwaysRequired: true }));

/** Tagged: v1's `klingVersion` computed becomes the branch key. */
const versions = branch(
  'klingVersion',
  (ext: KlingExt): KlingVersion => (modelIdOf(ext.model) === klingVersionIds.v3 ? 'v3' : 'legacy'),
  { legacy, v3 }
);

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
        // ref2vid exists only on the kling-v3 engine — the workflow wins
        if (_ext.workflow === 'img2vid:ref2vid' && value?.id !== klingVersionIds.v3) {
          return {
            value: { id: klingVersionIds.v3, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'ref2vid_requires_v3',
          };
        }
        return base.correct?.(value);
      },
    };
  })
  .use(versions);

export { klingVersionOptions, klingAspectRatios, klingModes, klingDurations };
