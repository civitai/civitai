import { useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import {
  ActionIcon,
  Anchor,
  Badge,
  Card,
  Group,
  Progress,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { AttachControl } from '~/components/Moderation/HuggingFaceImport/AttachControl';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const STATUS_COLOR: Record<string, string> = {
  Queued: 'gray',
  Transferring: 'blue',
  Completed: 'teal',
  Failed: 'red',
  Canceled: 'orange',
};

const ACTIVE = new Set(['Queued', 'Transferring']);

export function ImportQueueTable() {
  const queryUtils = trpc.useUtils();
  const [groupFilter, setGroupFilter] = useState('');
  // Debounced so a keystroke is not a query; the filter is server-side because a client-side one
  // over a capped page silently stops finding older groups.
  const [debouncedFilter] = useDebouncedValue(groupFilter, 300);
  const { data = [], isLoading: isPending } = trpc.huggingFaceImport.getAll.useQuery(
    { limit: 100, groupName: debouncedFilter.trim() || undefined },
    {
      // A transfer advances a part at a time on a cron; polling is how the bar moves without a
      // websocket, and it stops as soon as nothing is in flight.
      refetchInterval: (query) =>
        query.state.data?.some((row) => ACTIVE.has(row.status)) ? 5000 : false,
    }
  );

  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Action failed', error: new Error(error.message) });

  // `ok: false` means the row moved on before the click landed — a cancel on a row that just
  // completed, say. Invalidating and saying nothing renders a refusal as a successful no-op.
  const onSettled = (result: { ok: boolean } | undefined, action: string) => {
    if (result && !result.ok)
      showErrorNotification({
        title: `Could not ${action}`,
        error: new Error('The import is no longer in a state where that applies. Refreshed.'),
      });
    return queryUtils.huggingFaceImport.getAll.invalidate();
  };

  const retry = trpc.huggingFaceImport.retry.useMutation({
    onError,
    onSuccess: (result) => onSettled(result, 'retry'),
  });
  const cancel = trpc.huggingFaceImport.cancel.useMutation({
    onError,
    onSuccess: (result) => onSettled(result, 'cancel'),
  });

  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Title order={4}>Imports</Title>
          <TextInput
            size="xs"
            w={260}
            placeholder="Filter by group name…"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.currentTarget.value)}
          />
        </Group>

        {!data.length ? (
          <Text c="dimmed" size="sm">
            {isPending
              ? 'Loading…'
              : debouncedFilter.trim()
              ? `No imports match "${debouncedFilter.trim()}".`
              : 'Nothing imported yet.'}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={900}>
            <Table verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Progress</Table.Th>
                  <Table.Th>Uploaded file</Table.Th>
                  <Table.Th>Attached to</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.map((row) => {
                  const pct = row.sizeBytes
                    ? Math.min(100, Math.round((row.bytesTransferred / row.sizeBytes) * 100))
                    : 0;
                  return (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Stack gap={2}>
                          <Anchor
                            size="sm"
                            target="_blank"
                            href={`https://huggingface.co/${row.repo}/blob/${row.revision}/${row.filename}`}
                          >
                            {row.repo} / {row.filename}
                          </Anchor>
                          <Group gap={6}>
                            <Badge size="xs" color={STATUS_COLOR[row.status] ?? 'gray'}>
                              {row.status}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {row.revision.slice(0, 7)}
                            </Text>
                          </Group>
                          {row.error && (
                            <Text size="xs" c="red.4" lineClamp={2}>
                              {row.error}
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{row.sizeBytes ? formatBytes(row.sizeBytes) : '—'}</Text>
                      </Table.Td>
                      <Table.Td miw={160}>
                        <Stack gap={2}>
                          <Progress
                            value={row.status === 'Completed' ? 100 : pct}
                            color={STATUS_COLOR[row.status] ?? 'gray'}
                          />
                          <Text size="xs" c="dimmed">
                            {formatBytes(row.bytesTransferred)}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        {row.url ? (
                          <Group gap={4} wrap="nowrap">
                            <Text size="xs" lineClamp={1} className="max-w-[260px]">
                              {row.url}
                            </Text>
                            <CopyButton value={row.url}>
                              {({ copied, copy, Icon, color }) => (
                                <Tooltip label={copied ? 'Copied' : 'Copy file URL'}>
                                  <ActionIcon
                                    variant="subtle"
                                    size="sm"
                                    color={color}
                                    onClick={copy}
                                  >
                                    <Icon size={14} />
                                  </ActionIcon>
                                </Tooltip>
                              )}
                            </CopyButton>
                          </Group>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {row.status === 'Completed' ? (
                          <AttachControl
                            importId={row.id}
                            filename={row.filename}
                            suggestedType={row.suggestedType}
                            modelFileId={row.modelFileId}
                            modelVersionId={row.modelVersionId}
                          />
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap" justify="flex-end">
                          {ACTIVE.has(row.status) && (
                            <Tooltip label="Cancel">
                              <ActionIcon
                                variant="subtle"
                                color="orange"
                                size="sm"
                                loading={cancel.isPending && cancel.variables?.id === row.id}
                                onClick={() => cancel.mutate({ id: row.id })}
                              >
                                <IconPlayerStop size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {(row.status === 'Failed' || row.status === 'Canceled') && (
                            <Tooltip label="Retry from the start">
                              <ActionIcon
                                variant="subtle"
                                size="sm"
                                loading={retry.isPending && retry.variables?.id === row.id}
                                onClick={() => retry.mutate({ id: row.id })}
                              >
                                <IconRefresh size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Card>
  );
}
