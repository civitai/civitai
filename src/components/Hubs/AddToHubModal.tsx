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
import { hubLimits } from '~/server/schema/user-hub.schema';
import type { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type HubSourceTarget = {
  type: UserHubSourceType;
  targetId: number;
  alias?: string | null;
};

export default function AddToHubModal({ source }: { source: HubSourceTarget }) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const [name, setName] = useState('');

  const { data: hubs, isLoading } = trpc.userHub.getAll.useQuery();

  const invalidate = async (hubId: number) => {
    await Promise.all([
      utils.userHub.getAll.invalidate(),
      utils.userHub.getById.invalidate({ id: hubId }),
    ]);
    await utils.image.getInfinite.invalidate({ hubId });
  };

  const onError = (title: string) => (error: { message: string }) =>
    showErrorNotification({ title, error: new Error(error.message) });

  const addSource = trpc.userHub.addSource.useMutation({
    onSuccess: (_, variables) => invalidate(variables.hubId),
    onError: onError('Could not add to hub'),
  });
  const removeSource = trpc.userHub.removeSource.useMutation({
    onSuccess: (_, variables) => invalidate(variables.hubId),
    onError: onError('Could not remove from hub'),
  });
  const createHub = trpc.userHub.upsert.useMutation({
    onSuccess: async (hub) => {
      setName('');
      await invalidate(hub.id);
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
                  (s) => s.type === source.type && s.targetId === source.targetId && s.enabled
                );
                const full = hub.sources.length >= hubLimits.sourcesPerHub;
                return (
                  <Checkbox
                    key={hub.id}
                    checked={checked}
                    disabled={pending || (full && !checked)}
                    label={
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm">{hub.name}</Text>
                        <Text size="xs" c="dimmed">
                          {full && !checked
                            ? 'Full'
                            : `${hub.sources.length}/${hubLimits.sourcesPerHub}`}
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
