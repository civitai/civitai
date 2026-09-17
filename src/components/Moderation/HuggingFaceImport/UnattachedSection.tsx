import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RenameGroupControl } from '~/components/Moderation/HuggingFaceImport/RenameGroupControl';
import { confirmForce } from '~/components/Moderation/HuggingFaceImport/confirm-force';
import { byGroup } from '~/components/Moderation/HuggingFaceImport/utils';
import dayjs from '~/shared/utils/dayjs';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { HuggingFaceImportView } from '~/server/services/huggingface-import.service';

const STALE_DAYS = 60;

export function UnattachedSection({ filter }: { filter: string }) {
  const queryUtils = trpc.useUtils();
  const groupName = filter.trim() || undefined;

  const { data = [], isLoading } = trpc.huggingFaceImport.getAll.useQuery({
    limit: 200,
    unattached: true,
    groupName,
  });

  const refresh = async () => {
    await Promise.all([
      queryUtils.huggingFaceImport.getAll.invalidate(),
      queryUtils.huggingFaceImport.getCounts.invalidate(),
    ]);
  };

  const remove = trpc.huggingFaceImport.delete.useMutation({
    onError: (error) =>
      showErrorNotification({ title: 'Could not delete', error: new Error(error.message) }),
  });

  const confirmDelete = (rows: HuggingFaceImportView[]) =>
    openConfirmModal({
      title: `Delete ${rows.length} file${rows.length === 1 ? '' : 's'}?`,
      centered: true,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      children: (
        <Stack gap="sm">
          <Text size="sm">
            Frees{' '}
            <strong>{formatBytes(rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0))}</strong>.
            Re-importing means transferring them again from{' '}
            <Text span ff="monospace" size="sm">
              {rows[0]?.repo}
            </Text>
            .
          </Text>
          <Alert color="gray">
            <Text size="xs">
              Any file a model version still points at is refused, so a detached import that is
              still in use cannot be deleted from here.
            </Text>
          </Alert>
        </Stack>
      ),
      onConfirm: async () => {
        // One call per file rather than a bulk endpoint: each deletes a distinct stored object, and
        // a partial failure should leave the rest deleted rather than rolling back freed bytes.
        const deleteAll = async (batch: HuggingFaceImportView[], force = false) => {
          let deleted = 0;
          const stuck: { row: HuggingFaceImportView; message: string }[] = [];
          for (const row of batch) {
            const result = await remove.mutateAsync({ id: row.id, force }).catch(() => null);
            if (result?.ok) deleted++;
            else if (result?.reason === 'storage') stuck.push({ row, message: result.message });
          }
          return { deleted, stuck };
        };

        const { deleted, stuck } = await deleteAll(rows);
        // Counted, not assumed: the server refuses a delete it cannot make safe, and this toast is
        // the last thing a moderator reconciling storage reads.
        const failed = rows.length - deleted;
        if (failed)
          showErrorNotification({
            title: `Deleted ${deleted} of ${rows.length}`,
            error: new Error(`${failed} could not be deleted — see the errors above.`),
          });
        else showSuccessNotification({ title: 'Deleted', message: `${deleted} file(s) removed.` });
        await refresh();

        if (stuck.length)
          confirmForce({
            action: 'Delete',
            what: `${stuck.length} file${stuck.length === 1 ? '' : 's'}`,
            message: stuck.map(({ row, message }) => `${row.filename}: ${message}`).join('\n'),
            onConfirm: async () => {
              const forced = await deleteAll(
                stuck.map(({ row }) => row),
                true
              );
              if (forced.deleted < stuck.length)
                showErrorNotification({
                  title: `Deleted ${forced.deleted} of ${stuck.length}`,
                  error: new Error('The rest could not be deleted — see the errors above.'),
                });
              await refresh();
            },
          });
      },
    });

  const groups = byGroup(data);

  return (
    <Stack gap="md">
      {!groups.length ? (
        <Text c="dimmed" size="sm">
          {isLoading
            ? 'Loading…'
            : groupName
            ? `Nothing unattached matches "${groupName}".`
            : 'Nothing unattached — every transferred file is on a model version.'}
        </Text>
      ) : (
        groups.map((group) => {
          const stale = dayjs().diff(dayjs(group.oldest), 'day') >= STALE_DAYS;
          return (
            <Stack key={`${group.groupName}:${group.repo}:${group.revision}`} gap={6}>
              <Group gap="xs" wrap="wrap">
                <Text fw={600} size="sm">
                  {group.groupName}
                </Text>
                <RenameGroupControl
                  repo={group.repo}
                  revision={group.revision}
                  groupName={group.groupName}
                />
                <Badge size="xs" variant="light" color="gray">
                  {group.repo}
                </Badge>
                <Badge size="xs" variant="light">
                  {group.revision.slice(0, 7)}
                </Badge>
                <Text size="xs" c="dimmed">
                  {group.items.length} file{group.items.length === 1 ? '' : 's'} ·{' '}
                  {formatBytes(group.bytes)} · imported <DaysFromNow date={group.oldest} />
                </Text>
                {stale && (
                  <Badge size="xs" color="red">
                    stale
                  </Badge>
                )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  ml="auto"
                  onClick={() => confirmDelete(group.items)}
                >
                  Delete {group.items.length}
                </Button>
              </Group>

              {group.items.map((row) => (
                <Group key={row.id} gap="xs" pl="sm" wrap="nowrap">
                  <Text size="xs" ff="monospace" lineClamp={1}>
                    {row.filename}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {row.sizeBytes ? formatBytes(row.sizeBytes) : '—'}
                  </Text>
                  {row.suggestedType && (
                    <Badge size="xs" variant="light">
                      {row.suggestedType}
                    </Badge>
                  )}
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    ml="auto"
                    onClick={() => confirmDelete([row])}
                  >
                    Delete
                  </Button>
                </Group>
              ))}
            </Stack>
          );
        })
      )}
    </Stack>
  );
}
