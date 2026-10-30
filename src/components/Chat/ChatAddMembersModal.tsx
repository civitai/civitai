import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { MAX_CHAT_MEMBERS } from '~/shared/utils/chat';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';
import type { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type PickedUser = SearchIndexDataMap['users'][number];

const openStatuses: ChatMemberStatus[] = [ChatMemberStatus.Invited, ChatMemberStatus.Joined];

export function ChatAddMembersModal({
  chatObj,
  opened,
  onClose,
}: {
  chatObj: ChatListMessage;
  opened: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<PickedUser[]>([]);
  const queryUtils = trpc.useUtils();

  const currentMembers = chatObj.chatMembers.filter((cm) => openStatuses.includes(cm.status));
  const seatsLeft = MAX_CHAT_MEMBERS - currentMembers.length;

  const close = () => {
    setSelected([]);
    onClose();
  };

  const { mutate, isPending } = trpc.chat.addUser.useMutation({
    onSuccess(data) {
      queryUtils.chat.getAllByUser.setData(undefined, (old) =>
        old?.map((c) => (c.id === data.id ? { ...c, chatMembers: data.chatMembers } : c))
      );
      close();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to add members.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const handleAdd = () => {
    if (!selected.length) return;
    mutate({ chatId: chatObj.id, userIds: selected.map((u) => u.id) });
  };

  const excluded = [...currentMembers.map((cm) => ({ id: cm.userId })), ...selected];

  return (
    <Modal opened={opened} onClose={close} title="Add members" centered>
      <Stack>
        {seatsLeft <= 0 ? (
          <Text size="sm">{`This group is full (${MAX_CHAT_MEMBERS} members).`}</Text>
        ) : (
          <>
            <QuickSearchDropdown
              disableInitialSearch
              supportedIndexes={['users']}
              onItemSelected={(_entity, item) => {
                if (selected.length >= seatsLeft) {
                  showErrorNotification({
                    title: 'Maximum members reached',
                    error: {
                      message: `You can add ${seatsLeft} more ${
                        seatsLeft === 1 ? 'member' : 'members'
                      }`,
                    },
                    autoClose: false,
                  });
                  return;
                }
                setSelected((prev) => [...prev, item as PickedUser]);
              }}
              dropdownItemLimit={25}
              showIndexSelect={false}
              startingIndex="users"
              placeholder="Select users"
              filters={excluded
                .map((x) => `AND NOT id=${x.id}`)
                .join(' ')
                .slice(4)}
            />
            {selected.length > 0 && (
              <Group>
                {selected.map((u) => (
                  <Group key={u.id} gap="xs">
                    <UserAvatar user={u} size="md" withUsername />
                    <LegacyActionIcon
                      title="Remove user"
                      onClick={() => setSelected((prev) => prev.filter((su) => su.id !== u.id))}
                    >
                      <IconX />
                    </LegacyActionIcon>
                  </Group>
                ))}
              </Group>
            )}
          </>
        )}
        <Group justify="flex-end">
          <Button variant="light" color="gray" onClick={close}>
            Cancel
          </Button>
          <Button disabled={isPending || !selected.length} onClick={handleAdd}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
