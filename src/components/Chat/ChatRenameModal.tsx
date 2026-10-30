import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { MAX_CHAT_NAME_LENGTH } from '~/server/schema/chat.schema';
import type { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ChatRenameModal({
  chatObj,
  opened,
  onClose,
}: {
  chatObj: ChatListMessage;
  opened: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(chatObj.name ?? '');
  const queryUtils = trpc.useUtils();

  // Reopening after someone else renamed the group should show their name, not
  // the one this component first mounted with.
  useEffect(() => {
    if (opened) setName(chatObj.name ?? '');
  }, [opened, chatObj.name]);

  const { mutate, isPending } = trpc.chat.updateChat.useMutation({
    onSuccess(data) {
      queryUtils.chat.getAllByUser.setData(undefined, (old) =>
        old?.map((c) => (c.id === data.id ? { ...c, name: data.name } : c))
      );
      onClose();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to rename group.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Rename group" centered>
      <Stack>
        <TextInput
          label="Group name"
          placeholder="Leave blank to use the member list"
          value={name}
          maxLength={MAX_CHAT_NAME_LENGTH}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isPending) mutate({ chatId: chatObj.id, name });
          }}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="light" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={isPending} onClick={() => mutate({ chatId: chatObj.id, name })}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
