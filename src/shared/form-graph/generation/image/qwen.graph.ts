import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SEED, aspectRatioDef, resourcesDef, sliderDef } from '../defs';
import { familyScope, makeTextBlock, type FamilyExt } from '../shared';

/**
 * Qwen family (Qwen / Qwen2 / Qwen3), ported from `qwen-graph.ts`. Three
 * ecosystems, one graph: Qwen is the comfy build (LoRAs, cfg/steps,
 * workflow-scoped version lists — a cross-workflow version hits the LOCK and
 * substitutes to the current workflow's default, probed); Qwen2 is the fal
 * build (negative prompt only); Qwen3 is DashScope (prompt expansion toggle).
 */

// ---- copied from qwen-graph.ts, which dies with the data-graph engine -------

export const qwenVersionIds = {
  txt2img_v2509: 2110043,
  txt2img_v2512: 2552908,
  img2img_v2509: 2133258,
  img2img_v2511: 2558804,
} as const;

const qwenTxt2ImgVersionOptions = [
  { label: 'v2509', value: qwenVersionIds.txt2img_v2509 },
  { label: 'v2512', value: qwenVersionIds.txt2img_v2512 },
];

const qwenImg2ImgVersionOptions = [
  { label: 'v2509', value: qwenVersionIds.img2img_v2509 },
  { label: 'v2511', value: qwenVersionIds.img2img_v2511 },
];

const qwenAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

const qwen2AspectRatios = [
  { label: '16:9', value: '16:9', width: 2048, height: 1152 },
  { label: '4:3', value: '4:3', width: 2048, height: 1536 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '3:4', value: '3:4', width: 1536, height: 2048 },
  { label: '9:16', value: '9:16', width: 1152, height: 2048 },
];

const qwen3AspectRatios = [
  { label: '16:9', value: '16:9', width: 1664, height: 928 },
  { label: '3:2', value: '3:2', width: 1584, height: 1056 },
  { label: '4:3', value: '4:3', width: 1472, height: 1140 },
  { label: '1:1', value: '1:1', width: 1328, height: 1328 },
  { label: '3:4', value: '3:4', width: 1140, height: 1472 },
  { label: '2:3', value: '2:3', width: 1056, height: 1584 },
  { label: '9:16', value: '9:16', width: 928, height: 1664 },
];

// ---- end of qwen-graph.ts copies --------------------------------------------

const isEditWorkflow = (workflow: string) => workflow.startsWith('img2img:edit');

const qwen1 = defineGraph<FamilyExt>()
  .field('model', ({ _ext }) => {
    const isEdit = isEditWorkflow(_ext.workflow);
    return checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: isEdit ? qwenImg2ImgVersionOptions : qwenTxt2ImgVersionOptions },
      defaultModelId: isEdit ? qwenVersionIds.img2img_v2511 : qwenVersionIds.txt2img_v2512,
    });
  })
  // v1 uses raw resourcesNode with a hardcoded 'Qwen' ecosystem: no filter
  .field('resources', ({ _ext }) =>
    resourcesDef({ ecosystem: 'Qwen', limit: _ext.limits.maxResources, filterIncompatible: false })
  )
  .field('aspectRatio', aspectRatioDef({ options: qwenAspectRatios, default: '1:1' }))
  .field('cfgScale', sliderDef({ min: 2, max: 20, default: 3.5, step: 0.5 }))
  .field('steps', sliderDef({ min: 20, max: 50, default: 25 }));

const qwen2 = defineGraph<FamilyExt>()
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field('aspectRatio', aspectRatioDef({ options: qwen2AspectRatios, default: '1:1' }));

const qwen3 = defineGraph<FamilyExt>()
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field(
    'aspectRatio',
    aspectRatioDef({
      options: qwen3AspectRatios,
      default: '1:1',
      priorityOptions: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    })
  )
  .field('enablePromptExpansion', {
    input: z.boolean().optional(),
    output: z.boolean(),
    default: true,
  });

/** Keyed on `ecosystem` — the hub resolves it before this family mounts. */
const subFamilies = branch('ecosystem', [
  [['Qwen'], qwen1],
  [['Qwen2'], qwen2],
  [['Qwen3'], qwen3],
] as const);

export const qwen = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 3 }))
  .field('seed', SEED)
  .use(subFamilies)
  // negativePrompt exists only in the Qwen2/Qwen3 subgraphs; its in-branch
  // snippet registration never fires
  .use(
    makeTextBlock({
      negativePrompt: (ext) => ext.ecosystem === 'Qwen2' || ext.ecosystem === 'Qwen3',
      negativePromptRegistersTarget: false,
    })
  );

export {
  qwenTxt2ImgVersionOptions,
  qwenImg2ImgVersionOptions,
  qwenAspectRatios,
  qwen2AspectRatios,
  qwen3AspectRatios,
};
