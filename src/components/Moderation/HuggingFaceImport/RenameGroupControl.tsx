import { ActionIcon, Button, Group, Popover, Stack, TextInput } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useState } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function RenameGroupControl({
  repo,
  revision,
  groupName,
}: {
  repo: string;
  revision: string;
  groupName: string;
}) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(groupName);
  const queryUtils = trpc.useUtils();

  const rename = trpc.huggingFaceImport.renameGroup.useMutation({
    onSuccess: async (result) => {
      setOpened(false);
      showSuccessNotification({
        title: 'Renamed',
        message: `${result.renamed} file(s) are now in "${result.groupName}".`,
      });
      await queryUtils.huggingFaceImport.getAll.invalidate();
      await queryUtils.huggingFaceImport.getCounts.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not rename', error: new Error(error.message) }),
  });

  const name = draft.trim();
  const submit = () => {
    if (!name || name === groupName) return;
    rename.mutate({ repo, revision, from: groupName, groupName: name });
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      shadow="md"
      // The theme defaults Popover to withinPortal: false, and this renders inside a Card.
      withinPortal
    >
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label="Rename group"
          title="Rename group"
          onClick={() => {
            setDraft(groupName);
            setOpened((open) => !open);
          }}
        >
          <IconPencil size={14} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" w={260}>
          <TextInput
            size="xs"
            label="Group name"
            value={draft}
            maxLength={120}
            data-autofocus
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <Group justify="flex-end">
            <Button
              size="compact-xs"
              loading={rename.isPending}
              disabled={!name || name === groupName}
              onClick={submit}
            >
              Rename
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
