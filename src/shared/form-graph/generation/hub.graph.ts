import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import {
  getInputTypeForWorkflow,
  getOutputTypeForWorkflow,
  workflowConfigByKey,
} from '~/shared/data-graph/generation/config/workflows';
import { mergeGateStates, rulesToStates } from '~/shared/data-graph/generation/gates';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

import { imageHub } from './image/hub.graph';
import { videoHub } from './video/hub.graph';
import { audioHub } from './audio/hub.graph';
import { model3dHub } from './model3d/hub.graph';
import { imageUpscale } from './workflows/image-upscale.graph';
import {
  imagePreprocess,
  imageRemoveBackground,
  metadataExtraction,
  promptEnhancement,
} from './workflows/image-simple.graph';
import { videoInterpolation, videoUpscale } from './workflows/video-enhance.graph';

/**
 * The composed root, mirroring `generation-graph.ts`'s head: workflow (key
 * migration + gate refusal) and the output/input computeds, then a dispatch to
 * ONE hub per output type — each hub owns only its own ecosystems, defaults,
 * and head fields (v1 serves all four output types from one shared ecosystem
 * field; the port deliberately does not).
 */

// ---- copied from generation-graph.ts, which dies with the data-graph engine

// Copied from generation-graph.ts, which dies with the data-graph engine.
const priorityOptions = ['low', 'normal', 'high'] as const;
const outputFormatOptions = ['jpeg', 'png'] as const;

/** Maps new-format workflow keys back to old format for migration */
const NEW_TO_OLD: Record<string, string> = {
  'image:create': 'txt2img',
  'image:edit': 'img2img:edit',
  'image:draft': 'txt2img:draft',
  'image:face-fix': 'txt2img:face-fix',
  'image:hires-fix': 'txt2img:hires-fix',
  'image:upscale': 'img2img:upscale',
  'image:remove-background': 'img2img:remove-background',
  'video:create': 'txt2vid',
  'video:animate': 'txt2vid',
  'video:first-last-frame': 'img2vid',
  'video:ref2vid': 'img2vid:ref2vid',
  'video:upscale': 'vid2vid:upscale',
  'video:interpolate': 'vid2vid:interpolate',
  'video:edit': 'vid2vid:edit',
  'video:extend': 'vid2vid:extend',
  'audio:create': 'txt2music',
  'model3d:create': 'txt2model3d',
  'model3d:image-to-3d': 'img2model3d',
};

/** Migrate stored workflow key to current format, falling back to txt2img if unknown */
export function migrateWorkflowKey(key: string | undefined): string | undefined {
  if (!key) return key;
  // Migrate old first-last-frame key to img2vid (now an alias on Vidu)
  if (key === 'img2vid:first-last-frame') return 'img2vid';
  const resolved = NEW_TO_OLD[key] ?? key;
  // If the resolved key doesn't match any known workflow, default to txt2img
  if (!workflowConfigByKey.has(resolved)) return 'txt2img';
  return resolved;
}

/** Keyed on the `output` computed, declared above the dispatch. */
const outputHubs = branch('output', [
  [['image'], imageHub],
  [['video'], videoHub],
  [['audio'], audioHub],
  [['model3d'], model3dHub],
] as const);

/**
 * The standalone (no-ecosystem) workflows, each its own branch in v1's root
 * discriminator. Everything else routes to the per-output ecosystem hubs.
 */
const STANDALONE_WORKFLOWS = new Set([
  'vid2vid:interpolate',
  'vid2vid:upscale',
  'img2img:upscale',
  'img2img:remove-background',
  'img2img:preprocess',
  'img2meta',
  'prompt:enhance',
]);

const workflowKinds = branch('workflowKind', [
  [['vid2vid:interpolate'], videoInterpolation],
  [['vid2vid:upscale'], videoUpscale],
  [['img2img:upscale'], imageUpscale],
  [['img2img:remove-background'], imageRemoveBackground],
  [['img2img:preprocess'], imagePreprocess],
  [['img2meta'], metadataExtraction],
  [['prompt:enhance'], promptEnhancement],
  [['ecosystem'], outputHubs],
] as const);

const WORKFLOW_INPUT = z.string().optional().transform(migrateWorkflowKey);
const workflowOutput = defFamily((gatedKey: string) => {
  const gated = new Set(gatedKey ? gatedKey.split('|') : []);
  return gated.size
    ? z.string().refine((v) => !gated.has(v), {
        message: 'Workflow is currently unavailable',
      })
    : z.string();
});
const priorityInput = defFamily((isMember: boolean) =>
  z
    .enum(priorityOptions)
    .optional()
    .transform((val) => (!isMember && val === 'high' ? ('low' as const) : val))
);
const PRIORITY_OUTPUT = z.enum(priorityOptions);
const OUTPUT_FORMAT_INPUT = z.enum(outputFormatOptions).optional();
const OUTPUT_FORMAT_OUTPUT = z.enum(outputFormatOptions);

export const generationHub = defineGraph<GenerationCtx>()
  .field('workflow', ({ _ext }) => {
    const { hidden, states } = mergeGateStates(
      undefined,
      rulesToStates(_ext.gateRules ?? []).workflows
    );
    const gated = [...new Set([...hidden, ...states.map((s) => s.key)])].sort();
    return {
      input: WORKFLOW_INPUT,
      output: workflowOutput(gated.join('|')),
      default: 'txt2img',
      // hiddenWorkflows leave the picker; workflowStates are badged
      meta: { hiddenWorkflows: hidden, workflowStates: states },
    };
  })
  .computed('output', ({ workflow }) => getOutputTypeForWorkflow(workflow))
  .computed('input', ({ workflow }) => getInputTypeForWorkflow(workflow))
  // v1 declares priority/outputFormat at the ROOT gated on image output, so
  // they apply to the standalone image workflows too, not just the image hub
  .field('priority', ({ output, _ext }) => {
    if (output !== 'image') return null;
    const isMember = _ext.user?.isMember ?? false;
    const options: {
      label: string;
      value: (typeof priorityOptions)[number];
      offset: number;
      lineThrough?: boolean;
      memberOnly?: boolean;
    }[] = isMember
      ? [
          { label: 'High', value: 'low', offset: 10, lineThrough: true },
          { label: 'Highest', value: 'high', offset: 20 },
        ]
      : [
          { label: 'Standard', value: 'low', offset: 0 },
          { label: 'High', value: 'normal', offset: 10 },
          { label: 'Highest', value: 'high', offset: 20, memberOnly: true },
        ];
    return {
      input: priorityInput(isMember),
      output: PRIORITY_OUTPUT,
      default: 'low' as const,
      meta: { options, isMember },
    };
  })
  .field('outputFormat', ({ output, workflow, _ext }) =>
    output !== 'image' || workflow === 'img2img:remove-background'
      ? null
      : {
          input: OUTPUT_FORMAT_INPUT,
          output: OUTPUT_FORMAT_OUTPUT,
          default: 'jpeg' as const,
          meta: {
            options: [
              { label: 'JPEG', value: 'jpeg' as const, offset: 0 },
              { label: 'PNG', value: 'png' as const, offset: 2 },
            ],
            isMember: _ext.user?.isMember ?? false,
          },
        }
  )
  // state-only (the oracle's wire has no such key): standalone workflows get
  // their own arm; everything else rides the per-output ecosystem hubs
  .computed(
    'workflowKind',
    ({ workflow }) => (STANDALONE_WORKFLOWS.has(workflow) ? workflow : 'ecosystem'),
    { emit: false }
  )
  .use(workflowKinds);

export type GenerationState = ReturnType<typeof generationHub.resolve>;
