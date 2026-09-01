import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import {
  getInputTypeForWorkflow,
  getOutputTypeForWorkflow,
  workflowConfigByKey,
} from '~/shared/data-graph/generation/config/workflows';
import { mergeGateStates, rulesToStates } from '~/shared/data-graph/generation/gates';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

import { imageHub } from './image/hub.graph';
import { videoHub } from './video/hub.graph';
import type { RootCtx } from './shared';

/**
 * The composed root, mirroring `generation-graph.ts`'s head: workflow (key
 * migration + gate refusal) and the output/input computeds, then a dispatch to
 * ONE hub per output type — each hub owns only its own ecosystems, defaults,
 * and head fields (v1 serves all four output types from one shared ecosystem
 * field; the port deliberately does not). Audio and model3d hubs arrive with
 * their families.
 */

// ---- copied from generation-graph.ts, which dies with the data-graph engine

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

/** Untagged: the oracle has no output-family key in data. */
const outputHubs = branch((ext: RootCtx) => {
  switch (ext.output) {
    case 'video':
      return videoHub;
    case 'image':
    // audio and model3d hubs arrive with their families
    default:
      return imageHub;
  }
});

export const generationHub = defineGraph<GenerationCtx>()
  .field('workflow', ({ _ext }) => {
    const { hidden, states } = mergeGateStates(
      undefined,
      rulesToStates(_ext.gateRules ?? []).workflows
    );
    const gated = new Set([...hidden, ...states.map((s) => s.key)]);
    return {
      input: z.string().optional().transform(migrateWorkflowKey),
      output: gated.size
        ? z.string().refine((v) => !gated.has(v), {
            message: 'Workflow is currently unavailable',
          })
        : z.string(),
      default: 'txt2img',
      // hiddenWorkflows leave the picker; workflowStates are badged
      meta: { hiddenWorkflows: hidden, workflowStates: states },
    };
  })
  .computed('output', ({ workflow }) => getOutputTypeForWorkflow(workflow))
  .computed('input', ({ workflow }) => getInputTypeForWorkflow(workflow))
  .use(outputHubs);

export type GenerationState = ReturnType<typeof generationHub.resolve>;
