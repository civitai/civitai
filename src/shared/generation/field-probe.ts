import type { GenerationCtx } from '~/shared/generation/context';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';

/**
 * The entitlement a probe answers under: the NARROWEST one, so a limit it reports is a
 * limit every caller can rely on. Free tier, no flags, no gate rules.
 *
 * Exported because three callers probe (`images-limit`, `workflow-capability`,
 * `workflow-media`) and each had a byte-identical private copy. One drifting copy makes
 * the three answer under different entitlements — App Blocks refusing what the form allows,
 * or the reverse — and nothing would have reported the divergence.
 */
export const PROBE_CTX: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: false, tier: 'free' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
};

/**
 * Read one field's resolved META for a pinned (workflow, ecosystem), the way the form would
 * see it — for server code answering "what are this field's constraints here" without
 * building a form.
 *
 * WHY A STORE AND NOT `fieldMeta`. form-graph exports an introspection API for exactly this
 * question (`fieldMeta`/`hasField`/`optionsFor`), and it is unreachable from any form in this
 * app: it reads `FormDefinition.resolve(values, ext).records`, while a graph-authored form
 * exposes `Graph.resolve(fields, ext) -> Ctx` — a different function of the same name.
 * Passing the hub throws `f.field is not a function`, and `FormDefinition` is not exported.
 *
 * 🔴 THE GUARD, AND WHY IT IS THIS SHAPE.
 *
 * The workflow must survive: `migrateWorkflowKey` coerces an unknown key to `txt2img` on the
 * input path with no note, so without this a bogus workflow reports txt2img's constraints as
 * its own.
 *
 * The ecosystem must survive IF the graph kept one — `!== undefined && !== pin`. Both halves
 * are load-bearing, measured:
 *   · `Flux1`/`img2img` resolves to `SD1`/img2img and `NotAnEcosystem`/`img2img:edit` to
 *     `Qwen`/img2img:edit, each with a real `images` limit. App Blocks must fail CLOSED on
 *     both; a workflow-only guard let them through.
 *   · `img2img:upscale` and the other standalone workflows resolve `ecosystem` to `undefined`
 *     legitimately — the concept does not apply — so a plain equality check rejects a large
 *     set of pins whose answers are correct.
 *
 * NOT selector equality on the ecosystem alone. The hub reaches a sibling route by keeping the
 * stated ecosystem and correcting the MODEL, so the pinned ecosystem survives and comparing it
 * proves nothing — five Wan/Kling pairs (`WanVideo14B_T2V`/img2vid and friends) answer
 * correctly and a plain equality check rejects them. `field-probe.guard.test.ts` names them.
 *
 * NOT the correction notes either, the other obvious move: the hub emits NO note on
 * `workflow`/`ecosystem` in any of these cases, so a notes-based guard never fires at all.
 *
 * Callers MUST treat undefined as "cannot determine" and fail closed, never as "unlimited".
 */
export function probeFieldMeta(
  field: string,
  pin: { workflow: string; ecosystem: string },
  ext: GenerationCtx
): unknown {
  try {
    const store = generationHub.createStore({ ext, defaults: pin } as never);
    const state = store.getState() as { workflow?: string; ecosystem?: string };
    if (state.workflow !== pin.workflow) return undefined;
    if (state.ecosystem !== undefined && state.ecosystem !== pin.ecosystem) return undefined;
    return store.getField(field)?.meta;
  } catch {
    return undefined;
  }
}

/**
 * Does `field` exist for `workflow`, with the ecosystem left to resolve to its default?
 *
 * The retired graph answered this with `findKeyInBranches(['workflow','ecosystem'], key,
 * { workflow })`. form-graph exports `hasField` for exactly this, and it is unreachable for a
 * graph-authored form — see the note above — so this pins the workflow only and asks the store.
 *
 * The ECOSYSTEM IS DELIBERATELY UNPINNED, which is why this cannot reuse `probeFieldMeta`:
 * that guards on the resolved ecosystem matching the one asked for, and here there is none to
 * match. The workflow still has to survive, for the `migrateWorkflowKey` reason given above.
 */
export function probeFieldExists(field: string, workflow: string, ext: GenerationCtx): boolean {
  try {
    const store = generationHub.createStore({ ext, defaults: { workflow } } as never);
    const state = store.getState() as { workflow?: string };
    if (state.workflow !== workflow) return false;
    return store.getField(field) != null;
  } catch {
    return false;
  }
}
