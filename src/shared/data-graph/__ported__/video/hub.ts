import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { VID_QUANTITY_ECOSYSTEMS } from '~/shared/constants/generation.constants';
import {
  getInputTypeForWorkflow,
  getOutputTypeForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import { getEcosystemStates } from '~/shared/data-graph/generation/ecosystem-graph';
import { migrateWorkflowKey } from '~/shared/data-graph/generation/generation-graph';
import { mergeGateStates, rulesToStates } from '~/shared/data-graph/generation/gates';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

import { ltx } from './ltx';
import { deriveWanBackendEcosystem, wan } from './wan';
import type { VideoExt } from './shared';

/**
 * The hub slice of `generation-graph.ts` + `ecosystem-graph.ts` for the two
 * video families ported so far. Mirrors what the oracle produces for these
 * branches: workflow (key migration + gate refusal), computed output/input,
 * ecosystem (gate-hidden dropped at the boundary, hidden+disabled refused on
 * output), and quantity for the video ecosystems that batch.
 *
 * `priority` / `outputFormat` are image-output only in the oracle, so they
 * never appear on a video branch.
 */

const QUANTITY = defFamily((max: number) => {
  const snap = (val: number) => Math.min(Math.max(Math.round(val), 1), max);
  return {
    input: z.coerce
      .number()
      .optional()
      .transform((val) => (val === undefined ? undefined : snap(val))),
    output: z.number().min(1).max(max),
    default: 1,
    meta: { min: 1, max, step: 1 },
  };
});

/** Which family graph owns an ecosystem. Untagged: the oracle has no family key. */
const families = branch(
  (ext: VideoExt) => (ext.ecosystem.startsWith('LTXV') ? 'ltx' : 'wan'),
  { ltx, wan }
);

export const videoHub = defineGraph<GenerationCtx>()
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
    };
  })
  .computed('output', ({ workflow }) => getOutputTypeForWorkflow(workflow))
  .computed('input', ({ workflow }) => getInputTypeForWorkflow(workflow))
  .field('ecosystem', ({ workflow, output, _ext }) => {
    const { compatibleEcosystems, hiddenEcosystems, ecosystemStates } = getEcosystemStates(
      workflow,
      _ext
    );
    const hiddenSet = new Set(hiddenEcosystems);
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const outputDefault =
      output === 'audio'
        ? 'Ace'
        : output === 'video'
          ? 'Seedance'
          : output === 'model3d'
            ? 'PolyGen'
            : 'ZImageTurbo';
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes(outputDefault)
      ? outputDefault
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'SDXL';

    return {
      input: z
        .string()
        .optional()
        .transform((v) => {
          if (!v) return undefined;
          // Hidden values are dropped at the boundary so a stale stored value
          // falls back to the default; disabled/memberOnly are kept so the
          // picker can explain them, and refused on output.
          if (hiddenSet.has(v)) return undefined;
          return v;
        }),
      output:
        hiddenSet.size || disabledSet.size
          ? z.string().refine((v) => !hiddenSet.has(v) && !disabledSet.has(v), {
              message: 'Ecosystem is currently unavailable',
            })
          : z.string(),
      default: defaultValue,
    };
  })
  .field('quantity', ({ ecosystem, output, _ext }) => {
    const batchesVideos = VID_QUANTITY_ECOSYSTEMS.has(ecosystem);
    const supportsVideoQuantity = output === 'video' && batchesVideos;
    if (!(output === 'image' || supportsVideoQuantity)) return null;
    const max = batchesVideos ? _ext.limits.vidQuantity : _ext.limits.maxQuantity;
    return QUANTITY(max);
  })
  .use(families);

export type VideoState = ReturnType<typeof videoHub.resolve>;

/**
 * Parse + submission projection. The graph's `ecosystem` field holds the
 * user's SELECTION; the BACKEND target v1 stored under the same key is a pure
 * function of (selection, workflow, resolution) and is derived here, at the
 * boundary — the same function the model definitions use internally. This is
 * production code: the Phase 4 adapter submits its output.
 */
export function parseVideo(raw: Record<string, unknown>, ctx: GenerationCtx) {
  const result = videoHub.parse(raw, ctx);
  if (!result.success) return result;
  const state = result.state as { ecosystem: string; workflow: string; resolution?: string };
  const backend = deriveWanBackendEcosystem(state.ecosystem, state.workflow, state.resolution);
  if (backend === state.ecosystem) return result;
  return {
    ...result,
    data: { ...(result.data as object), ecosystem: backend },
    state: { ...(result.state as object), ecosystem: backend },
  } as typeof result;
}
