import { ecosystemByKey, getEcosystemDefaults } from '~/shared/constants/basemodel.constants';
import { DRAFT_WORKFLOW } from '~/shared/constants/generation.constants';
import { getWorkflowsForEcosystem, isWorkflowAvailable } from '~/shared/generation/config';
import { ecosystemKeyForBaseModel } from './checkpoint';
import { booguVersionIds } from './image/boogu.graph';
import { viduVersionIds } from '~/shared/generation/version-ids';

/**
 * Selector reconciliation: a model whose baseModel
 * belongs to another ecosystem drags `ecosystem` (and, when that ecosystem
 * doesn't support the current workflow, `workflow`) with it. ONE pure policy with
 * two adapters — a raw→raw normalizer applied before `parse` at the server
 * boundary, and a store rule for interactive edits. The derivation depends
 * only on raw-visible facts, so the normalizer is idempotent by construction:
 * a second pass sees `ecosystem === modelEco` and returns nothing.
 */

// a type (not interface) so its implicit index signature satisfies the rule
// contract's Record<string, unknown> return
export type SelectorCorrection = {
  ecosystem?: string;
  workflow?: string;
};

/**
 * The policy, as a pure function. Returns the selector
 * rewrite a cross-ecosystem model implies, or undefined when nothing moves.
 * The workflow fallback is the target ecosystem's FIRST
 * configured workflow, unfiltered.
 */
export function deriveSelectorsFromModel(
  model: { id?: number; baseModel?: string } | undefined,
  current: { ecosystem: string | undefined; workflow: string | undefined }
): SelectorCorrection | undefined {
  const modelEco = model?.baseModel ? ecosystemKeyForBaseModel(model.baseModel) : undefined;
  if (!modelEco || modelEco === current.ecosystem) return undefined;

  // A LOCKED model slot beats a cross-FAMILY model: the locked substitution replaces
  // it before anything could switch on it, so no switch happens there. Version SIBLINGS (LTXV23 on LTXV2, wan on wan) are
  // valid entries in the locked picker's own version list, so they re-pick the
  // version branch — the lock does not apply.
  if (
    current.ecosystem &&
    familyOf(modelEco) !== familyOf(current.ecosystem) &&
    isModelLocked(current.ecosystem, current.workflow)
  )
    return undefined;

  const target = ecosystemByKey.get(modelEco);
  if (!target) return undefined;

  const workflow = current.workflow ?? 'txt2img';
  if (isWorkflowAvailable(workflow, target.id)) {
    return { ecosystem: modelEco };
  }

  const compatibleWorkflows = getWorkflowsForEcosystem(target.id);
  if (compatibleWorkflows.length === 0) return undefined; // don't switch
  return { ecosystem: modelEco, workflow: compatibleWorkflows[0].id };
}

/** Ecosystems that are versions of one picker family collapse to one key. */
function familyOf(ecosystem: string): string {
  if (ecosystem.startsWith('LTX')) return 'LTX';
  if (ecosystem.startsWith('WanVideo')) return 'WanVideo';
  if (ecosystem.startsWith('Flux2Klein')) return 'Flux2Klein';
  if (ecosystem === 'Flux1' || ecosystem === 'FluxKrea') return 'Flux';
  return ecosystem;
}

function isModelLocked(ecosystem: string, workflow: string | undefined): boolean {
  // Flux draft locks its picker to the draft build (flux.graph.ts's modelLocked)
  if ((ecosystem === 'Flux1' || ecosystem === 'FluxKrea') && workflow === DRAFT_WORKFLOW)
    return true;
  const eco = ecosystemByKey.get(ecosystem);
  if (!eco) return false;
  return getEcosystemDefaults(eco.id)?.modelLocked ?? false;
}

/**
 * Families whose version picker is WORKFLOW-scoped: a known version id that
 * belongs to another workflow's list drags the workflow with it (Boogu: an edit
 * checkpoint on txt2img parses as img2img:edit with the model kept).
 */
const workflowScopedVersions: Record<string, Record<string, ReadonlySet<number>>> = {
  Boogu: {
    txt2img: new Set([booguVersionIds.base, booguVersionIds.turbo]),
    'img2img:edit': new Set([booguVersionIds.edit, booguVersionIds.editTurbo]),
  },
  // MageFlow shares the workflowVersions machinery but REMAPS its model into the
  // current workflow (index-equivalent) instead of following it — the remap is a
  // `correct` in mage-flow.graph.ts.
};

export function deriveWorkflowFromModel(
  model: { id?: number } | undefined,
  current: { ecosystem: string | undefined; workflow: string | undefined }
): SelectorCorrection | undefined {
  const id = model?.id;
  // The Flux draft build only runs under the draft workflow. Moving the workflow (not swapping the
  // model to standard) is what keeps a non-interactive caller — an App Block, a remix — from being
  // billed for a build it didn't ask for.
  if (
    (current.ecosystem === 'Flux1' || current.ecosystem === 'FluxKrea') &&
    id === FLUX_DRAFT_ID &&
    current.workflow !== DRAFT_WORKFLOW
  ) {
    return { workflow: DRAFT_WORKFLOW };
  }
  // Vidu Q3 has no reference-to-video operation, so picking the Q3 build drops the
  // workflow back to plain img2vid
  if (
    current.ecosystem === 'Vidu' &&
    id === viduVersionIds.q3 &&
    current.workflow === 'img2vid:ref2vid'
  ) {
    return { workflow: 'img2vid' };
  }
  // Vidu Q4 has no text-to-video or last-frame input: both land on plain img2vid
  if (
    current.ecosystem === 'Vidu' &&
    id === viduVersionIds.q4 &&
    (current.workflow === 'txt2vid' || current.workflow === 'img2vid:first-last')
  ) {
    return { workflow: 'img2vid' };
  }
  const table = current.ecosystem ? workflowScopedVersions[current.ecosystem] : undefined;
  if (!table || id == null) return undefined;
  const workflow = current.workflow ?? 'txt2img';
  const keys = Object.keys(table);
  // prefix matching on the workflow key
  const currentKey = keys.find((k) => workflow === k || workflow.startsWith(k));
  if (currentKey && table[currentKey]!.has(id)) return undefined;
  const targetKey = keys.find((k) => table[k]!.has(id));
  if (!targetKey || targetKey === currentKey) return undefined;
  return { workflow: targetKey };
}

/** Both model-driven corrections, composed — what the adapters apply. */
export function deriveCorrectionsFromModel(
  model: { id?: number; baseModel?: string } | undefined,
  current: { ecosystem: string | undefined; workflow: string | undefined }
): SelectorCorrection | undefined {
  const eco = deriveSelectorsFromModel(model, current);
  const wf = deriveWorkflowFromModel(model, {
    ecosystem: eco?.ecosystem ?? current.ecosystem,
    workflow: eco?.workflow ?? current.workflow,
  });
  if (!eco && !wf) return undefined;
  return { ...eco, ...wf };
}

/**
 * The within-family variant the family graphs' `effectiveEcosystem` computeds
 * use at parse time: accept the switch only when the current workflow survives
 * it (a family graph cannot change the workflow mid-parse).
 */
export function effectiveEcosystemOf(
  model: { id?: number; baseModel?: string } | undefined,
  ecosystem: string,
  workflow: string
): string {
  const corrected = deriveSelectorsFromModel(model, { ecosystem, workflow });
  return corrected?.ecosystem && !corrected.workflow ? corrected.ecosystem : ecosystem;
}

/**
 * The store-side adapter: attach with `.effect(modelSelectorRules)` on a hub
 * that owns `ecosystem`. Fires when a patch sets `model`, reads the effective
 * selectors, and adds the same correction the parse boundary would apply — so
 * an interactive pick and a stored draft reconcile identically.
 */
export const modelSelectorRules = {
  model: (
    value: unknown,
    { next }: { next: { ecosystem?: string; workflow?: string } }
  ): SelectorCorrection | undefined => {
    const model = looseModel(value);
    const current = { ecosystem: next.ecosystem, workflow: next.workflow };
    const base = deriveCorrectionsFromModel(model, current);
    const flux = fluxDraftWorkflowFor(model, {
      ecosystem: base?.ecosystem ?? current.ecosystem,
      workflow: base?.workflow ?? current.workflow,
    });
    if (!base && !flux) return undefined;
    return { ...base, ...flux };
  },
};

// flux.graph.ts's fluxVersionIds — inlined, since importing the graph here would cycle.
// reconcile.test.ts pins the two copies together.
export const FLUX_DRAFT_ID = 699279;
export const FLUX_MODE_IDS = new Set([699279, 691639, 922358, 2068000, 1088507]);

/**
 * STORE LANE ONLY: picking another Flux build while in draft drags the workflow back to txt2img.
 * At the parse boundary a non-draft build in draft is forced to the draft build instead (the
 * model correct in flux.graph.ts), so this must never run in reconcileSelectors — and without it
 * that correct reverts an interactive version pick before the user sees it. The opposite
 * direction (the draft build moving the workflow into draft) is deriveWorkflowFromModel's.
 */
function fluxDraftWorkflowFor(
  model: { id?: number } | undefined,
  current: { ecosystem: string | undefined; workflow: string | undefined }
): SelectorCorrection | undefined {
  if (current.ecosystem !== 'Flux1' && current.ecosystem !== 'FluxKrea') return undefined;
  const id = model?.id;
  if (id == null || !FLUX_MODE_IDS.has(id)) return undefined;
  if (id !== FLUX_DRAFT_ID && current.workflow === DRAFT_WORKFLOW) return { workflow: 'txt2img' };
  return undefined;
}

export interface ReconcileResult {
  raw: Record<string, unknown>;
  /** The correction that was applied, when one was. */
  note?: { reason: 'model_wins' } & SelectorCorrection;
}

/**
 * number → {id}, object passthrough, anything else → undefined. The id-only
 * twin is `modelIdOf` in shared.ts — change the accepted wire shapes in BOTH.
 */
function looseModel(value: unknown): { id?: number; baseModel?: string } | undefined {
  if (typeof value === 'number') return { id: value };
  if (value && typeof value === 'object') return value as { id?: number; baseModel?: string };
  return undefined;
}

/**
 * The parse-boundary adapter: applied to the raw payload BEFORE `parse`,
 * beside `normalizeInput` in the server adapter. Never throws — an unreadable shape is a no-op and
 * the graph's own schemas deal with it.
 */
export function reconcileSelectors(raw: Record<string, unknown>): ReconcileResult {
  const model = looseModel(raw.model);
  const corrected = deriveCorrectionsFromModel(model, {
    ecosystem: typeof raw.ecosystem === 'string' ? raw.ecosystem : undefined,
    workflow: typeof raw.workflow === 'string' ? raw.workflow : undefined,
  });
  if (!corrected) return { raw };
  return {
    raw: {
      ...raw,
      ...(corrected.ecosystem ? { ecosystem: corrected.ecosystem } : {}),
      ...(corrected.workflow ? { workflow: corrected.workflow } : {}),
    },
    note: { reason: 'model_wins', ...corrected },
  };
}
