import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { IconPhoto } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type {
  GenerationStatusMode,
  GenerationStatusUpdatedBy,
} from '~/server/schema/generation.schema';
import { trpc } from '~/utils/trpc';
import { generationStatusDefaultMessage } from '~/server/schema/generation.schema';

const MODE_OPTIONS: { label: string; value: GenerationStatusMode }[] = [
  { label: 'Enabled', value: 'enabled' },
  { label: 'Members only', value: 'memberOnly' },
  { label: 'Disabled', value: 'disabled' },
];

const MODE_BADGE: Record<GenerationStatusMode, { label: string; color: string }> = {
  enabled: { label: 'Available', color: 'green' },
  memberOnly: { label: 'Members only', color: 'yellow' },
  disabled: { label: 'Unavailable', color: 'red' },
};

const MODE_DESCRIPTION: Record<GenerationStatusMode, string> = {
  enabled: 'All users can generate.',
  memberOnly: 'Only members can generate. Free (non-member) users are blocked.',
  disabled: 'No users can generate.',
};

function RestrictedByBadge({ updatedBy }: { updatedBy?: GenerationStatusUpdatedBy | null }) {
  if (!updatedBy) return null;
  const when = new Date(updatedBy.at);
  return (
    <Text size="xs" c="dimmed">
      Restricted by {updatedBy.username}
      {!isNaN(when.getTime()) ? ` · ${when.toLocaleString()}` : ''}
    </Text>
  );
}

export function GenerationStatusCard() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getStatusModerator.useQuery();
  const [mode, setMode] = useState<GenerationStatusMode>('enabled');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data || dirty) return;
    setMode(data.mode in MODE_BADGE ? data.mode : 'enabled');
    setMessage(data.message ?? '');
  }, [data, dirty]);

  const setStatus = trpc.generation.setStatus.useMutation({
    onSuccess: async () => {
      await utils.generation.getStatusModerator.invalidate();
      setDirty(false);
      showNotification({
        title: 'Saved',
        message: 'Image generation status updated',
        color: 'green',
      });
    },
    onError: (error) => {
      showNotification({ title: 'Error', message: error.message, color: 'red' });
    },
  });

  const handleSave = () => {
    // Only send `message` when it actually changed, so a mode-only save keeps
    // the stored message. Omitting it (undefined) tells the server to preserve.
    const messageEdited = message !== (data?.message ?? '');
    setStatus.mutate({
      mode,
      ...(messageEdited ? { message: message.trim() ? message : null } : {}),
    });
  };

  const restricted = mode !== 'enabled';

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group gap="sm" align="center" justify="space-between">
          <Group gap="sm" align="center">
            <IconPhoto size={20} />
            <Title order={4}>Image Generation</Title>
          </Group>
          {!isLoading &&
            data &&
            (() => {
              const badge = MODE_BADGE[data.mode] ?? MODE_BADGE.enabled;
              return (
                <Badge color={badge.color} variant="light">
                  {badge.label}
                </Badge>
              );
            })()}
        </Group>

        {isLoading ? (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        ) : (
          <>
            <Stack gap={4}>
              <SegmentedControl
                value={mode}
                onChange={(value) => {
                  setMode(value as GenerationStatusMode);
                  setDirty(true);
                }}
                data={MODE_OPTIONS}
              />
              <Text size="xs" c="dimmed">
                {MODE_DESCRIPTION[mode]}
              </Text>
              {data && data.mode !== 'enabled' && <RestrictedByBadge updatedBy={data.updatedBy} />}
            </Stack>
            <Textarea
              label="Status message"
              description="Shown to blocked users when generation is restricted. Leave blank for a default message."
              placeholder={`e.g. ${generationStatusDefaultMessage}`}
              value={message}
              onChange={(e) => {
                setMessage(e.currentTarget.value);
                setDirty(true);
              }}
              minRows={2}
              maxRows={6}
              autosize
              maxLength={2000}
            />
            {restricted && !message.trim() && (
              <Alert color="yellow" variant="light">
                Generation is restricted but no message is set. Consider adding a message so users
                know what is happening.
              </Alert>
            )}
            <Group justify="flex-end">
              <Button onClick={handleSave} loading={setStatus.isLoading} disabled={!dirty}>
                Save
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Card>
  );
}
