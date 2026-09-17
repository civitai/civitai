import { Alert, Button, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { confirmForce } from '~/components/Moderation/HuggingFaceImport/confirm-force';
import { ImportGroupList } from '~/components/Moderation/HuggingFaceImport/ImportGroupList';
import { useImportActions } from '~/components/Moderation/HuggingFaceImport/use-import-actions';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { HuggingFaceImportView } from '~/server/services/huggingface-import.service';

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

  // Per-card actions are shared with the queue tab; this second delete mutation is the BULK one,
  // which reads each result itself and must not also raise the per-call force prompt.
  const actions = useImportActions((id) => data.find((row) => row.id === id)?.filename ?? 'it');
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

  return (
    <Stack gap="md">
      {!data.length ? (
        <Text c="dimmed" size="sm">
          {isLoading
            ? 'Loading…'
            : groupName
            ? `Nothing unattached matches "${groupName}".`
            : 'Nothing unattached — every transferred file is on a model version.'}
        </Text>
      ) : (
        <ImportGroupList
          rows={data}
          actions={actions}
          groupAction={(items) => (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={() => confirmDelete(items)}
            >
              Delete {items.length}
            </Button>
          )}
        />
      )}
    </Stack>
  );
}
