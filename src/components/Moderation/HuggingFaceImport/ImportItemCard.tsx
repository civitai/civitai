import {
  ActionIcon,
  Anchor,
  Badge,
  Card,
  Group,
  Progress,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconPlayerStop, IconRefresh, IconTrash, IconUnlink } from '@tabler/icons-react';
import { AttachControl } from '~/components/Moderation/HuggingFaceImport/AttachControl';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import type { HuggingFaceImportView } from '~/server/services/huggingface-import.service';
import { formatBytes } from '~/utils/number-helpers';

const STATUS_COLOR: Record<string, string> = {
  Queued: 'gray',
  Transferring: 'blue',
  Completed: 'green',
  Failed: 'red',
  Canceled: 'orange',
};

const ACTIVE = new Set(['Queued', 'Transferring']);

/** One mutation's state, as this card needs it — which row is in flight, and how to start one. */
type Action = {
  mutate: (input: { id: number }) => void;
  isPending: boolean;
  variables?: { id: number } | undefined;
};

/**
 * 🔴 A card, not a table row. Filenames are long unbroken words and the useful controls sit at the
 * end of the row, so every column layout ended with the actions inside a horizontal scroll where
 * nobody found them. Nothing here has a fixed width; every group wraps.
 */
export function ImportItemCard({
  row,
  cancel,
  retry,
  remove,
  detach,
}: {
  row: HuggingFaceImportView;
  cancel: Action;
  retry: Action;
  remove: Action;
  detach: Action;
}) {
  const color = STATUS_COLOR[row.status] ?? 'gray';
  const pct = row.sizeBytes
    ? Math.min(100, Math.round((row.bytesTransferred / row.sizeBytes) * 100))
    : 0;
  const busy = (action: Action) => action.isPending && action.variables?.id === row.id;
  // A transferred file no version has claimed is storage nobody is paying attention to, so it is
  // deletable from the queue as well as from the Unattached tab.
  const unattached = row.status === 'Completed' && !row.modelFileId;
  const deletable = unattached || row.status === 'Failed' || row.status === 'Canceled';

  return (
    <Card withBorder padding="sm" radius="md">
      <Stack gap="xs">
        <Group gap="xs" align="flex-start" wrap="wrap">
          <Stack gap={2} style={{ flex: '1 1 260px', minWidth: 0 }}>
            <Anchor
              size="sm"
              target="_blank"
              style={{ wordBreak: 'break-word' }}
              href={`https://huggingface.co/${row.repo}/blob/${row.revision}/${row.filename}`}
            >
              {row.repo} / {row.filename}
            </Anchor>
            <Group gap={6} wrap="wrap">
              <Badge size="xs" color={color}>
                {row.status}
              </Badge>
              <Text size="xs" c="dimmed">
                {row.revision.slice(0, 7)} · {row.groupName}
              </Text>
            </Group>
          </Stack>

          <Group gap={4} wrap="nowrap">
            {ACTIVE.has(row.status) && (
              <Tooltip label="Cancel">
                <ActionIcon
                  variant="subtle"
                  color="orange"
                  size="sm"
                  aria-label="Cancel import"
                  loading={busy(cancel)}
                  onClick={() => cancel.mutate({ id: row.id })}
                >
                  <IconPlayerStop size={14} />
                </ActionIcon>
              </Tooltip>
            )}
            {(row.status === 'Failed' || row.status === 'Canceled') && (
              <Tooltip label="Restart from the beginning">
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Restart import"
                  loading={busy(retry)}
                  onClick={() => retry.mutate({ id: row.id })}
                >
                  <IconRefresh size={14} />
                </ActionIcon>
              </Tooltip>
            )}
            {deletable && (
              <Tooltip
                label={
                  unattached
                    ? 'Delete — removes the stored file'
                    : 'Delete — frees any parts already uploaded'
                }
              >
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  aria-label="Delete import"
                  loading={busy(remove)}
                  onClick={() =>
                    openConfirmModal({
                      title: 'Delete this import?',
                      centered: true,
                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      children: (
                        <Text size="sm">
                          Removes what is stored for{' '}
                          <Text span ff="monospace" size="sm">
                            {row.filename}
                          </Text>
                          {row.sizeBytes ? ` (${formatBytes(row.sizeBytes)})` : ''}. Re-importing
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
            )}
          </Group>
        </Group>

        {row.error && (
          <Text size="xs" c="red.4">
            {row.error}
          </Text>
        )}

        <Group gap="xs" align="center" wrap="wrap">
          <Progress value={row.status === 'Completed' ? 100 : pct} color={color} flex="1 1 160px" />
          <Text size="xs" c="dimmed">
            {formatBytes(row.bytesTransferred)}
            {row.sizeBytes ? ` of ${formatBytes(row.sizeBytes)}` : ''}
          </Text>
        </Group>

        {(row.url || row.status === 'Completed') && (
          <Group gap="xs" align="center" wrap="wrap" justify="space-between">
            {row.url && (
              <Group gap={4} wrap="nowrap" style={{ flex: '1 1 240px', minWidth: 0 }}>
                <Text size="xs" c="dimmed" lineClamp={1} style={{ wordBreak: 'break-all' }}>
                  {row.url}
                </Text>
                <CopyButton value={row.url}>
                  {({ copied, copy, Icon, color: copyColor }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy file URL'}>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        color={copyColor}
                        aria-label="Copy file URL"
                        onClick={copy}
                      >
                        <Icon size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            )}
            {row.status === 'Completed' && (
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
                      aria-label="Detach import"
                      loading={busy(detach)}
                      onClick={() => detach.mutate({ id: row.id })}
                    >
                      <IconUnlink size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
            )}
          </Group>
        )}
      </Stack>
    </Card>
  );
}
