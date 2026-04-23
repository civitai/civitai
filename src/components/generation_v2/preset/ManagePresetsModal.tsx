import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconPencil,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { isEqual } from 'lodash-es';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { useGenerationPresetStore } from '~/store/generation-preset.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type EditState = { id: number; name: string; description: string } | null;

/**
 * Reconcile local ordering against the server snapshot. Preserves the user's
 * in-flight reorder for IDs that still exist; appends newly-created presets
 * to the end; drops deleted presets.
 */
function reconcileOrder(localOrder: number[], serverOrder: number[]): number[] {
  const serverSet = new Set(serverOrder);
  const localSet = new Set(localOrder);
  const kept = localOrder.filter((id) => serverSet.has(id));
  const added = serverOrder.filter((id) => !localSet.has(id));
  return [...kept, ...added];
}

export function ManagePresetsModal() {
  const dialog = useDialogContext();
  const [edit, setEdit] = useState<EditState>(null);
  const [localOrder, setLocalOrder] = useState<number[]>([]);

  const utils = trpc.useUtils();
  const presetsQuery = trpc.generationPreset.getOwn.useQuery();

  const presets = useMemo(() => presetsQuery.data ?? [], [presetsQuery.data]);
  const byId = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  const serverOrder = useMemo(() => presets.map((p) => p.id), [presets]);

  // Keep local order in sync with the server: preserve pending reorders for
  // existing ids, absorb additions/deletions.
  useEffect(() => {
    setLocalOrder((prev) => {
      const next = reconcileOrder(prev, serverOrder);
      return isEqual(prev, next) ? prev : next;
    });
  }, [serverOrder]);

  const orderChanged = useMemo(
    () => !isEqual(localOrder, serverOrder),
    [localOrder, serverOrder]
  );

  const updatePreset = trpc.generationPreset.update.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Preset updated' });
      await utils.generationPreset.getOwn.invalidate();
      await utils.generationPreset.getForEcosystem.invalidate();
      setEdit(null);
    },
    onError: (err) =>
      showErrorNotification({ title: 'Update failed', error: new Error(err.message) }),
  });
  const deletePreset = trpc.generationPreset.delete.useMutation({
    onSuccess: async (_data, vars) => {
      showSuccessNotification({ message: 'Preset deleted' });
      await utils.generationPreset.getOwn.invalidate();
      await utils.generationPreset.getForEcosystem.invalidate();
      // If we just deleted the active preset, clear it locally.
      const { activePresetId, closePreset } = useGenerationPresetStore.getState();
      if (activePresetId === vars.id) closePreset();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Delete failed', error: new Error(err.message) }),
  });
  const reorderPresets = trpc.generationPreset.reorder.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Preset order saved' });
      await utils.generationPreset.getOwn.invalidate();
      await utils.generationPreset.getForEcosystem.invalidate();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Reorder failed', error: new Error(err.message) }),
  });

  const move = (idx: number, direction: -1 | 1) => {
    const target = idx + direction;
    if (target < 0 || target >= localOrder.length) return;
    setLocalOrder((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const saveOrder = () => reorderPresets.mutate({ orderedIds: localOrder });
  const discardOrder = () => setLocalOrder(serverOrder);

  const submitEdit = () => {
    if (!edit) return;
    const name = edit.name.trim();
    if (!name) return;
    updatePreset.mutate({
      id: edit.id,
      name,
      description: edit.description.trim() || null,
    });
  };

  const orderedPresets = useMemo(
    () => localOrder.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p),
    [localOrder, byId]
  );

  return (
    <Modal
      opened={dialog.opened}
      onClose={dialog.onClose}
      title="Manage presets"
      size="md"
      zIndex={dialog.zIndex}
    >
      <Stack gap="sm">
        {presetsQuery.isLoading ? (
          <Group justify="center" py="lg">
            <Loader />
          </Group>
        ) : orderedPresets.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            You haven&apos;t saved any presets yet.
          </Text>
        ) : (
          <Stack gap="xs">
            {orderedPresets.map((preset, idx) => {
              const isEditing = edit?.id === preset.id;
              return (
                <div
                  key={preset.id}
                  className="flex flex-col gap-2 rounded border border-gray-3 p-2 dark:border-dark-4"
                >
                  {isEditing ? (
                    <Stack gap="xs">
                      <TextInput
                        label="Name"
                        value={edit.name}
                        onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })}
                        maxLength={100}
                        required
                      />
                      <Textarea
                        label="Description"
                        value={edit.description}
                        onChange={(e) => setEdit({ ...edit, description: e.currentTarget.value })}
                        maxLength={500}
                        autosize
                        minRows={2}
                        maxRows={4}
                      />
                      <Group justify="flex-end" gap="xs">
                        <Button
                          variant="default"
                          size="compact-sm"
                          leftSection={<IconX size={14} />}
                          onClick={() => setEdit(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="compact-sm"
                          leftSection={<IconCheck size={14} />}
                          onClick={submitEdit}
                          loading={updatePreset.isLoading}
                          disabled={!edit.name.trim()}
                        >
                          Save
                        </Button>
                      </Group>
                    </Stack>
                  ) : (
                    <Group justify="space-between" wrap="nowrap" align="center">
                      <div className="min-w-0 flex-1">
                        <Text size="sm" fw={500} lineClamp={1}>
                          {preset.name}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {preset.ecosystem}
                          {preset.description ? ` · ${preset.description}` : ''}
                        </Text>
                      </div>
                      <Group gap={4} wrap="nowrap">
                        <Tooltip label="Move up" withArrow>
                          <ActionIcon
                            variant="subtle"
                            size="sm"
                            disabled={idx === 0}
                            onClick={() => move(idx, -1)}
                          >
                            <IconArrowUp size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Move down" withArrow>
                          <ActionIcon
                            variant="subtle"
                            size="sm"
                            disabled={idx === orderedPresets.length - 1}
                            onClick={() => move(idx, 1)}
                          >
                            <IconArrowDown size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Edit" withArrow>
                          <ActionIcon
                            variant="subtle"
                            size="sm"
                            onClick={() =>
                              setEdit({
                                id: preset.id,
                                name: preset.name,
                                description: preset.description ?? '',
                              })
                            }
                          >
                            <IconPencil size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <PopConfirm
                          message={`Delete "${preset.name}"?`}
                          onConfirm={() => deletePreset.mutate({ id: preset.id })}
                          confirmButtonColor="red"
                          withinPortal
                          position="bottom-end"
                        >
                          <Tooltip label="Delete" withArrow>
                            <ActionIcon variant="subtle" size="sm" color="red">
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </PopConfirm>
                      </Group>
                    </Group>
                  )}
                </div>
              );
            })}
          </Stack>
        )}

        {orderChanged && (
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              size="compact-sm"
              leftSection={<IconX size={14} />}
              onClick={discardOrder}
              disabled={reorderPresets.isLoading}
            >
              Discard order changes
            </Button>
            <Button
              size="compact-sm"
              leftSection={<IconCheck size={14} />}
              onClick={saveOrder}
              loading={reorderPresets.isLoading}
            >
              Save order
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
