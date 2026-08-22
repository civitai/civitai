import { Button, Divider, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { HubSourceEditor } from '~/components/Hubs/HubSourceEditor';
import { useDefaultHubSort } from '~/components/Hubs/useHubSort';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function HubUpsertModal({
  hub,
}: {
  /** Omitted to create. */
  hub?: { id: number; name: string; description?: string | null };
}) {
  const dialog = useDialogContext();
  const router = useRouter();
  const utils = trpc.useUtils();
  const editing = !!hub;
  const defaultSort = useDefaultHubSort();

  const [name, setName] = useState(hub?.name ?? '');
  const [description, setDescription] = useState(hub?.description ?? '');
  const [sources, setSources] = useState<HubSourceValue[]>([]);

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async (saved) => {
      await Promise.all([
        utils.userHub.getAll.invalidate(),
        utils.userHub.getById.invalidate({ id: saved.id }),
      ]);
      dialog.onClose();
      if (!editing) await router.push(`/hubs/${saved.id}`);
    },
    onError: (error) =>
      showErrorNotification({
        title: editing ? 'Could not save hub' : 'Could not create hub',
        error: new Error(error.message),
      }),
  });

  const trimmed = name.trim();

  const handleSave = () => {
    if (!trimmed) return;
    upsert.mutate({
      id: hub?.id,
      name: trimmed,
      description: description.trim(),
      // Editing leaves the source list alone: the rail owns it, and resending an
      // empty array here would wipe it. The sort goes with creation for the same
      // reason it is resolved on read — storing one this viewer cannot pick would
      // strand them on it.
      ...(editing
        ? {}
        : { sort: defaultSort, sources: sources.map((s, index) => ({ ...s, index })) }),
    });
  };

  return (
    <Modal {...dialog} title={<Text fw={600}>{editing ? 'Edit hub' : 'New hub'}</Text>} size="lg">
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder="Anime creators I follow"
          data-autofocus
          value={name}
          maxLength={hubLimits.nameLength}
          disabled={upsert.isPending}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Textarea
          label="Description"
          placeholder="What goes in this hub?"
          autosize
          minRows={2}
          maxRows={5}
          value={description}
          maxLength={hubLimits.descriptionLength}
          disabled={upsert.isPending}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />

        {!editing && (
          <>
            <Divider label="Sources" labelPosition="left" />
            <HubSourceEditor
              value={sources}
              onChange={setSources}
              disabled={upsert.isPending}
              emptyMessage="Add a creator or a model now, or leave it empty and fill it from the rail."
            />
          </>
        )}

        <Group justify="flex-end">
          <Button variant="default" disabled={upsert.isPending} onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button loading={upsert.isPending} disabled={!trimmed} onClick={handleSave}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
