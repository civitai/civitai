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
} from '~/shared/generation/config';
import {
  pickStrongerGate,
  rulesToStates,
  type GateItemState,
  type GateResolution,
  type GateState,
} from '~/shared/generation/gates';
import type { GenerationCtx } from '~/shared/generation/context';

type EcosystemGateExt = Pick<
  GenerationCtx,
  'selfHostedDisabledEcosystems' | 'selfHostedMode' | 'gateRules'
>;

/**
 * Resolve the unified gate state for the workflow's ecosystems — the
 * self-hosted toggle and the rules model folded into one per-ecosystem state
 * via `pickStrongerGate`, split by what the picker needs.
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
 * The workflow→ecosystem sync, as a pure function: an ecosystem that doesn't
 * support the workflow REDIRECTS to the workflow's configured default (txt2img +
 * WanVideo30 resolves to SD1).
 * Returns the value unchanged when it's fine, when it's unknown (the sync
 * bails on unknown keys), or when a workflow-group override lets the family
 * handle the switch internally (wan's T2V↔I2V variants).
 */
export function resolveCompatibleEcosystem(
  workflow: string,
  value: string,
  usable?: readonly string[]
): string {
  const ecosystem = ecosystemByKey.get(value);
  if (!ecosystem) return value;
  if (isWorkflowAvailable(workflow, ecosystem.id)) return value;

  const group = workflowGroups.find((g) => g.workflows.includes(workflow));
  if (group) {
    const override = group.overrides?.find((o) => o.ecosystemIds.includes(ecosystem.id));
    if (override?.workflows.includes(workflow)) return value;
  }

  // `usable` is compatible-minus-gated. Without it the fallback can land on a
  // disabled ecosystem, which the output schema then refuses — turning a
  // correctable value into an error naming one the user never picked.
  const defaultEcoId = getDefaultEcosystemForWorkflow(workflow);
  if (defaultEcoId) {
    const eco = ecosystemById.get(defaultEcoId);
    if (eco && (!usable || usable.includes(eco.key))) return eco.key;
  }
  if (usable?.length) return usable[0];
  return 'SDXL'; // the ultimate fallback
}

/** Whether the ecosystem/model pair surfaces the `enhancedCompatibility` toggle. */
export function supportsEnhancedCompatibility(ecosystem: string, modelId?: number): boolean {
  return EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(ecosystem) && modelId !== fluxUltraAirId;
}

/**
 * Whether the given ecosystem/model pair qualifies for the 2-for-1 quantity bonus. Not an engine
 * test — see SDCPP_SUPPORTED_ECOSYSTEMS.
 */
export function supportsSdcpp(ecosystem: string, modelId?: number): boolean {
  if (!SDCPP_SUPPORTED_ECOSYSTEMS.includes(ecosystem)) return false;
  if (modelId !== undefined && SDCPP_EXCLUDED_MODEL_IDS.includes(modelId)) return false;
  return true;
}
