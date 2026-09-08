import type { PartialResourceValue } from '~/components/generation_v2/inputs/resource-select.utils';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { GateItemState } from '~/shared/data-graph/generation/gates';
import type { ModelType } from '~/shared/utils/prisma/enums';

import { EcosystemRail, EcosystemConsequenceFooter } from './EcosystemRail';
import { resetCheckpointPicker, useCheckpointPickerStore } from './checkpoint-picker.store';

/**
 * The form's current additional resources, read from the store at click time.
 * Subscribing to the field instead would re-render the checkpoint row on every
 * strength change, and the footer is the only thing that wants this.
 */
export function readResources(store: {
  getSnapshot: () => { state: unknown };
}): PartialResourceValue[] {
  const state = store.getSnapshot().state as { resources?: PartialResourceValue[] };
  return state.resources ?? [];
}

/**
 * Opens the resource picker as the CHECKPOINT picker: catalog in the middle,
 * ecosystem rail down the left, consequence footer along the bottom.
 *
 * This is where the header's five controls end up. The rail is the old
 * `BaseModelInput` pill and the footer is `ResourceAlerts`' information moved
 * ahead of the commit; the modal itself only knows it was handed two slots.
 */
export function openCheckpointPicker({
  title,
  options,
  ecosystem,
  onSelect,
  onEcosystemChange,
  resources,
  resourceTypes,
}: {
  title?: React.ReactNode;
  options?: ResourceSelectOptions;
  ecosystem: {
    value?: string;
    compatibleEcosystems?: string[];
    excludeEcosystems?: string[];
    ecosystemStates?: GateItemState[];
    outputType?: 'image' | 'video' | 'audio' | 'model3d';
    /**
     * The graph's own answer for the CURRENT family, from the checkpoint field's
     * meta. It resolves `opts.modelLocked ?? ecosystemDefaults.modelLocked`, so
     * it catches graph-level locks (Flux on the draft workflow) that reading the
     * ecosystem constants alone cannot see.
     */
    modelLocked?: boolean;
  };
  onSelect: (resource: GenerationResource) => void;
  onEcosystemChange: (ecosystemKey: string) => void;
  /** The form's current additional resources, for the footer's drop count. */
  resources?: PartialResourceValue[];
  resourceTypes?: ModelType[];
}) {
  resetCheckpointPicker(ecosystem.value);

  const commitEcosystem = (ecosystemKey: string) => {
    // Through the store, not a closure variable: both slots subscribe to it, so
    // this is what moves the rail's highlight and the footer's copy onto the
    // family that was just committed.
    resetCheckpointPicker(ecosystemKey);
    onEcosystemChange(ecosystemKey);
  };

  /**
   * Picking a checkpoint from a pending family commits the family too, first —
   * otherwise the form keeps the old ecosystem while holding a model that
   * belongs to a different one. Ecosystem before model so the model write is
   * the one that survives the graph's reconciliation.
   */
  const commitSelection = (resource: Parameters<typeof onSelect>[0]) => {
    const { pendingEcosystem, committedEcosystem } = useCheckpointPickerStore.getState();
    if (pendingEcosystem && pendingEcosystem !== committedEcosystem)
      onEcosystemChange(pendingEcosystem);
    resetCheckpointPicker(pendingEcosystem ?? committedEcosystem);
    onSelect(resource);
  };

  openResourceSelectModal({
    title,
    options,
    role: 'checkpoint',
    onSelect: commitSelection,
    onClose: () => resetCheckpointPicker(undefined),
    rail: () => (
      <EcosystemRail
        value={ecosystem.value}
        onChange={commitEcosystem}
        compatibleEcosystems={ecosystem.compatibleEcosystems}
        excludeEcosystems={ecosystem.excludeEcosystems}
        ecosystemStates={ecosystem.ecosystemStates}
        outputType={ecosystem.outputType}
        resourceTypes={resourceTypes}
        currentLocked={ecosystem.modelLocked}
      />
    ),
    footer: () => (
      <EcosystemConsequenceFooter
        value={ecosystem.value}
        onChange={commitEcosystem}
        resources={resources}
      />
    ),
  });
}
