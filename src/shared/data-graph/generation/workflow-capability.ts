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

import { generationGraph } from './generation-graph';
import { getAllVersionIds, type VersionGroup, type VersionOption } from './common';
import type { GenerationCtx } from './context';

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
        | { versions?: VersionGroup; defaultModelId?: number }
        | undefined;
      capability = {
        versions: modelMeta?.versions,
        defaultModelId: modelMeta?.defaultModelId,
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
 * upload) is deliberately left alone. That mirrors the graph's own
 * `buildModelTransform`, which skips ids it doesn't know — so this never
 * rejects something the graph would have honoured as-is.
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
  const sourceOptions = versionOptionList(getWorkflowCapability(ecosystem, offeredFor[0])?.versions);
  const targetOptions = versionOptionList(target?.versions);
  const index = sourceOptions.findIndex((o) => o.value === versionId);
  const suggestedVersionId =
    (index >= 0 ? targetOptions[index]?.value : undefined) ?? target?.defaultModelId;

  return { kind: 'wrong-workflow', offeredFor, suggestedVersionId };
}
