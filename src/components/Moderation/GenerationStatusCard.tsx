import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Switch,
  Textarea,
  Title,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { IconPhoto } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { trpc } from '~/utils/trpc';

export function GenerationStatusCard() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getStatusModerator.useQuery();
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data || dirty) return;
    setAvailable(data.available);
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
    setStatus.mutate({ available, message: message.trim() ? message : null });
  };

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group gap="sm" align="center" justify="space-between">
          <Group gap="sm" align="center">
            <IconPhoto size={20} />
            <Title order={4}>Image Generation</Title>
          </Group>
          {!isLoading && data && (
            <Badge color={data.available ? 'green' : 'red'} variant="light">
              {data.available ? 'Available' : 'Unavailable'}
            </Badge>
          )}
        </Group>

        {isLoading ? (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        ) : (
          <>
            <Switch
              checked={available}
              onChange={(e) => {
                setAvailable(e.currentTarget.checked);
                setDirty(true);
              }}
              label={available ? 'Enabled' : 'Disabled'}
              description="When disabled, users cannot start new image generations."
            />
            <Textarea
              label="Status message"
              description="Shown to users when generation is unavailable. Leave blank for no message."
              placeholder="e.g. Image generation is temporarily down for maintenance."
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
            {!available && !message.trim() && (
              <Alert color="yellow" variant="light">
                Generation is disabled but no message is set. Consider adding a message so users
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
