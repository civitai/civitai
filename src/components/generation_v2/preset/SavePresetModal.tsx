import { useState } from 'react';
import { Button, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { PresetValues } from '~/store/generation-preset.store';
import { useGenerationPresetStore } from '~/store/generation-preset.store';

export function SavePresetModal() {
  const dialog = useDialogContext();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const createPreset = trpc.generationPreset.create.useMutation({
    onSuccess: async (preset) => {
      showSuccessNotification({ title: 'Preset saved', message: `Saved "${preset.name}"` });
      await utils.generationPreset.getForEcosystem.invalidate();
      await utils.generationPreset.getOwn.invalidate();
      // Baseline = the live snapshot we just persisted. The server echoes back
      // what we sent, so these are equivalent — using `preset.values` keeps us
      // aligned with whatever the server ultimately stored.
      useGenerationPresetStore.getState().loadPreset({
        id: preset.id,
        name: preset.name,
        userId: preset.userId,
        values: preset.values as PresetValues,
      });
      dialog.onClose();
    },
    onError: (err) => {
      // Duplicate name → show inline under the Name input.
      if (err.data?.code === 'CONFLICT') {
        setNameError(err.message);
        return;
      }
      showErrorNotification({
        title: 'Failed to save preset',
        error: new Error(err.message),
      });
    },
  });

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Clear any stale duplicate-name error from a previous attempt.
    setNameError(null);
    // Capture the snapshot at save-click time, not at modal-open time, so the
    // baseline matches the current form state even if the user tweaked things
    // while the modal was open.
    const getFilteredSnapshot = useGenerationPresetStore.getState().bridge.getFilteredSnapshot;
    const values = getFilteredSnapshot?.();
    if (!values || typeof values.ecosystem !== 'string' || !values.ecosystem) {
      showErrorNotification({
        title: 'Cannot save preset',
        error: new Error('No ecosystem selected in the generation form.'),
      });
      return;
    }
    createPreset.mutate({
      name: trimmed,
      description: description.trim() ? description.trim() : undefined,
      values,
    });
  };

  return (
    <Modal
      onClose={dialog.onClose}
      opened={dialog.opened}
      title="Save preset"
      size="sm"
      zIndex={dialog.zIndex}
    >
      <Stack>
        <TextInput
          label="Name"
          placeholder="My preset"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            if (nameError) setNameError(null);
          }}
          maxLength={100}
          data-autofocus
          required
          error={nameError}
        />
        <Textarea
          label="Description"
          placeholder="Optional description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          maxLength={500}
          autosize
          minRows={2}
          maxRows={4}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={createPreset.isLoading} disabled={!name.trim()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
