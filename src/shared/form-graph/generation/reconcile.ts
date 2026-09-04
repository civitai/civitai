import { ecosystemByKey, getEcosystemDefaults } from '~/shared/constants/basemodel.constants';
import {
  getWorkflowsForEcosystem,
  isWorkflowAvailable,
} from '~/shared/data-graph/generation/config';
import { ecosystemKeyForBaseModel } from './checkpoint';
import { booguVersionIds } from './image/boogu.graph';
import { viduVersionIds } from '~/shared/data-graph/generation/version-ids';

/**
 * Selector reconciliation: v1's cross-level effects — a model whose baseModel
 * belongs to another ecosystem drags `ecosystem` (and, when that ecosystem
 * doesn't support the current workflow, `workflow`) with it. In v1 this runs
 * as checkpoint effects DURING resolution; here it is ONE pure policy with two
 * adapters — a raw→raw normalizer applied before `parse` at the server
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
 * The policy: v1's checkpoint effect as a pure function. Returns the selector
 * rewrite a cross-ecosystem model implies, or undefined when nothing moves.
 * The workflow fallback mirrors v1 exactly: the target ecosystem's FIRST
 * configured workflow, unfiltered.
 */
export function deriveSelectorsFromModel(
  model: { id?: number; baseModel?: string } | undefined,
  current: { ecosystem: string | undefined; workflow: string | undefined }
): SelectorCorrection | undefined {
  const modelEco = model?.baseModel ? ecosystemKeyForBaseModel(model.baseModel) : undefined;
  if (!modelEco || modelEco === current.ecosystem) return undefined;

  // A LOCKED model slot beats a cross-FAMILY model: v1's input substitution
  // replaces it with the locked default before its effect could see it, so no
  // switch happens there. Version SIBLINGS (LTXV23 on LTXV2, wan on wan) are
  // valid entries in the locked picker's own version list, so they re-pick the
  // version branch — the lock does not apply. modelLocked comes from ecosystem
  // defaults, plus the one workflow-driven lock (flux draft).
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
  if (compatibleWorkflows.length === 0) return undefined; // v1: don't switch
  return { ecosystem: modelEco, workflow: compatibleWorkflows[0].id };
}

/** Ecosystems that are versions of one picker family collapse to one key. */
function familyOf(ecosystem: string): string {
  if (ecosystem.startsWith('LTX')) return 'LTX';
  if (ecosystem.startsWith('WanVideo')) return 'WanVideo';
  if (ecosystem === 'Flux1' || ecosystem === 'FluxKrea') return 'Flux';
  return ecosystem;
}

function isModelLocked(ecosystem: string, workflow: string | undefined): boolean {
  if ((ecosystem === 'Flux1' || ecosystem === 'FluxKrea') && workflow === 'txt2img:draft')
    return true;
  const eco = ecosystemByKey.get(ecosystem);
  if (!eco) return false;
  return getEcosystemDefaults(eco.id)?.modelLocked ?? false;
}

/**
 * Families whose version picker is WORKFLOW-scoped: a known version id that
 * belongs to another workflow's list drags the workflow with it (v1's
 * workflowVersions effect — probed on Boogu: an edit checkpoint on txt2img
 * parses as img2img:edit with the model kept).
 */
const workflowScopedVersions: Record<string, Record<string, ReadonlySet<number>>> = {
  Boogu: {
    txt2img: new Set([booguVersionIds.base, booguVersionIds.turbo]),
    'img2img:edit': new Set([booguVersionIds.edit, booguVersionIds.editTurbo]),
  },
  // MageFlow shares the workflowVersions machinery but the oracle REMAPS its
  // model into the current workflow (index-equivalent) instead of following it
  // — probed; the remap is a `correct` in mage-flow.graph.ts.
};

export function deriveWorkflowFromModel(
  model: { id?: number } | undefined,
  current: { ecosystem: string | undefined; workflow: string | undefined }
): SelectorCorrection | undefined {
  const id = model?.id;
  // Vidu Q3 has no reference-to-video operation: v1's effect drops the
  // workflow back to plain img2vid when the Q3 build is picked (probed)
  if (
    current.ecosystem === 'Vidu' &&
    id === viduVersionIds.q3 &&
    current.workflow === 'img2vid:ref2vid'
  ) {
    return { workflow: 'img2vid' };
  }
  const table = current.ecosystem ? workflowScopedVersions[current.ecosystem] : undefined;
  if (!table || id == null) return undefined;
  const workflow = current.workflow ?? 'txt2img';
  const keys = Object.keys(table);
  // prefix matching, as v1's findWorkflowConfig does
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
  ): SelectorCorrection | undefined =>
    deriveCorrectionsFromModel(looseModel(value), {
      ecosystem: next.ecosystem,
      workflow: next.workflow,
    }),
};

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
 * beside `normalizeInput` in the server adapter (and by the differential
 * harness's port wrapper). Never throws — an unreadable shape is a no-op and
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
