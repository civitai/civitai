import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  MultiSelect,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { IconSettings, IconSparkles } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { GenerationStatusCard } from '~/components/Moderation/GenerationStatusCard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trainingModelInfo } from '~/utils/training';
import { isBaseModelKey } from '~/utils/training-blocked-models';
import { trpc } from '~/utils/trpc';

const baseModelOptions = Object.entries(trainingModelInfo)
  .filter(([, info]) => !info.disabled)
  .map(([key, info]) => ({
    value: key,
    label: info.label === 'Base' ? info.pretty : `${info.pretty} · ${info.label}`,
  }));

function ServiceStatusPage() {
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

function TrainingStatusCard() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.training.getStatusModerator.useQuery();
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState<string[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  // Sent only when edited, so an on/off toggle never overwrites a block set elsewhere meanwhile.
  const [blockedDirty, setBlockedDirty] = useState(false);

  useEffect(() => {
    if (!data || dirty) return;
    setAvailable(data.available);
    setMessage(data.message ?? '');
    // Only base models are edited here; blocked custom-model AIRs are kept server-side.
    setBlocked(data.blockedModels.filter(isBaseModelKey));
    setReasons(data.blockedModelReasons ?? {});
  }, [data, dirty]);

  const setStatus = trpc.training.setStatus.useMutation({
    onSuccess: async () => {
      await utils.training.getStatusModerator.invalidate();
      setDirty(false);
      setBlockedDirty(false);
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
    setStatus.mutate({
      available,
      message: message.trim() ? message : null,
      ...(blockedDirty ? { blockedModels: blocked, blockedModelReasons: reasons } : {}),
    });
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
            <MultiSelect
              label="Unavailable models"
              description="Shown as temporarily unavailable in both trainers and refused on submit. A model whose rollout flag is off stays hidden."
              placeholder="Pick a base model"
              data={baseModelOptions}
              value={blocked}
              onChange={(value) => {
                setBlocked(value);
                setDirty(true);
                setBlockedDirty(true);
              }}
              searchable
              clearable
            />
            {blocked.map((key) => (
              <TextInput
                key={key}
                label={`Note for ${
                  baseModelOptions.find((option) => option.value === key)?.label ?? key
                }`}
                description="Optional. Shown under “Temporarily unavailable”."
                placeholder="e.g. Our training provider is having an outage."
                maxLength={300}
                value={reasons[key] ?? ''}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setReasons((current) => ({ ...current, [key]: value }));
                  setDirty(true);
                  setBlockedDirty(true);
                }}
              />
            ))}
            {!available && !message.trim() && (
              <Alert color="yellow" variant="light">
                Training is disabled but no message is set. Consider adding a message so users know
                what is happening.
              </Alert>
            )}
            <Group justify="flex-end">
              <Button onClick={handleSave} loading={setStatus.isPending} disabled={!dirty}>
                Save
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Card>
  );
}

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default Page(ServiceStatusPage, {
  features: (features) => features.serviceStatus,
});
