import { useMemo, useState } from 'react';
import {
  Badge,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { applyPreset } from '~/components/generation_v2/preset/applyPreset';
import { constants } from '~/server/common/constants';
import {
  ecosystemByKey,
  getEcosystemDisplayItems,
  type EcosystemDisplayItem,
} from '~/shared/constants/basemodel.constants';
import { getWorkflowsForEcosystem } from '~/shared/data-graph/generation/config/workflows';
import { useGenerationPresetStore, type PresetValues } from '~/store/generation-preset.store';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const SYSTEM_USER_ID = constants.system.user.id;

function ecosystemLabel(key: string) {
  return ecosystemByKey.get(key)?.displayName ?? key;
}

/** Returns true if the preset's ecosystem key falls under the given display item. */
function presetMatchesItem(presetEcosystemKey: string, item: EcosystemDisplayItem) {
  if (item.type === 'ecosystem') return presetEcosystemKey === item.key;
  const eco = ecosystemByKey.get(presetEcosystemKey);
  if (!eco) return false;
  return item.ecosystemIds?.includes(eco.id) ?? false;
}

/** Find the display item key (group or standalone) that the given ecosystem belongs to. */
function displayItemKeyForEcosystem(
  ecosystemKey: string,
  items: EcosystemDisplayItem[]
): string | null {
  const eco = ecosystemByKey.get(ecosystemKey);
  if (!eco) return null;
  const group = items.find(
    (item) => item.type === 'group' && item.ecosystemIds?.includes(eco.id)
  );
  if (group) return group.key;
  const standalone = items.find(
    (item) => item.type === 'ecosystem' && item.key === ecosystemKey
  );
  return standalone?.key ?? null;
}

export function PresetPickerModal() {
  const dialog = useDialogContext();
  const currentEcosystem = useGenerationPresetStore((s) => s.bridge.ecosystem);

  // Same ecosystem list BaseModelInput uses — groups and standalone ecosystems
  // that have at least one dedicated generation workflow.
  const ecosystemItems = useMemo(() => {
    const items = getEcosystemDisplayItems();
    return items.filter((item) => {
      if (item.type === 'group' && item.ecosystemIds) {
        return item.ecosystemIds.some((id) =>
          getWorkflowsForEcosystem(id).some((w) => w.ecosystemIds.includes(id))
        );
      }
      const eco = ecosystemByKey.get(item.key);
      if (!eco) return false;
      return getWorkflowsForEcosystem(eco.id).some((w) => w.ecosystemIds.includes(eco.id));
    });
  }, []);

  // Default filter: the display item that contains the user's current
  // generation-form ecosystem. Re-evaluated each time the modal mounts.
  const [selectedEcosystem, setSelectedEcosystem] = useState<string | null>(() => {
    const bridgeEcosystem = useGenerationPresetStore.getState().bridge.ecosystem;
    if (!bridgeEcosystem) return null;
    return displayItemKeyForEcosystem(bridgeEcosystem, ecosystemItems);
  });

  const selectData = useMemo(
    () => ecosystemItems.map((item) => ({ value: item.key, label: item.name })),
    [ecosystemItems]
  );

  // `getAvailable` returns the user's own presets plus curated system presets.
  // System presets sort first because the server orders by `userId asc`.
  const presetsQuery = trpc.generationPreset.getAvailable.useQuery();
  const presets = useMemo(() => presetsQuery.data ?? [], [presetsQuery.data]);

  const filteredPresets = useMemo(() => {
    if (!selectedEcosystem) return presets;
    const item = ecosystemItems.find((i) => i.key === selectedEcosystem);
    if (!item) return presets;
    return presets.filter((p) => presetMatchesItem(p.ecosystem, item));
  }, [presets, selectedEcosystem, ecosystemItems]);

  const handleLoad = (preset: {
    id: number;
    name: string;
    userId: number;
    values: PresetValues;
  }) => {
    applyPreset(preset)
      .then(() => dialog.onClose())
      .catch((err: Error) =>
        showErrorNotification({ title: 'Failed to load preset', error: err })
      );
  };

  return (
    <Modal
      opened={dialog.opened}
      onClose={dialog.onClose}
      title="Presets"
      size="md"
      zIndex={dialog.zIndex}
    >
      <Stack gap="sm">
        <Group gap="xs" align="center" wrap="nowrap">
          <Text size="sm" fw={500} className="shrink-0">
            Filter by ecosystem
          </Text>
          <Select
            placeholder="All ecosystems"
            data={selectData}
            value={selectedEcosystem}
            onChange={setSelectedEcosystem}
            searchable
            clearable
            comboboxProps={{ withinPortal: true }}
            className="flex-1"
          />
        </Group>

        {presetsQuery.isLoading ? (
          <Group justify="center" py="lg">
            <Loader />
          </Group>
        ) : filteredPresets.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            {presets.length === 0
              ? "You haven't saved any presets yet."
              : 'No presets match the selected filters.'}
          </Text>
        ) : (
          <ScrollArea.Autosize mah={400}>
            <Stack gap="xs">
              {filteredPresets.map((p) => {
                const isSystem = p.userId === SYSTEM_USER_ID;
                return (
                  <UnstyledButton
                    key={p.id}
                    onClick={() =>
                      handleLoad({
                        id: p.id,
                        name: p.name,
                        userId: p.userId,
                        values: p.values as PresetValues,
                      })
                    }
                    className="rounded border border-gray-3 px-3 py-2 hover:bg-gray-0 dark:border-dark-4 dark:hover:bg-dark-6"
                  >
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                      <div className="min-w-0 flex-1">
                        <Group gap={6} wrap="nowrap" align="center">
                          <Text size="sm" fw={500} lineClamp={1}>
                            {p.name}
                          </Text>
                          {isSystem && (
                            <Badge size="xs" color="blue" variant="filled">
                              System
                            </Badge>
                          )}
                        </Group>
                        {p.description && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {p.description}
                          </Text>
                        )}
                      </div>
                      <Badge
                        size="xs"
                        variant={p.ecosystem === currentEcosystem ? 'light' : 'outline'}
                        color={p.ecosystem === currentEcosystem ? 'blue' : 'gray'}
                      >
                        {ecosystemLabel(p.ecosystem)}
                      </Badge>
                    </Group>
                  </UnstyledButton>
                );
              })}
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Stack>
    </Modal>
  );
}
