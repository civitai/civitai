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
  SegmentedControl,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconPlayerStop, IconRefresh, IconTrash, IconUnlink } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import { confirmForce } from '~/components/Moderation/HuggingFaceImport/confirm-force';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { UnattachedSection } from '~/components/Moderation/HuggingFaceImport/UnattachedSection';
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
  const [tab, setTab] = useState<'all' | 'unattached'>('all');
  const [groupFilter, setGroupFilter] = useState('');
  // Debounced so a keystroke is not a query; the filter is server-side because a client-side one
  // over a capped page silently stops finding older groups.
  const [debouncedFilter] = useDebouncedValue(groupFilter, 300);
  // Counts come from their own query: a page of rows cannot say how many exist outside it, which
  // is what the client-side filter got wrong. Filtered the same way the rows are, so a tab label
  // never counts a population the list beneath it is not showing.
  const { data: counts } = trpc.huggingFaceImport.getCounts.useQuery({
    groupName: debouncedFilter.trim() || undefined,
  });
  const { data = [], isLoading: isPending } = trpc.huggingFaceImport.getAll.useQuery(
    { limit: 100, groupName: debouncedFilter.trim() || undefined },
    {
      // A transfer advances a part at a time on a cron; polling is how the bar moves without a
      // websocket, and it stops as soon as nothing is in flight.
      refetchInterval: (query) =>
        query.state.data?.some((row) => ACTIVE.has(row.status)) ? 5000 : false,
    }
  );

  const nameOf = (id: number) => data.find((row) => row.id === id)?.filename ?? 'this import';

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
    return Promise.all([
      queryUtils.huggingFaceImport.getAll.invalidate(),
      queryUtils.huggingFaceImport.getCounts.invalidate(),
    ]);
  };

  // Wires the path `buildAttachInput`'s refusal recommends. Until this existed, "detach or delete
  // that file first" named something no moderator could do.
  const detach = trpc.huggingFaceImport.detach.useMutation({
    onError,
    onSuccess: (result) => onSettled(result, 'detach'),
  });
  // A Failed row can still hold an uploadId, and its parts are billed until something aborts them.
  // Retry was the only exit, so abandoning a transfer meant paying for it indefinitely.
  const remove = trpc.huggingFaceImport.delete.useMutation({
    onError,
    onSuccess: (result, input) => {
      if (!result.ok && result.reason === 'storage' && !input.force)
        return confirmForce({
          action: 'Delete',
          what: nameOf(input.id),
          message: result.message,
          onConfirm: () => remove.mutate({ id: input.id, force: true }),
        });
      return onSettled(result, 'delete');
    },
  });
  const retry = trpc.huggingFaceImport.retry.useMutation({
    onError,
    onSuccess: (result, input) => {
      if (!result.ok && result.reason === 'storage' && !input.force)
        return confirmForce({
          action: 'Restart',
          what: nameOf(input.id),
          message: result.message,
          onConfirm: () => retry.mutate({ id: input.id, force: true }),
        });
      return onSettled(result, 'restart');
    },
  });
  const cancel = trpc.huggingFaceImport.cancel.useMutation({
    onError,
    onSuccess: (result) => onSettled(result, 'cancel'),
  });

  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="lg" wrap="nowrap">
            <Title order={4}>Imports</Title>
            <SegmentedControl
              size="xs"
              value={tab}
              onChange={(value) => setTab(value as 'all' | 'unattached')}
              data={[
                { value: 'all', label: `All${counts ? ` (${counts.total})` : ''}` },
                {
                  value: 'unattached',
                  label: `Unattached${counts ? ` (${counts.unattached})` : ''}`,
                },
              ]}
            />
          </Group>
          <TextInput
            size="xs"
            w={260}
            placeholder="Filter by group name…"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.currentTarget.value)}
          />
        </Group>

        {tab === 'unattached' && <UnattachedSection filter={debouncedFilter} />}

        {tab === 'unattached' ? null : !data.length ? (
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
                          <Group gap={4} wrap="nowrap">
                            <AttachControl
                              importId={row.id}
                              filename={row.filename}
                              suggestedType={row.suggestedType}
                              modelFileId={row.modelFileId}
                              modelVersionId={row.modelVersionId}
                            />
                            {row.modelFileId && (
                              <Tooltip label="Detach — leaves the model file in place">
                                <ActionIcon
                                  variant="subtle"
                                  size="sm"
                                  loading={detach.isPending && detach.variables?.id === row.id}
                                  onClick={() => detach.mutate({ id: row.id })}
                                >
                                  <IconUnlink size={14} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Group>
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
                                aria-label="Cancel import"
                                loading={cancel.isPending && cancel.variables?.id === row.id}
                                onClick={() => cancel.mutate({ id: row.id })}
                              >
                                <IconPlayerStop size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {(row.status === 'Failed' || row.status === 'Canceled') && (
                            <>
                              <Tooltip label="Restart from the beginning">
                                <ActionIcon
                                  variant="subtle"
                                  size="sm"
                                  aria-label="Restart import"
                                  loading={retry.isPending && retry.variables?.id === row.id}
                                  onClick={() => retry.mutate({ id: row.id })}
                                >
                                  <IconRefresh size={14} />
                                </ActionIcon>
                              </Tooltip>
                              <Tooltip label="Delete — frees any parts already uploaded">
                                <ActionIcon
                                  variant="subtle"
                                  color="red"
                                  size="sm"
                                  aria-label="Delete import"
                                  loading={remove.isPending && remove.variables?.id === row.id}
                                  onClick={() =>
                                    openConfirmModal({
                                      title: 'Delete this import?',
                                      centered: true,
                                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                                      confirmProps: { color: 'red' },
                                      children: (
                                        <Text size="sm">
                                          Aborts the upload of{' '}
                                          <Text span ff="monospace" size="sm">
                                            {row.filename}
                                          </Text>{' '}
                                          and removes anything already stored for it. Re-importing
                                          means transferring it again from {row.repo}.
                                        </Text>
                                      ),
                                      onConfirm: () => remove.mutate({ id: row.id }),
                                    })
                                  }
                                >
                                  <IconTrash size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </>
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
