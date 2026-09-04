import { ecosystemById, ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  EXPERIMENTAL_MODE_SUPPORTED_MODELS,
  SDCPP_SUPPORTED_ECOSYSTEMS,
  SDCPP_EXCLUDED_MODEL_IDS,
  fluxUltraAirId,
} from '~/shared/constants/generation.constants';
import {
  getDefaultEcosystemForWorkflow,
  getEcosystemsForWorkflow,
  isWorkflowAvailable,
  workflowGroups,
} from '~/shared/data-graph/generation/config';
import {
  pickStrongerGate,
  rulesToStates,
  type GateItemState,
  type GateResolution,
  type GateState,
} from '~/shared/data-graph/generation/gates';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

/**
 * Copied from `ecosystem-graph.ts` (which dies with the data-graph engine at
 * the end of the migration — the port must not import from it). The
 * differential suite pins the copy against the original while both live.
 */

type EcosystemGateExt = Pick<
  GenerationCtx,
  'selfHostedDisabledEcosystems' | 'selfHostedMode' | 'gateRules' | 'flags'
>;

/**
 * Ecosystems hidden unless their feature flag is explicitly enabled — the
 * deploy gate for newer generators. Fail-closed: an absent/false flag hides
 * the ecosystem from the picker (client) and rejects it on submit (server).
 */
const FEATURE_FLAG_GATED_ECOSYSTEMS: Array<{ key: string; flag: keyof FeatureAccess }> = [
  { key: 'Tripo', flag: 'tripoGenerator' },
  { key: 'Hunyuan3D', flag: 'hunyuan3dGenerator' },
  { key: 'Pixal3D', flag: 'pixal3dGenerator' },
  { key: 'Trellis2', flag: 'trellis2Generator' },
];

/**
 * Resolve the unified gate state for the workflow's ecosystems — the
 * self-hosted toggle, the rules model, and the feature-flag deploy gate folded
 * into one per-ecosystem state via `pickStrongerGate`, split by what the
 * picker needs.
 */
export function getEcosystemStates(
  workflow: string,
  ext: EcosystemGateExt
): {
  compatibleEcosystems: string[];
  hiddenEcosystems: string[];
  ecosystemStates: GateItemState[];
} {
  const states = new Map<string, GateResolution>();
  const selfHostedState: GateState =
    ext.selfHostedMode === 'memberOnly' ? 'memberOnly' : 'disabled';
  for (const key of ext.selfHostedDisabledEcosystems ?? [])
    states.set(key, pickStrongerGate(states.get(key), { state: selfHostedState }));
  for (const [key, res] of rulesToStates(ext.gateRules ?? []).ecosystems)
    states.set(key, pickStrongerGate(states.get(key), res));

  for (const { key, flag } of FEATURE_FLAG_GATED_ECOSYSTEMS) {
    if (ext.flags?.[flag] !== true)
      states.set(key, pickStrongerGate(states.get(key), { state: 'hidden' }));
  }

  const hiddenEcosystems = [...states].filter(([, r]) => r.state === 'hidden').map(([key]) => key);
  const hiddenSet = new Set(hiddenEcosystems);
  const compatibleEcosystems = getEcosystemsForWorkflow(workflow)
    .map((id) => ecosystemById.get(id)?.key)
    .filter((key): key is string => !!key && !hiddenSet.has(key));
  const compatibleSet = new Set(compatibleEcosystems);
  const ecosystemStates = [...states]
    .filter(([key, r]) => r.state !== 'hidden' && compatibleSet.has(key))
    .map(([key, r]) => ({ key, state: r.state as 'disabled' | 'memberOnly', message: r.message }));

  return { compatibleEcosystems, hiddenEcosystems, ecosystemStates };
}

/**
 * v1's workflow→ecosystem sync effect as a pure function: an ecosystem that
 * doesn't support the workflow REDIRECTS to the workflow's configured default
 * (txt2img + WanVideo30 parses as SD1 in the oracle — probed 2026-09-01).
 * Returns the value unchanged when it's fine, when it's unknown (v1's effect
 * bails on unknown keys), or when a workflow-group override lets the family
 * handle the switch internally (wan's T2V↔I2V variants).
 */
export function resolveCompatibleEcosystem(workflow: string, value: string): string {
  const ecosystem = ecosystemByKey.get(value);
  if (!ecosystem) return value;
  if (isWorkflowAvailable(workflow, ecosystem.id)) return value;

  const group = workflowGroups.find((g) => g.workflows.includes(workflow));
  if (group) {
    const override = group.overrides?.find((o) => o.ecosystemIds.includes(ecosystem.id));
    if (override?.workflows.includes(workflow)) return value;
  }

  const defaultEcoId = getDefaultEcosystemForWorkflow(workflow);
  if (defaultEcoId) {
    const eco = ecosystemById.get(defaultEcoId);
    if (eco) return eco.key;
  }
  return 'SDXL'; // v1's ultimate fallback
}

/** Whether the ecosystem/model pair surfaces the `enhancedCompatibility` toggle. */
export function supportsEnhancedCompatibility(ecosystem: string, modelId?: number): boolean {
  return EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(ecosystem) && modelId !== fluxUltraAirId;
}

/**
 * Whether the ecosystem/model pair runs through sdcpp and qualifies for the
 * 2-for-1 quantity bonus. Superset of `supportsEnhancedCompatibility`.
 */
export function supportsSdcpp(ecosystem: string, modelId?: number): boolean {
  if (!SDCPP_SUPPORTED_ECOSYSTEMS.includes(ecosystem)) return false;
  if (modelId !== undefined && SDCPP_EXCLUDED_MODEL_IDS.includes(modelId)) return false;
  return true;
}
