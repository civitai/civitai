/**
 * Workflow capability probes — read REAL generation-graph config for a given
 * (ecosystem, workflow) pair instead of re-declaring it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several per-ecosystem facts a caller outside the generation form needs are
 * declared ONLY inside the per-ecosystem graph files, never in a central table:
 *
 *   • WORKFLOW-SCOPED CHECKPOINT VERSIONS — Qwen / Boogu / MageFlow offer a
 *     DIFFERENT set of checkpoint versions per workflow (`createCheckpointGraph
 *     ({ workflowVersions })`). e.g. Qwen `img2img:edit` offers v2509/v2511 and
 *     `txt2img` offers v2509/v2512 — DISJOINT id sets on the same model.
 *
 * A caller that hardcodes a copy of any of this drifts the moment a graph file
 * changes (a new ecosystem, a new version, a raised limit). So instead of a
 * parallel table, this module INSTANTIATES the real `generationGraph` for the
 * (ecosystem, workflow) pair and reads the node meta the form itself renders
 * from — the single source of truth, by construction.
 *
 * NEUTRAL PROBE CONTEXT: the probe runs with a fixed, free-tier-shaped
 * `GenerationCtx` carrying NO gate rules. That is deliberate — this answers
 * "what does the CONFIG allow for this ecosystem?", not "what may THIS user
 * generate?". Per-user entitlement/gating still runs downstream in
 * `createWorkflowStepsFromGraphInput`. Using an empty `gateRules` means a gated
 * version stays VISIBLE to the probe, so this can only ever fail OPEN (defer to
 * the downstream gate) — never reject something the real gate would have
 * allowed.
 *
 * COST: `clone() + init()` measured at ~1.4 ms. Results are memoized per
 * `${ecosystem}|${workflow}` — the underlying config is static per process — so
 * a hot path pays it at most once per pair.
 */

import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { generationGraph } from './generation-graph';
import { getAllVersionIds, type VersionGroup, type VersionOption } from './common';
import { getWorkflowsForEcosystem } from './config/workflows';
import type { GenerationCtx } from './context';
import type { ModelSubstitutionEvent, ModelSubstitutionReason } from './model-substitution';

/**
 * Fixed capability-probe context. NOT a user's context — see the module note.
 * `limits` are only read by quantity/resource nodes, which this module never
 * inspects; `gateRules: []` keeps every version visible so the probe fails open.
 */
const PROBE_CTX: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: false, tier: 'free' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
};

export type WorkflowCapability = {
  /**
   * The checkpoint-version selector this (ecosystem, workflow) offers, or
   * `undefined` when the ecosystem has no workflow-scoped version list (most
   * ecosystems — e.g. SD-family, Grok — where any published checkpoint of the
   * ecosystem is fair game).
   */
  versions: VersionGroup | undefined;
  /** The version this (ecosystem, workflow) defaults to, when it has one. */
  defaultModelId: number | undefined;
  /**
   * Whether this (ecosystem, workflow) LOCKS the checkpoint — i.e. whether the
   * `checkpointInputSchema` clamp in `common.ts` will silently rewrite an
   * out-of-list version id to `defaultModelId` (issue #3520). Read from the same
   * `model` node meta the form renders, so a caller enumerating "which
   * ecosystems substitute?" derives it from the real config instead of keeping a
   * hand-maintained list that goes stale the moment a new ecosystem ships.
   */
  modelLocked: boolean;
};

const capabilityCache = new Map<string, WorkflowCapability | undefined>();

/**
 * Probe the real generation graph for one (ecosystem, workflow) pair.
 *
 * Returns `undefined` when the pair is not a coherent combination — the graph's
 * own effects re-route an incompatible (ecosystem, workflow) to something it
 * DOES support, so we verify the instantiated context still holds the pair we
 * asked about and otherwise report "no opinion" rather than reading meta that
 * describes a different route.
 */
export function getWorkflowCapability(
  ecosystem: string,
  workflow: string
): WorkflowCapability | undefined {
  const cacheKey = `${ecosystem}|${workflow}`;
  if (capabilityCache.has(cacheKey)) return capabilityCache.get(cacheKey);

  let capability: WorkflowCapability | undefined;
  try {
    const clone = generationGraph.clone();
    clone.init({ workflow, ecosystem } as never, PROBE_CTX, { skipStorage: true });
    const ctx = clone.ctx as { workflow?: string; ecosystem?: string };
    if (ctx.workflow === workflow && ctx.ecosystem === ecosystem) {
      const modelMeta = clone.getNodeMeta('model' as never) as
        | { versions?: VersionGroup; defaultModelId?: number; modelLocked?: boolean }
        | undefined;
      capability = {
        versions: modelMeta?.versions,
        defaultModelId: modelMeta?.defaultModelId,
        modelLocked: !!modelMeta?.modelLocked,
      };
    }
  } catch {
    // A probe failure must never break a caller — report "no opinion" and let
    // the real graph validation downstream be the authority.
    capability = undefined;
  }

  capabilityCache.set(cacheKey, capability);
  return capability;
}

/** Flat list of the version options this (ecosystem, workflow) offers. */
function versionOptionList(group: VersionGroup | undefined): VersionOption[] {
  if (!group) return [];
  const out: VersionOption[] = [];
  const walk = (g: VersionGroup) => {
    for (const opt of g.options) {
      out.push(opt);
      if (opt.children) walk(opt.children);
    }
  };
  walk(group);
  return out;
}

export type VersionWorkflowScope =
  /** The ecosystem does not scope versions by workflow, or this version is not one of the scoped versions — no constraint to apply. */
  | { kind: 'unscoped' }
  /** The version IS offered for the target workflow. */
  | { kind: 'supported' }
  /**
   * The version is a workflow-scoped version of this ecosystem, but is offered
   * for a DIFFERENT workflow than the target.
   */
  | {
      kind: 'wrong-workflow';
      /** The workflow(s) this version IS offered for, e.g. `['img2img:edit']`. */
      offeredFor: string[];
      /**
       * The version to use instead if the caller really wants `workflow` — the
       * same-position sibling in the target workflow's list (the mapping the
       * graph itself uses in `buildVersionMappings`), falling back to the
       * target's default version.
       */
      suggestedVersionId: number | undefined;
    };

/**
 * Decide whether `versionId` is a legitimate checkpoint for `workflow` on
 * `ecosystem`, given the ecosystem's WORKFLOW-SCOPED version lists.
 *
 * `candidateWorkflows` bounds which other workflows are considered — pass the
 * set the caller could legitimately have routed to (for the App Blocks image
 * bridge: txt2img / img2img / img2img:edit).
 *
 * The `unscoped` verdict is the important one for safety: a version that is not
 * in ANY of the ecosystem's scoped lists (a community checkpoint, a brand-new
 * upload) is deliberately left alone, so this can only ever reject a version
 * whose intended workflow the config states outright.
 *
 * That is a fail-open CHOICE, not a claim that such an id is safe. On a
 * `modelLocked` ecosystem the graph does NOT honour an unknown id as-is: the
 * `checkpointInputSchema` clamp in `common.ts` rewrites it to the workflow's
 * `defaultModelId` and returns success (verified — `model: { id: 987654321 }`
 * on Qwen/txt2img comes back as 2552908). Only NON-`modelLocked` ecosystems
 * (Boogu, SDXL, Flux1, …) pass an unknown id through untouched. Rejecting the
 * unknown-id case here would refuse ids the graph is willing to run, so it is
 * left to the broader fix tracked in #3520.
 */
export function resolveVersionWorkflowScope(opts: {
  ecosystem: string;
  workflow: string;
  candidateWorkflows: readonly string[];
  versionId: number;
}): VersionWorkflowScope {
  const { ecosystem, workflow, candidateWorkflows, versionId } = opts;

  const target = getWorkflowCapability(ecosystem, workflow);
  const targetIds = target?.versions ? getAllVersionIds(target.versions) : undefined;
  if (targetIds?.has(versionId)) return { kind: 'supported' };

  // Which OTHER candidate workflows offer this version?
  const offeredFor: string[] = [];
  for (const candidate of candidateWorkflows) {
    if (candidate === workflow) continue;
    const cap = getWorkflowCapability(ecosystem, candidate);
    if (!cap?.versions) continue;
    if (getAllVersionIds(cap.versions).has(versionId)) offeredFor.push(candidate);
  }

  // Not a scoped version of this ecosystem at all → no constraint.
  if (!offeredFor.length) return { kind: 'unscoped' };

  // The target workflow has no version list of its own, so it imposes no
  // constraint even though a sibling workflow lists this version.
  if (!targetIds) return { kind: 'unscoped' };

  // Same-position sibling in the target workflow's list — the exact mapping
  // `buildVersionMappings` applies when the form switches workflow. Falls back
  // to the target workflow's default version.
  const sourceOptions = versionOptionList(
    getWorkflowCapability(ecosystem, offeredFor[0])?.versions
  );
  const targetOptions = versionOptionList(target?.versions);
  const index = sourceOptions.findIndex((o) => o.value === versionId);
  const suggestedVersionId =
    (index >= 0 ? targetOptions[index]?.value : undefined) ?? target?.defaultModelId;

  return { kind: 'wrong-workflow', offeredFor, suggestedVersionId };
}

/**
 * Classify ONE silent checkpoint substitution (issue #3520, phase 1) into the
 * reason recorded on `BlockWorkflowSnapshot` and used as the sole prom label of
 * `civitai_generation_model_substitutions_total`.
 *
 * 🔴 REUSES `resolveVersionWorkflowScope` — it is deliberately NOT a second,
 * parallel notion of "does this version belong to this workflow". That function
 * already answers the question direction-agnostically, and the only reason the
 * txt2img-direction guard in `blocks/workflow.service.ts` looks narrower is that
 * it chooses to ACT on one verdict; the resolver itself never was. Generalising
 * its use (any workflow, either direction) is the point of this call site.
 *
 * `candidateWorkflows` is EVERY workflow the ecosystem offers, not the App
 * Blocks image subset — this runs on all server-side graph validations
 * (on-site submit and bridge alike), so bounding it to the bridge's three
 * workflows would misclassify a real `wrong-workflow` case as `unrecognized`
 * the moment an ecosystem scopes versions across some other pair of workflows.
 *
 * The `supported` verdict maps to `gated`, and that mapping is the whole reason
 * the third reason exists. The clamp tests `val.id` against `validVersionIds`,
 * which is the GATE-FILTERED visible list; this resolver probes with an EMPTY
 * `gateRules` (see PROBE_CTX). So "the config offers this version for this
 * workflow, yet the clamp still replaced it" can only mean a gate rule
 * applicable to this user hid it. Folding that into `unrecognized` would label
 * an entitlement decision as a retired/unknown model.
 *
 * Never throws: `resolveVersionWorkflowScope` is probe-guarded internally, and
 * an unknown ecosystem key simply yields no candidates (→ `unrecognized`), which
 * is the honest verdict when the config has no opinion.
 */
export function classifyModelSubstitutionReason(
  event: ModelSubstitutionEvent
): ModelSubstitutionReason {
  const ecosystem = ecosystemByKey.get(event.ecosystem);
  const candidateWorkflows = ecosystem
    ? getWorkflowsForEcosystem(ecosystem.id).map((w) => w.graphKey)
    : [];

  const scope = resolveVersionWorkflowScope({
    ecosystem: event.ecosystem,
    workflow: event.workflow,
    candidateWorkflows,
    versionId: event.requested,
  });

  if (scope.kind === 'wrong-workflow') return 'wrong-workflow';
  if (scope.kind === 'supported') return 'gated';
  return 'unrecognized';
}
