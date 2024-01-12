import {
  ActionIcon,
  Box,
  Button,
  Center,
  createStyles,
  Divider,
  Grid,
  Group,
  Input,
  Loader,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import {
  IconCirclePlus,
  IconSearch,
  IconSend,
  IconUser,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import React, { type Dispatch, type SetStateAction, useMemo, useState } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  selectChat: {
    cursor: 'pointer',
    borderRadius: theme.spacing.xs,
    padding: theme.spacing.xs,
    paddingTop: '6px',
    paddingBottom: '6px',
    '&:hover': {
      backgroundColor: theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.2),
    },
  },
  selectedChat: {
    backgroundColor: `${theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.5)} !important`,
  },
}));

export function ChatWindow({ setOpened }: { setOpened: Dispatch<SetStateAction<boolean>> }) {
  const [newChat, setNewChat] = useState(true);
  const [existingChat, setExistingChat] = useState<number | undefined>(undefined);

  return (
    <Grid h="100%" m={0}>
      {/* List and Search Panel */}
      <Grid.Col span={4} p={0} style={{ borderRight: '1px solid #373A40' }}>
        <ChatList
          existingChat={existingChat}
          setNewChat={setNewChat}
          setExistingChat={setExistingChat}
        />
      </Grid.Col>
      {/* Chat Panel */}
      <Grid.Col span={8} p={0}>
        {newChat || !existingChat ? (
          <NewChat
            setOpened={setOpened}
            setNewChat={setNewChat}
            setExistingChat={setExistingChat}
          />
        ) : (
          <ExistingChat setOpened={setOpened} existingChat={existingChat} />
        )}
      </Grid.Col>
    </Grid>
  );
}

function ChatList({
  existingChat,
  setNewChat,
  setExistingChat,
}: {
  existingChat: number | undefined;
  setNewChat: Dispatch<SetStateAction<boolean>>;
  setExistingChat: Dispatch<SetStateAction<number | undefined>>;
}) {
  const { data, isLoading } = trpc.chat.getAllByUser.useQuery();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart" align="center">
        <Text>Chats</Text>
        <ActionIcon>
          <IconCirclePlus onClick={() => setNewChat(true)} />
        </ActionIcon>
      </Group>
      {/*<Divider />*/}
      <Box p="sm" pt={0}>
        <Input
          icon={<IconSearch size={16} />}
          placeholder="Search"
          rightSection={
            <ActionIcon onClick={() => {}}>
              <IconX size={16} />
            </ActionIcon>
          }
        />
      </Box>
      <Divider />
      <Box h="100%">
        {isLoading ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : !data || data.length === 0 ? (
          <Stack p="sm">
            <Text>No chats.</Text>
            <Text>Get started by hitting the &quot;plus&quot;sign above.</Text>
          </Stack>
        ) : (
          <Stack p="xs" spacing={4}>
            {data.map((d) => {
              return (
                <Group
                  key={d.id}
                  noWrap
                  className={cx(classes.selectChat, {
                    [classes.selectedChat]: d.id === existingChat,
                  })}
                  onClick={() => {
                    setExistingChat(d.id);
                    setNewChat(false);
                  }}
                >
                  <Box>{d.chatMembers.length > 2 ? <IconUsers /> : <IconUser />}</Box>
                  <Stack sx={{ overflow: 'hidden' }} spacing={0}>
                    <Text
                      size="sm"
                      fw={500}
                      sx={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        minWidth: 0,
                      }}
                    >
                      {d.chatMembers
                        .filter((cm) => cm.userId !== currentUser?.id)
                        .map((cm) => cm.user.username)
                        .join(', ')}
                    </Text>
                    {!!d.messages[0]?.content && (
                      <Text
                        size="xs"
                        fs="italic"
                        sx={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          minWidth: 0,
                        }}
                      >
                        {d.messages[0].content}
                      </Text>
                    )}
                  </Stack>
                </Group>
                // </Button>
              );
            })}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

function NewChat({
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
      <Box p="sm" style={{ flexGrow: 1 }}>
        {selectedUsers.length === 0 ? (
          <Text>Select at least 1 user above</Text>
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

function ExistingChat({
  setOpened,
  existingChat,
}: {
  setOpened: Dispatch<SetStateAction<boolean>>;
  existingChat: number;
}) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [chatMsg, setChatMsg] = useState<string>('');
  const [isSending, setIsSending] = useState(false);

  const { data, isLoading, fetchNextPage, isRefetching, hasNextPage } =
    trpc.chat.getInfiniteMessages.useInfiniteQuery(
      {
        chatId: existingChat,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        keepPreviousData: true,
      }
    );

  const { data: allChatData, isLoading: allChatLoading } = trpc.chat.getAllByUser.useQuery();

  const { mutate } = trpc.chat.createMessage.useMutation({
    // TODO onMutate for optimistic
    async onSuccess(data) {
      await queryUtils.chat.getInfiniteMessages.cancel();

      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId: existingChat },
        produce((old) => {
          if (!old) {
            return {
              pages: [],
              pageParams: [],
            };
          }

          const lastPage = old.pages[old.pages.length - 1];

          lastPage.items.push(data);
        })
      );
      setIsSending(false);
      setChatMsg('');
    },
    onError(error) {
      setIsSending(false);
      showErrorNotification({
        title: 'Failed to send message.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const allChats = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  const handleChatTyping = (value: string) => {
    setChatMsg(value);
    // TODO: send signal for isTyping, debounced
  };

  // TODO handle replies (reference)
  const sendMessage = () => {
    setIsSending(true);
    mutate({
      chatId: existingChat,
      content: chatMsg,
    });
  };

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart" noWrap>
        {allChatLoading ? (
          <Loader />
        ) : (
          <Group>
            {/* TODO limit this to one line, then expand */}
            {/* TODO option to add users, maybe in an option icon next to X */}
            {allChatData
              ?.find((c) => c.id === existingChat)
              ?.chatMembers.filter((cm) => cm.userId !== currentUser?.id)
              .map((cm) => (
                <UserAvatar
                  key={cm.userId}
                  userId={cm.userId}
                  size="sm"
                  withUsername
                  linkToProfile
                />
              ))}
          </Group>
        )}
        <ActionIcon onClick={() => setOpened(false)}>
          <IconX />
        </ActionIcon>
      </Group>
      <Divider />
      <Box p="sm" style={{ flexGrow: 1 }}>
        {isLoading ? (
          <Center>
            <Loader />
          </Center>
        ) : allChats.length > 0 ? (
          <Stack>
            {allChats.map((c) => (
              // TODO avatar, name, message
              //  left if others, right if you, also blue
              //  time
              <Text key={c.id}>{c.content}</Text>
            ))}
            {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isRefetching}
                style={{ gridColumn: '1/-1' }}
              >
                <Center p="xl" sx={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )}
          </Stack>
        ) : (
          <Center h="100%">
            <Text>Start the conversation below!</Text>
          </Center>
        )}
      </Box>
      <Divider />
      <Group spacing={0}>
        <Textarea
          style={{ flexGrow: 1 }}
          placeholder="Send message"
          autosize
          minRows={1}
          maxRows={4}
          value={chatMsg}
          onChange={(event) => handleChatTyping(event.currentTarget.value)}
        />
        <ActionIcon h="100%" w={60} onClick={sendMessage} disabled={isSending}>
          {isSending ? <Loader /> : <IconSend />}
        </ActionIcon>
      </Group>
    </Stack>
  );
}
