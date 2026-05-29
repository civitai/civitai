import { Button, Group, Modal, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Edit a Model3D's basic metadata (name + description).
 *
 * v1 surface — keeps it tight. Other fields (license, tags, NSFW, etc.) get
 * editors of their own when we need them. Owner/mod gating is enforced in
 * `model3d.service.ts::upsertModel3D` (non-mods get authorization errors if
 * they try to edit someone else's row).
 */
export type Model3DEditModalProps = {
  /** Pre-fill values (current state of the Model3D). */
  model3d: {
    id: number;
    name: string;
    description: string | null;
    licenseId: number;
  };
};

export default function Model3DEditModal({ model3d }: Model3DEditModalProps) {
  const dialog = useDialogContext();
  const [name, setName] = useState(model3d.name);
  const [description, setDescription] = useState(model3d.description ?? '');
  const utils = trpc.useUtils();

  const mutate = trpc.model3d.upsert.useMutation({
    onSuccess: () => {
      showSuccessNotification({ title: 'Saved', message: 'Model details updated.' });
      utils.model3d.getById.invalidate({ id: model3d.id });
      utils.model3d.getInfinite.invalidate();
      dialog.onClose();
    },
    onError: (e) => {
      showErrorNotification({ title: 'Save failed', error: new Error(e.message) });
    },
  });

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && !mutate.isLoading;

  const handleSave = () => {
    if (!canSave) return;
    mutate.mutate({
      id: model3d.id,
      name: trimmedName,
      description: description.trim() || null,
      // licenseId is required by the upsert schema — we pass through the
      // existing value so editing name/description doesn't unintentionally
      // change licensing.
      licenseId: model3d.licenseId,
    });
  };

  return (
    <Modal {...dialog} title={null} size="md" centered>
      <Stack gap="md">
        <Group gap="xs">
          <IconPencil size={20} />
          <Title order={3}>Edit 3D Model</Title>
        </Group>
        <Text size="xs" c="dimmed">
          Editing name + description. Other fields (license, tags, NSFW) get their own UIs
          when we need them.
        </Text>

        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={150}
          required
          autoFocus
          error={trimmedName.length === 0 ? 'Name cannot be empty' : undefined}
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          minRows={4}
          autosize
          maxRows={12}
          placeholder="What's this model about? How was it generated? Any tips?"
        />

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={dialog.onClose} disabled={mutate.isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={mutate.isLoading} disabled={!canSave}>
            Save changes
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
