import { Anchor, Button, Group, NumberInput, Popover, Select, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { constants } from '~/server/common/constants';
import { filterFileTypeByExtension } from '~/utils/file-display-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The same filter the upload UI and the merge-versions modal use — it keeps retired types out of new
 * pickers and refuses types the extension cannot be. A hand-written list here would be a fourth copy
 * of the file-type rules.
 */
function typeOptions(filename: string) {
  return constants.modelFileTypes.filter((type) => filterFileTypeByExtension(type, filename));
}

export function AttachControl({
  importId,
  filename,
  suggestedType,
  modelFileId,
  modelVersionId,
}: {
  importId: number;
  filename: string;
  suggestedType: string | null;
  modelFileId: number | null;
  modelVersionId: number | null;
}) {
  const [opened, setOpened] = useState(false);
  const [versionId, setVersionId] = useState<number | ''>('');
  const options = typeOptions(filename);
  const [type, setType] = useState<string | null>(
    suggestedType && options.includes(suggestedType as never) ? suggestedType : options[0] ?? null
  );
  const queryUtils = trpc.useUtils();

  const attach = trpc.huggingFaceImport.attach.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Attached',
        message: `File ${result.modelFileId} added to version ${result.modelVersionId}. The scan starts on its own.`,
      });
      setOpened(false);
      await queryUtils.huggingFaceImport.getAll.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not attach', error: new Error(error.message) }),
  });

  if (modelFileId)
    return (
      <Anchor
        size="xs"
        target="_blank"
        href={`/models/v/${modelVersionId}`}
        title={`Model file ${modelFileId}`}
      >
        version {modelVersionId}
      </Anchor>
    );

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      // The theme defaults Popover to withinPortal: false, and this renders inside a Card and a
      // scroll container — both of which clip it.
      withinPortal
    >
      <Popover.Target>
        <Button size="compact-xs" variant="light" onClick={() => setOpened((o) => !o)}>
          Attach
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" w={240}>
          <Text size="xs" c="dimmed">
            Creates a model file on that version. Scanning and hashing follow automatically.
          </Text>
          <NumberInput
            size="xs"
            label="Model version ID"
            value={versionId}
            onChange={(value) => setVersionId(typeof value === 'number' ? value : '')}
            min={1}
            allowDecimal={false}
            hideControls
          />
          <Select size="xs" label="File type" data={options} value={type} onChange={setType} />
          <Group justify="flex-end">
            <Button
              size="compact-xs"
              loading={attach.isPending}
              disabled={!versionId || !type}
              onClick={() =>
                versionId &&
                type &&
                attach.mutate({ id: importId, modelVersionId: versionId, type: type as never })
              }
            >
              Attach
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
