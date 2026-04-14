import { useState } from 'react';
import { ActionIcon, Popover, TextInput, Button, Text, Stack, Group } from '@mantine/core';
import { IconSearch, IconArrowsShuffle } from '@tabler/icons-react';
import { Tooltip } from '@mantine/core';
import { generationGraphStore, REMIX_WORKFLOW_OVERRIDES } from '~/store/generation-graph.store';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { formatDateMin } from '~/utils/date-helpers';

export function WorkflowLookup() {
  const [opened, setOpened] = useState(false);
  const [workflowId, setWorkflowId] = useState('');
  const [lookupId, setLookupId] = useState<string | null>(null);

  const { data, isFetching, error } = trpc.orchestrator.getWorkflowForModeration.useQuery(
    { workflowId: lookupId! },
    {
      enabled: !!lookupId,
      retry: false,
      onError(err) {
        showErrorNotification({
          title: 'Workflow lookup failed',
          error: new Error(err.message),
        });
      },
    }
  );

  function handleLookup() {
    const trimmed = workflowId.trim();
    if (!trimmed) return;
    setLookupId(trimmed);
  }

  function handleRemix() {
    if (!data?.metadata) return;

    const params = { ...data.metadata.params };

    // Map enhancement workflows back to base workflow for remix
    const workflow = params.workflow as string | undefined;
    if (workflow && REMIX_WORKFLOW_OVERRIDES[workflow]) {
      params.workflow = REMIX_WORKFLOW_OVERRIDES[workflow];
    }

    generationGraphStore.setData({
      params,
      resources: data.metadata.resources ?? [],
      runType: 'remix',
      remixOfId: data.metadata.remixOfId,
    });

    showSuccessNotification({ message: 'Workflow loaded into generation form' });
    setWorkflowId('');
    setLookupId(null);
    setOpened(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleLookup();
  }

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" width={360}>
      <Popover.Target>
        <Tooltip label="Lookup workflow (mod)">
          <ActionIcon size="lg" variant="transparent" onClick={() => setOpened((o) => !o)}>
            <IconSearch size={20} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            Workflow Lookup
          </Text>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              className="flex-1"
              placeholder="Workflow ID"
              value={workflowId}
              onChange={(e) => {
                setWorkflowId(e.currentTarget.value);
                setLookupId(null);
              }}
              onKeyDown={handleKeyDown}
              size="xs"
            />
            <Button size="xs" onClick={handleLookup} loading={isFetching}>
              Lookup
            </Button>
          </Group>

          {error && (
            <Text size="xs" c="red">
              {error.message}
            </Text>
          )}

          {data && (
            <Stack gap={4}>
              <Group gap="xs" justify="space-between">
                <Text size="xs" c="dimmed">
                  Status:{' '}
                  <Text span fw={500}>
                    {data.status}
                  </Text>
                </Text>
                <Text size="xs" c="dimmed">
                  {formatDateMin(data.createdAt)}
                </Text>
              </Group>
              {!!data.metadata?.params?.workflow && (
                <Text size="xs" c="dimmed">
                  Workflow:{' '}
                  <Text span fw={500}>
                    {String(data.metadata.params.workflow)}
                  </Text>
                </Text>
              )}
              {!!data.metadata?.params?.prompt && (
                <Text size="xs" c="dimmed" lineClamp={2}>
                  Prompt: {String(data.metadata.params.prompt)}
                </Text>
              )}
              <Button
                size="xs"
                leftSection={<IconArrowsShuffle size={14} />}
                onClick={handleRemix}
                disabled={!data.metadata}
                fullWidth
                mt={4}
              >
                Load into Generator
              </Button>
            </Stack>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
