import { Alert, Box, Button, Center, Divider, Group, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { ChatActions } from '~/components/Chat/ChatActions';
import { useChatStore } from '~/components/Chat/ChatContext';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function NewChat() {
  const selectedUsers = useChatStore((state) => state.selectedUsers);
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

        useChatStore.setState({
          isCreating: false,
          selectedUsers: [],
          existingChatId: data.id,
        });
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
      userIds: [...selectedUsers.map((u) => u.id!), currentUser.id],
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
            leftSection={<IconCheck />}
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
    <Stack gap={0} h="100%">
      <Group p="sm" justify="space-between">
        <Text>New Chat</Text>
        <ChatActions />
      </Group>
      <Box px="sm">
        <QuickSearchDropdown
          disableInitialSearch
          supportedIndexes={['users']}
          onItemSelected={(_entity, item) => {
            const newUsers = [...selectedUsers, item as SearchIndexDataMap['users'][number]];
            // TODO make this a constant
            if (newUsers.length > 9) {
              showErrorNotification({
                title: 'Maximum users reached',
                error: { message: 'You can select up to 9 users' },
                autoClose: false,
              });
              return;
            }
            useChatStore.setState({ selectedUsers: newUsers });
          }}
          dropdownItemLimit={25}
          showIndexSelect={false}
          startingIndex="users"
          placeholder="Select users"
          filters={[{ id: currentUser?.id }, ...selectedUsers]
            .map((x) => `AND NOT id=${x.id}`)
            .join(' ')
            .slice(4)}
        />
      </Box>
      <Box p="sm" style={{ flexGrow: 1 }}>
        {selectedUsers.length === 0 ? (
          <Center mt="md">
            <Text>Select at least 1 user above</Text>
          </Center>
        ) : (
          <Group>
            {selectedUsers.map((u) => (
              <Group key={u.id}>
                <UserAvatar user={u} size="md" withUsername />
                <LegacyActionIcon
                  title="Remove user"
                  onClick={() =>
                    useChatStore.setState((state) => ({
                      selectedUsers: state.selectedUsers.filter((su) => su.id !== u.id),
                    }))
                  }
                >
                  <IconX />
                </LegacyActionIcon>
              </Group>
            ))}
          </Group>
        )}
      </Box>
      <Divider />
      <Group p="sm" justify="center">
        <Button
          disabled={isCreating}
          variant="light"
          color="gray"
          onClick={() => {
            useChatStore.setState({ isCreating: false, selectedUsers: [] });
          }}
        >
          Cancel
        </Button>
        <Button
          disabled={isCreating || selectedUsers.length === 0 || currentUser?.muted}
          onClick={handleNewChat}
        >
          Start Chat
        </Button>
      </Group>
    </Stack>
  );
}
