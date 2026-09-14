/**
 * The `disabled` gates on the current selection.
 *
 * `disabled` leaves a MODEL VERSION in the pickers so the form can say why
 * generation is blocked instead of the choice vanishing; a disabled ecosystem or
 * workflow is still rejected by its node's output refine. Drives the body alert
 * and gates the whatIf query. The server's refusal is `gatedSelectionRefusal`.
 *
 * Rules come from the store, not the config query — see `experimental-rules.store`.
 */

import { useMemo } from 'react';

import {
  disabledSelectionGates,
  type GateSelection,
  type SelectionGate,
} from '~/shared/data-graph/generation/gates';
import { useExperimentalRulesStore } from '~/store/experimental-rules.store';

/** The generation form's selection fields, as every lane's snapshot carries them. */
export type GateSelectionValues = {
  ecosystem?: unknown;
  workflow?: unknown;
  model?: unknown;
  resources?: unknown;
  vae?: unknown;
};

const hasId = (value: unknown): value is { id: number } =>
  value !== null &&
  typeof value === 'object' &&
  'id' in value &&
  typeof (value as { id: unknown }).id === 'number';

export function gateSelectionFrom(values: GateSelectionValues | undefined): GateSelection {
  const { ecosystem, workflow, model, resources, vae } = values ?? {};
  return {
    ecosystem: typeof ecosystem === 'string' ? ecosystem : undefined,
    workflow: typeof workflow === 'string' ? workflow : undefined,
    versionIds: [model, ...(Array.isArray(resources) ? resources : []), vae]
      .filter(hasId)
      .map((r) => r.id),
  };
}

export function useDisabledGates(values: GateSelectionValues | undefined): SelectionGate[] {
  const rules = useExperimentalRulesStore((state) => state.rules);
  const selection = gateSelectionFrom(values);
  const fingerprint = `${selection.ecosystem ?? ''}|${selection.workflow ?? ''}|${
    selection.versionIds?.join(',') ?? ''
  }`;

  return useMemo(
    () => disabledSelectionGates(rules, selection),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection is rebuilt each render; compare by value
    [rules, fingerprint]
  );
}
