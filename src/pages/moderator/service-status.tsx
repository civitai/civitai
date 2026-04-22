import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { IconPhoto, IconSettings, IconSparkles } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };

    return { props: {} };
  },
});

export default function ServiceStatusPage() {
  return (
    <>
      <Meta title="Service Status" deIndex />
      <Container size="md" py="xl">
        <Stack gap="xl">
          <Group gap="sm" align="center">
            <IconSettings size={28} />
            <Stack gap={0}>
              <Title order={2}>Service Status</Title>
              <Text c="dimmed" size="sm">
                Enable or disable image generation and training. Set the message shown to users when
                a service is unavailable.
              </Text>
            </Stack>
          </Group>

          <GenerationStatusCard />
          <TrainingStatusCard />
        </Stack>
      </Container>
    </>
  );
}

function GenerationStatusCard() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getStatus.useQuery();
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
      await utils.generation.getStatus.invalidate();
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

function TrainingStatusCard() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.training.getStatus.useQuery();
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data || dirty) return;
    setAvailable(data.available);
    setMessage(data.message ?? '');
  }, [data, dirty]);

  const setStatus = trpc.training.setStatus.useMutation({
    onSuccess: async () => {
      await utils.training.getStatus.invalidate();
      setDirty(false);
      showNotification({
        title: 'Saved',
        message: 'Training status updated',
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
            <IconSparkles size={20} />
            <Title order={4}>Training</Title>
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
              description="When disabled, users cannot start new training jobs."
            />
            <Textarea
              label="Status message"
              description="Shown to users when training is unavailable. Leave blank for no message."
              placeholder="e.g. Training is paused while we investigate an issue."
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
                Training is disabled but no message is set. Consider adding a message so users know
                what is happening.
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
