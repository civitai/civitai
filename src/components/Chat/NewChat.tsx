import { ActionIcon, Box, Button, Center, Divider, Group, Stack, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import React, { useState } from 'react';
import { ChatActions } from '~/components/Chat/ChatActions';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function NewChat() {
  const { state, setState } = useChatContext();
  const [isCreating, setIsCreating] = useState(false);
  const currentUser = useCurrentUser();

  const { mutate } = trpc.chat.createChat.useMutation({
    onSuccess: (data) => {
      if (!data) {
        showErrorNotification({
          title: 'Failed to fetch chat.',
          error: { message: 'Please try refreshing the page.' },
          autoClose: false,
        });
      }

      setIsCreating(false);
      if (data) setState((prev) => ({ ...prev, isCreating: false, existingChatId: data.id }));
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
      userIds: [...state.selectedUsers.map((u) => u.id!), currentUser.id],
    });
    // update query cache
  };

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart">
        <Text>New Chat</Text>
        <ChatActions />
      </Group>
      <Box px="sm">
        <QuickSearchDropdown
          supportedIndexes={['users']}
          onItemSelected={(_entity, item) => {
            const newUsers = [...state.selectedUsers, item as UserSearchIndexRecord];
            // TODO make this a constant
            if (newUsers.length > 9) {
              showErrorNotification({
                title: 'Maximum users reached',
                error: { message: 'You can select up to 9 users' },
                autoClose: false,
              });
              return;
            }
            setState((prev) => ({ ...prev, selectedUsers: newUsers }));
          }}
          dropdownItemLimit={25}
          showIndexSelect={false}
          startingIndex="users"
          placeholder="Select users"
          filters={
            state.selectedUsers.length > 0
              ? state.selectedUsers
                  .map((x) => `AND NOT id=${x.id}`)
                  .join(' ')
                  .slice(4)
              : undefined
          }
        />
      </Box>
      <Box p="sm" sx={{ flexGrow: 1 }}>
        {state.selectedUsers.length === 0 ? (
          <Center mt="md">
            <Text>Select at least 1 user above</Text>
          </Center>
        ) : (
          <Group>
            {state.selectedUsers.map((u) => (
              <Group key={u.id}>
                <UserAvatar user={u} size="md" withUsername />
                <ActionIcon
                  title="Remove user"
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      selectedUsers: state.selectedUsers.filter((su) => su.id !== u.id),
                    }))
                  }
                >
                  <IconX />
                </ActionIcon>
              </Group>
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
            setState((prev) => ({ ...prev, isCreating: false, selectedUsers: [] }));
          }}
        >
          Cancel
        </Button>
        <Button
          disabled={isCreating || state.selectedUsers.length === 0 || currentUser?.muted}
          onClick={handleNewChat}
        >
          Start Chat
        </Button>
      </Group>
    </Stack>
  );
}
