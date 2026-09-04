import {
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useInvalidateHub } from '~/components/Hubs/hub.utils';
import type { AddUserHubSourceInput } from '~/server/schema/user-hub.schema';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function AddToHubModal({
  source,
}: {
  // `exclude` is omitted, not defaulted: every entry point into this modal is a
  // "put this in a hub" affordance on a creator or model page. Keeping the field out
  // of the prop means a caller cannot quietly turn one of them into an exclusion.
  source: Omit<AddUserHubSourceInput, 'hubId' | 'exclude'>;
}) {
  const dialog = useDialogContext();
  const invalidateHub = useInvalidateHub();
  const [name, setName] = useState('');

  const { data: hubs, isLoading } = trpc.userHub.getAll.useQuery();

  const onError = (title: string) => (error: { message: string }) =>
    showErrorNotification({ title, error: new Error(error.message) });

  const addSource = trpc.userHub.addSource.useMutation({
    onSuccess: (_, variables) => invalidateHub(variables.hubId),
    onError: onError('Could not add to hub'),
  });
  const removeSource = trpc.userHub.removeSource.useMutation({
    onSuccess: (_, variables) => invalidateHub(variables.hubId),
    onError: onError('Could not remove from hub'),
  });
  const createHub = trpc.userHub.upsert.useMutation({
    onSuccess: async (hub) => {
      setName('');
      await invalidateHub(hub.id);
    },
    onError: onError('Could not create hub'),
  });

  const pending = addSource.isPending || removeSource.isPending || createHub.isPending;
  const trimmed = name.trim();
  const atHubLimit = (hubs?.length ?? 0) >= hubLimits.hubsPerUser;

  return (
    <Modal {...dialog} title={<Text fw={600}>Add to hub</Text>} size="md">
      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : (
        <Stack gap="md">
          {!hubs?.length ? (
            <Text c="dimmed" size="sm">
              You do not have any hubs yet. Name one below and this goes in it.
            </Text>
          ) : (
            <Stack gap="xs">
              {hubs.map((hub) => {
                // Membership here means "this hub shows me that source", so a row the
                // owner switched off in the rail reads as unticked: the hub is not
                // showing it, and ticking is what turns it back on.
                const checked = hub.sources.some(
                  (s) =>
                    s.type === source.type &&
                    s.targetId === source.targetId &&
                    s.enabled &&
                    !s.exclude
                );
                // Exclusions have their own cap, so counting them here would report a
                // hub as full while it still had room for what this box adds.
                const held = hub.sources.filter((s) => !s.exclude).length;
                const full = held >= hubLimits.sourcesPerHub;
                return (
                  <Checkbox
                    key={hub.id}
                    checked={checked}
                    disabled={pending || (full && !checked)}
                    label={
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm">{hub.name}</Text>
                        <Text size="xs" c="dimmed">
                          {full && !checked ? 'Full' : `${held}/${hubLimits.sourcesPerHub}`}
                        </Text>
                      </Group>
                    }
                    onChange={() =>
                      checked
                        ? removeSource.mutate({
                            hubId: hub.id,
                            type: source.type,
                            targetId: source.targetId,
                          })
                        : addSource.mutate({
                            hubId: hub.id,
                            type: source.type,
                            targetId: source.targetId,
                            alias: source.alias,
                          })
                    }
                  />
                );
              })}
            </Stack>
          )}

          <Divider label="New hub" labelPosition="left" />
          <Group gap="xs" wrap="nowrap">
            <TextInput
              className="flex-1"
              placeholder="Name a new hub"
              value={name}
              maxLength={hubLimits.nameLength}
              disabled={pending || atHubLimit}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Button
              loading={createHub.isPending}
              disabled={!trimmed || atHubLimit}
              onClick={() =>
                createHub.mutate({
                  name: trimmed,
                  sources: [
                    {
                      type: source.type,
                      targetId: source.targetId,
                      alias: source.alias,
                      index: 0,
                    },
                  ],
                })
              }
            >
              Create
            </Button>
          </Group>
          {atHubLimit && (
            <Text size="xs" c="dimmed">
              You already have {hubLimits.hubsPerUser} hubs, which is the limit.
            </Text>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.onClose}>
              Done
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
