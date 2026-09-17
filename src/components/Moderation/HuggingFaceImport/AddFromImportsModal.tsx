import { Alert, Badge, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { attachImports } from '~/components/Moderation/HuggingFaceImport/attach-imports';
import { byGroup } from '~/components/Moderation/HuggingFaceImport/utils';
import type { ModelFileType } from '~/server/common/constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { getModelFileTypeOptions } from '~/utils/file-display-helpers';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type AddFromImportsModalProps = {
  modelVersionId: number;
  modelType?: ModelType | null;
  /** From the `FilesProvider` that opened this — a dialog mounts outside that subtree. */
  adoptFiles: (modelFileIds: number[]) => Promise<void>;
};

export default function AddFromImportsModal({
  modelVersionId,
  modelType,
  adoptFiles,
}: AddFromImportsModalProps) {
  const dialog = useDialogContext();
  const [filter, setFilter] = useState('');
  const [debouncedFilter] = useDebouncedValue(filter, 300);
  const [selection, setSelection] = useState<Record<number, ModelFileType | null>>({});
  const [attaching, setAttaching] = useState(false);
  const queryUtils = trpc.useUtils();

  const { data = [], isLoading } = trpc.huggingFaceImport.getAll.useQuery({
    limit: 200,
    unattached: true,
    groupName: debouncedFilter.trim() || undefined,
  });

  const attach = trpc.huggingFaceImport.attach.useMutation();

  const listed = new Set(data.map((row) => row.id));
  // Only rows still on screen: an import attached in the last batch drops out of the list but
  // would otherwise stay selected, and the next click would attach it a second time.
  const chosen = Object.entries(selection)
    .map(([id, type]) => ({ id: Number(id), type }))
    .filter(
      (item): item is { id: number; type: ModelFileType } => !!item.type && listed.has(item.id)
    );

  const onAttach = async () => {
    setAttaching(true);
    const { modelFileIds, failures } = await attachImports({
      chosen,
      modelVersionId,
      attachOne: (input) => attach.mutateAsync(input),
    });
    try {
      await queryUtils.modelVersion.getByIdForEdit.invalidate({
        id: modelVersionId,
        withFiles: true,
      });
      await Promise.all([
        queryUtils.huggingFaceImport.getAll.invalidate(),
        queryUtils.huggingFaceImport.getCounts.invalidate(),
      ]);
      await adoptFiles(modelFileIds);

      if (failures.length) {
        // No auto-close: a lost import claim leaves a created file whose id appears only in this message.
        showErrorNotification({
          title: `Attached ${modelFileIds.length} of ${chosen.length}`,
          error: failures.map((message) => ({ message })),
          autoClose: false,
        });
        return;
      }
      showSuccessNotification({
        title: 'Attached',
        message: `${modelFileIds.length} file(s) added. Scanning starts on its own.`,
      });
      dialog.onClose();
    } catch (error) {
      // The attaches may have succeeded; silence here invites a second click.
      showErrorNotification({
        title: `Attached ${modelFileIds.length} of ${chosen.length}, but the file list could not be refreshed`,
        error: [
          error instanceof Error ? error : { message: String(error) },
          ...failures.map((message) => ({ message })),
        ],
        autoClose: false,
      });
    } finally {
      setAttaching(false);
    }
  };

  const groups = byGroup(data);

  return (
    <Modal {...dialog} title="Add from Hugging Face imports" size="lg" centered>
      <Stack gap="md">
        <TextInput
          placeholder="Filter by group name"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />

        {!groups.length ? (
          <Text c="dimmed" size="sm">
            {isLoading
              ? 'Loading…'
              : debouncedFilter.trim()
              ? `Nothing unattached matches "${debouncedFilter.trim()}".`
              : 'Nothing unattached — every transferred file is already on a version.'}
          </Text>
        ) : (
          groups.map((group) => (
            <Stack key={`${group.groupName}:${group.repo}:${group.revision}`} gap={6}>
              <Group gap="xs" wrap="wrap">
                <Text fw={600} size="sm">
                  {group.groupName}
                </Text>
                <Badge size="xs" variant="light" color="gray">
                  {group.repo}
                </Badge>
                <Badge size="xs" variant="light">
                  {group.revision.slice(0, 7)}
                </Badge>
              </Group>

              {group.items.map((row) => {
                const options = getModelFileTypeOptions(row.filename, { modelType });
                const type = selection[row.id] ?? null;
                const suggested = options.find((option) => option.value === row.suggestedType);
                return (
                  <Group key={row.id} gap="xs" pl="sm" wrap="nowrap" align="center">
                    <Text size="xs" ff="monospace" lineClamp={1} style={{ flex: 1 }}>
                      {row.filename}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {row.sizeBytes ? formatBytes(row.sizeBytes) : '—'}
                    </Text>
                    {/* The type IS the selection, so a suggestion is only ever a hint: pre-filling
                          it would attach every suggested file on the next click. */}
                    <Select
                      size="xs"
                      w={190}
                      clearable
                      data={options}
                      disabled={attaching}
                      placeholder={suggested ? `Suggested: ${suggested.label}` : 'Pick a file type'}
                      value={type}
                      onChange={(value) =>
                        setSelection((prev) => ({
                          ...prev,
                          [row.id]: (value as ModelFileType | null) ?? null,
                        }))
                      }
                    />
                  </Group>
                );
              })}
            </Stack>
          ))
        )}

        <Alert color="gray">
          <Text size="xs">
            A file is attached only once you give it a type. Nothing is pre-selected, and weights
            get no suggestion — the type decides whether this version loads.
          </Text>
        </Alert>

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button loading={attaching} disabled={!chosen.length} onClick={onAttach}>
            Attach {chosen.length || ''}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
