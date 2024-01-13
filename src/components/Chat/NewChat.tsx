import { ActionIcon, Box, Button, Center, Divider, Group, Stack, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import React, { Dispatch, SetStateAction, useState } from 'react';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function NewChat({
  setOpened,
  setNewChat,
  setExistingChat,
}: {
  setOpened: Dispatch<SetStateAction<boolean>>;
  setNewChat: Dispatch<SetStateAction<boolean>>;
  setExistingChat: Dispatch<SetStateAction<number | undefined>>;
}) {
  const [selectedUsers, setSelectedUsers] = useState<UserSearchIndexRecord[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const { mutate } = trpc.chat.createChat.useMutation({
    onSuccess: (data) => {
      if (!data) {
        showErrorNotification({
          title: 'Failed to fetch chat.',
          error: { message: 'Please try refreshing the page.' },
          autoClose: false,
        });
      } else {
        queryUtils.chat.getAllByUser.setData(undefined, (old) => {
          if (!('hash' in data)) {
            // chat already exists
            if (!old) return [];
            return old;
          } else {
            // proper typing would be nice but typescript is being cranky
            if (!old) return [data] as any;
          }
          return [data, ...old];
        });
      }

      setNewChat(false);
      setIsCreating(false);
      if (data) setExistingChat(data.id);
    },
    onError(error) {
      setIsCreating(false);
      showErrorNotification({
        title: 'Failed to create chat.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const handleNewChat = () => {
    setIsCreating(true);
    if (!currentUser) {
      showErrorNotification({
        title: 'Failed to create chat.',
        error: { message: 'User is not logged in' },
        autoClose: false,
      });
      return;
    }
    mutate({
      userIds: [...selectedUsers.map((u) => u.id), currentUser.id],
    });
    // update query cache
  };

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart">
        <Text>New Chat</Text>
        <ActionIcon onClick={() => setOpened(false)}>
          <IconX />
        </ActionIcon>
      </Group>
      <QuickSearchDropdown
        supportedIndexes={['users']}
        onItemSelected={(_entity, item) => {
          console.log(item);
          const newUsers = [...selectedUsers, item as UserSearchIndexRecord];
          // TODO make this a constant
          if (newUsers.length > 9) {
            showErrorNotification({
              title: 'Maximum users reached',
              error: { message: 'You can select up to 9 users' },
              autoClose: false,
            });
            return;
          }
          setSelectedUsers(newUsers);
        }}
        dropdownItemLimit={25}
        showIndexSelect={false}
        startingIndex="users"
        placeholder="Select users"
        filters={
          selectedUsers.length > 0
            ? selectedUsers
                .map((x) => `AND NOT id=${x.id}`)
                .join(' ')
                .slice(4)
            : undefined
        }
      />
      <Box p="sm" sx={{ flexGrow: 1 }}>
        {selectedUsers.length === 0 ? (
          <Center mt="md">
            <Text>Select at least 1 user above</Text>
          </Center>
        ) : (
          <Group>
            {/* TODO need removal option*/}
            {selectedUsers.map((u) => (
              <UserAvatar key={u.id} user={u} size="md" withUsername />
            ))}
          </Group>
        )}
      </Box>
      <Divider />
      <Group p="sm" position="center">
        <Button
          disabled={isCreating}
          variant="light"
          color="gray"
          onClick={() => {
            setNewChat(false);
            setSelectedUsers([]);
          }}
        >
          Cancel
        </Button>
        <Button disabled={isCreating} onClick={handleNewChat}>
          Start Chat
        </Button>
      </Group>
    </Stack>
  );
}
