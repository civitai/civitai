import { ActionIcon, Alert, Box, Button, Center, Divider, Group, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconCheck, IconX } from '@tabler/icons-react';
import React, { useState } from 'react';
import { ChatActions } from '~/components/Chat/ChatActions';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function NewChat() {
  const { state, setState } = useChatContext();
  const [isCreating, setIsCreating] = useState(false);
  const [acking, setAcking] = useState(false);
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-chat-terms',
    defaultValue: window?.localStorage?.getItem('review-chat-terms') === 'true',
  });

  const userSettings = queryUtils.chat.getUserSettings.getData();
  // TODO this is not perfect, it won't set local storage on another device if you've already accepted
  const acked = reviewed || (userSettings?.acknowledged ?? false);

  const { mutate: modifySettings } = trpc.chat.setUserSettings.useMutation({
    onSuccess(data) {
      queryUtils.chat.getUserSettings.setData(undefined, (old) => {
        if (!old) return old;
        return data;
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update settings.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
    onSettled() {
      setAcking(false);
    },
  });

  const { mutate } = trpc.chat.createChat.useMutation({
    onSuccess: (data) => {
      if (!data) {
        showErrorNotification({
          title: 'Failed to fetch chat.',
          error: { message: 'Please try refreshing the page.' },
          autoClose: false,
        });
      }

      if (data) {
        queryUtils.chat.getAllByUser.setData(undefined, (old) => {
          if (!old) return [data];
          if (old.find((o) => o.id === data.id)) return old;
          return [{ ...data, createdAt: new Date(data.createdAt) }, ...old];
        });

        setState((prev) => ({
          ...prev,
          isCreating: false,
          selectedUsers: [],
          existingChatId: data.id,
        }));
      }

      setIsCreating(false);
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

  const handleAck = () => {
    setAcking(true);
    setReviewed(true);
    modifySettings({
      acknowledged: true,
    });
  };

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
  };

  if (!acked) {
    return (
      <Stack justify="center" h="100%">
        <Alert m={16} color="yellow" title="Chat Terms">
          <Text size="xs">
            Chats are inspected by automated systems, and moderators have full access to chat logs.
            Discussion of illegal activities, or the sharing of illegal image content, harassment of
            other users, or unwanted solicitation will not be tolerated and may result in account
            suspension or deletion.
          </Text>
          <Button
            color="yellow"
            variant="light"
            onClick={handleAck}
            leftIcon={<IconCheck />}
            mt={10}
            fullWidth
            disabled={acking}
          >
            Got it
          </Button>
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart">
        <Text>New Chat</Text>
        <ChatActions />
      </Group>
      <Box px="sm">
        <QuickSearchDropdown
          disableInitialSearch
          supportedIndexes={['users']}
          onItemSelected={(_entity, item) => {
            const newUsers = [...state.selectedUsers, item as SearchIndexDataMap['users'][number]];
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
          filters={[{ id: currentUser?.id }, ...state.selectedUsers]
            .map((x) => `AND NOT id=${x.id}`)
            .join(' ')
            .slice(4)}
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
