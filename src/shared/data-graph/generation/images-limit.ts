/**
 * Per-ecosystem source-image limits, read from the REAL generation graph.
 *
 * WHY THIS EXISTS
 * ---------------
 * How many reference/source images an image workflow accepts is declared ONLY
 * inside the per-ecosystem graph files (`imagesNode({ min, max, slots })` in
 * qwen-graph / flux2-graph / boogu-graph / …), never in a central table. The
 * real spread today is wide — Boogu / Flux.1 Kontext / MAI / SD-family accept
 * 1, Qwen / Qwen2 / MageFlow 3, Reve / HiDream-O1 4, WanImage 5, Flux.2 /
 * Flux.2 Klein / OpenAI / NanoBanana / Seedream / Grok 7 — so a flat constant
 * would simultaneously over-allow the 1-image ecosystems and under-allow the
 * 7-image ones.
 *
 * Rather than copy that spread into a parallel table that rots the moment a
 * graph file changes, this INSTANTIATES the real `generationGraph` for the
 * (ecosystem, workflow) pair and reads the `images` node meta the generation
 * form itself renders from — the single source of truth, by construction.
 *
 * NEUTRAL PROBE CONTEXT: the probe runs with a fixed, free-tier-shaped
 * `GenerationCtx` carrying no gate rules. It answers "what does the CONFIG
 * allow for this ecosystem?", not "what may THIS user generate?" — per-user
 * limits and entitlement gating still run downstream in
 * `createWorkflowStepsFromGraphInput`. Nothing in `imagesNode` reads `limits`,
 * `user` or `gateRules`, so no per-user value can leak into the answer.
 *
 * COST: `clone() + init()` measured at ~1.4 ms; results are memoized per
 * `${ecosystem}|${workflow}` since the underlying config is static per process.
 *
 * NOTE FOR REVIEW: civitai#3517 adds a sibling probe module
 * (`workflow-capability.ts`) that reads the `model` node's meta the same way.
 * The two are deliberately separate files so the PRs don't collide; once both
 * land they should be folded into one probe helper.
 */

import { generationGraph } from './generation-graph';
import type { GenerationCtx } from './context';

/**
 * Fixed capability-probe context. NOT a user's context — see the module note.
 */
const PROBE_CTX: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: false, tier: 'free' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
};

export type ImagesLimit = {
  /** Minimum images the workflow requires (1 for every image workflow today). */
  min: number;
  /** Maximum images the workflow accepts. */
  max: number;
};

const limitCache = new Map<string, ImagesLimit | undefined>();

/**
 * The `images` node's {min, max} for one (ecosystem, workflow) pair, or
 * `undefined` when the pair has no images node at all.
 *
 * `undefined` means one of:
 *   - the workflow does not take images (every `txt2*` workflow — the node
 *     carries `when: !workflow.startsWith('txt')` and is absent from ctx), or
 *   - the (ecosystem, workflow) pair is not a coherent combination, in which
 *     case the graph's own effects re-route it. We verify the instantiated
 *     context still holds the pair we asked about and report "no opinion"
 *     rather than returning a limit that describes a different route.
 *
 * A caller MUST treat `undefined` as "cannot determine" and fail closed rather
 * than as "unlimited".
 */
export function getImagesLimit(ecosystem: string, workflow: string): ImagesLimit | undefined {
  const cacheKey = `${ecosystem}|${workflow}`;
  if (limitCache.has(cacheKey)) return limitCache.get(cacheKey);

  let limit: ImagesLimit | undefined;
  try {
    const clone = generationGraph.clone();
    clone.init({ workflow, ecosystem } as never, PROBE_CTX, { skipStorage: true });
    const ctx = clone.ctx as { workflow?: string; ecosystem?: string };
    if (ctx.workflow === workflow && ctx.ecosystem === ecosystem) {
      const meta = clone.getNodeMeta('images' as never) as
        | { min?: number; max?: number }
        | undefined;
      if (typeof meta?.min === 'number' && typeof meta?.max === 'number') {
        limit = { min: meta.min, max: meta.max };
      }
    }
  } catch {
    // A probe failure reports "cannot determine"; the caller fails closed.
    limit = undefined;
  }

  limitCache.set(cacheKey, limit);
  return limit;
}
