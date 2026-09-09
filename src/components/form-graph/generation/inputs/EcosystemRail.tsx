import { Button, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';

import {
  BaseModelListContent,
  useBaseModelPickerState,
} from '~/components/generation_v2/inputs/BaseModelInput';
import { getResourceCompatibility } from '~/components/generation_v2/inputs/ResourceItemContent';
import type { PartialResourceValue } from '~/components/generation_v2/inputs/resource-select.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PickerRail } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal/PickerRail';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { getResourceSelectOptions } from '~/shared/form-graph/generation/defs';
import type { GateItemState } from '~/shared/data-graph/generation/gates';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { useCheckpointPickerStore } from './checkpoint-picker.store';

/**
 * The ecosystem control, relocated from the form header into the checkpoint
 * picker. Selecting here is a PENDING choice: it re-aims the catalog beside it
 * so you can see what the family actually offers, and only commits when you
 * pick a checkpoint or press Use — which is what makes the cost of switching
 * visible at the moment of switching rather than after it.
 *
 * The list itself is `BaseModelListContent` driven by `useBaseModelPickerState`,
 * the same pair the old header pill used.
 */

export type EcosystemRailProps = {
  value?: string;
  onChange: (ecosystemKey: string) => void;
  compatibleEcosystems?: string[];
  excludeEcosystems?: string[];
  ecosystemStates?: GateItemState[];
  outputType?: 'image' | 'video' | 'audio' | 'model3d';
  /** The form's current resources, to count what a switch would drop. */
  resources?: PartialResourceValue[];
  /** Resource types the catalog is browsing — the pending options are built for these. */
  resourceTypes?: ModelType[];
};

/**
 * Pending and committed ecosystem, both from the store.
 *
 * `value` is only the OPEN-TIME family — the modal's props are captured once,
 * so it does not follow a commit. `committed` is what the form actually has,
 * and is what the rail highlights and the footer describes.
 */
function usePendingEcosystem({
  value,
  resourceTypes = ['Checkpoint'] as ModelType[],
}: {
  value?: string;
  resourceTypes?: ModelType[];
}) {
  const { setOptionsOverride } = useResourceSelectContext();
  const pending = useCheckpointPickerStore((state) => state.pendingEcosystem);
  const committed = useCheckpointPickerStore((state) => state.committedEcosystem) ?? value;
  const setPending = useCheckpointPickerStore((state) => state.setPendingEcosystem);

  function select(ecosystemKey: string) {
    if (ecosystemKey === committed) {
      setPending(undefined);
      setOptionsOverride(null);
      return;
    }
    setPending(ecosystemKey);
    setOptionsOverride({
      canGenerate: true,
      resources: getResourceSelectOptions(ecosystemKey, resourceTypes).map((r) => ({
        ...r,
        partialSupport: [],
      })),
    });
  }

  return { pending, committed, select };
}

export function EcosystemRail({
  value,
  compatibleEcosystems,
  excludeEcosystems,
  ecosystemStates,
  outputType,
  resourceTypes,
}: EcosystemRailProps) {
  const [searchValue, setSearchValue] = useState('');
  const { pending, committed, select } = usePendingEcosystem({ value, resourceTypes });

  const picker = useBaseModelPickerState({
    value: pending ?? committed,
    onChange: select,
    compatibleEcosystems,
    excludeEcosystems,
    ecosystemStates,
    outputType,
    onSelected: () => setSearchValue(''),
  });

  return (
    <PickerRail>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        Ecosystem
      </Text>
      <BaseModelListContent
        value={pending ?? committed}
        recentItems={picker.recentItems}
        groupedByFamily={picker.groupedByFamily}
        allGroupedByFamily={picker.allGroupedByFamily}
        onSelect={picker.handleSelect}
        disabledStateMap={picker.disabledStateMap}
        hasIncompatibleItems={picker.hasIncompatibleItems}
        activeTab={picker.activeTab}
        onTabChange={picker.handleTabChange}
        showRecentTab={picker.showRecentTab}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
      />
    </PickerRail>
  );
}

/**
 * The consequence footer: what switching family costs, counted against the
 * resources actually in the form, while the choice is still cancellable.
 */
export function EcosystemConsequenceFooter({
  value,
  onChange,
  resources = [],
}: Pick<EcosystemRailProps, 'value' | 'onChange' | 'resources'>) {
  // The footer only reads the keys; the catalog aiming that `resourceTypes`
  // drives is the rail's job.
  const { pending, committed } = usePendingEcosystem({ value });
  const dialog = useDialogContext();

  const currentName = committed
    ? ecosystemByKey.get(committed)?.displayName ?? committed
    : undefined;
  const switching = !!pending && pending !== committed;
  const pendingName = pending ? ecosystemByKey.get(pending)?.displayName ?? pending : undefined;

  // Counted one resource at a time against the pending family, not guessed from
  // the family name — a generic "some resources may be removed" is what this
  // footer exists to replace.
  const dropped = switching
    ? (() => {
        const pendingOptions = {
          resources: getResourceSelectOptions(pending, ['LORA', 'VAE'] as ModelType[]),
        };
        return resources.filter((resource) => {
          const baseModel = (resource as { baseModel?: string }).baseModel;
          const type = (resource as { model?: { type?: string } }).model?.type;
          if (!baseModel || !type) return false;
          return getResourceCompatibility(baseModel, type, pendingOptions) === null;
        }).length;
      })()
    : 0;

  return (
    <div className="flex flex-wrap items-center gap-3 p-3">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {!switching ? (
          <>
            <IconInfoCircle size={16} className="mt-0.5 shrink-0 text-gray-6" />
            <Text size="sm" c="dimmed">
              {currentName ? (
                <>
                  Currently browsing <b>{currentName}</b> — your resources and tuning carry over
                  unchanged.
                </>
              ) : (
                'Pick a checkpoint to continue.'
              )}
            </Text>
          </>
        ) : (
          <>
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-yellow-6" />
            <Text size="sm">
              Switching {currentName} → <b>{pendingName}</b>
              {/* Say nothing about resources when the form holds none — a form
                  with no resource field would otherwise read "keeps your 0
                  resources", which is the reassuring branch stating a fact it
                  never checked. */}
              {resources.length > 0 &&
                (dropped > 0 ? (
                  <>
                    {' '}
                    drops <b>{dropped}</b> of your {resources.length}{' '}
                    {resources.length === 1 ? 'resource' : 'resources'}, and
                  </>
                ) : (
                  <>
                    {' '}
                    keeps your {resources.length}{' '}
                    {resources.length === 1 ? 'resource' : 'resources'}, and
                  </>
                ))}{' '}
              resets tuning to {pendingName} defaults.
            </Text>
          </>
        )}
      </div>
      <Button variant="default" onClick={dialog.onClose} className="shrink-0">
        Cancel
      </Button>
      {switching && (
        <Button onClick={() => onChange(pending)} className="shrink-0">
          Use {pendingName}
        </Button>
      )}
    </div>
  );
}
