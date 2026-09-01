import { z } from 'zod';
import { branch, defFamily, defineGraph, parseFixpoint } from 'form-graph';
import { VID_QUANTITY_ECOSYSTEMS } from '~/shared/constants/generation.constants';
import {
  getInputTypeForWorkflow,
  getOutputTypeForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import { getEcosystemStates } from '~/shared/data-graph/generation/ecosystem-graph';
import { migrateWorkflowKey } from '~/shared/data-graph/generation/generation-graph';
import { mergeGateStates, rulesToStates } from '~/shared/data-graph/generation/gates';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * A field resolved on a PREVIOUS pass, fed back so a correction can consult a
 * value that resolves after it. See `parseVideo`: data-graph iterates its graph
 * to a fixed point; form-graph resolves once in declaration order, so the
 * iteration lives here — explicit and bounded — instead of inside the graph.
 */
export type VideoHubExt = GenerationCtx & { resolvedResolution?: string };
import { ecosystemToVersionDef } from '~/shared/data-graph/generation/wan-graph';
import { ltx } from './ltx';
import { wan } from './wan';
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

export const videoHub = defineGraph<VideoHubExt>()
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
      // wan-graph.ts syncs the ecosystem to the workflow (T2V <-> I2V) with an
      // EFFECT. data-graph runs effects during safeParse; form-graph runs rules
      // on set() only — so a sync that is a pure function of other resolved
      // fields belongs in resolution, as a correction, or a server-side parse
      // would keep an ecosystem the client would have moved off.
      correct: (value: string) => {
        const def = ecosystemToVersionDef.get(value);
        if (!def) return undefined;
        const isImg2vid = workflow === 'img2vid';
        let target: string;
        if (def.version === 'v2.1') {
          // v2.1's I2V is resolution-dependent, and `resolution` lives in the
          // version subgraph — it resolves AFTER this field. The previous
          // pass's value (fed back by `parseVideo`) is what makes the 480p /
          // 720p choice correct; on a first pass it is the enum's default.
          const resolution = _ext.resolvedResolution ?? '480p';
          target = isImg2vid
            ? resolution === '480p'
              ? def.ecosystems.i2v_480p
              : def.ecosystems.i2v
            : def.ecosystems.t2v;
        } else {
          target = isImg2vid ? def.ecosystems.i2v : def.ecosystems.t2v;
        }
        return target && target !== value
          ? { value: target, reason: 'workflow_ecosystem_sync', detail: { workflow } }
          : undefined;
      },
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
 * Parse entry point: form-graph's `parseFixpoint` supplies the bounded
 * fixed-point that Wan 2.1's ecosystem<->resolution coupling needs — the
 * resolved resolution feeds back through ext until a pass changes nothing.
 */
export function parseVideo(raw: Record<string, unknown>, ctx: GenerationCtx) {
  return parseFixpoint(videoHub, raw, ctx as VideoHubExt, (state) => {
    const resolution = (state as { resolution?: string }).resolution;
    return resolution !== undefined ? { resolvedResolution: resolution } : null;
  });
}
