import {
  ActionIcon,
  Box,
  Center,
  createStyles,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { IconSend, IconX } from '@tabler/icons-react';
import produce from 'immer';
import React, {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChatAllMessages } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// TODO handle enter key for send, shift enter for new line (when it matters)
// TODO handle scrolldown (ideally to last read)

const useStyles = createStyles((theme) => ({
  chatMessage: {
    borderRadius: theme.spacing.xs,
    padding: theme.spacing.xs,
    width: 'max-content',
    maxWidth: '70%',
  },
  otherMessage: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[2],
  },
  myDetails: {
    flexDirection: 'row-reverse',
  },
  myMessage: {
    // backgroundColor: theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.5),
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.blue[8] : theme.colors.blue[4],
    alignSelf: 'flex-end',
  },
}));

export function ExistingChat({
  setOpened,
  existingChat,
}: {
  setOpened: Dispatch<SetStateAction<boolean>>;
  existingChat: number;
}) {
  const currentUser = useCurrentUser();
  // TODO reset chat message when clicking different group
  const [chatMsg, setChatMsg] = useState<string>('');
  const [isSending, setIsSending] = useState(false);
  const lastReadRef = useRef<HTMLDivElement>(null);
  const debouncer = useDebouncer(1000);

  const { data, fetchNextPage, isLoading, isRefetching, hasNextPage } =
    trpc.chat.getInfiniteMessages.useInfiniteQuery(
      {
        chatId: existingChat,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        // keepPreviousData: true,
      }
    );

  const { data: allChatData, isLoading: allChatLoading } = trpc.chat.getAllByUser.useQuery();

  const { mutate } = trpc.chat.createMessage.useMutation({
    // TODO onMutate for optimistic
    async onSuccess(_data) {
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

  const { mutate: doIsTyping } = trpc.chat.isTyping.useMutation();

  const allChats = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  useEffect(() => {
    if (!allChats.length) return;
    // TODO this doesn't quite scroll all the way down, need to add some padding here
    lastReadRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' });
  }, [allChats]);

  const handleChatTyping = (value: string) => {
    setChatMsg(value);
    // handle not typing timeout
    // debouncer(() => doIsTyping({
    //   chatMemberId:
    // }));
  };

  // TODO handle replies (reference)
  const sendMessage = () => {
    // TODO can probably handle this earlier to disable from sending blank messages
    const strippedMessage = chatMsg.trim();
    if (!strippedMessage.length) {
      setChatMsg('');
      return;
    }

    setIsSending(true);
    mutate({
      chatId: existingChat,
      content: strippedMessage,
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
            {/*  TODO improve useravatar to show loading */}
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
      <Box p="sm" sx={{ flexGrow: 1, overflowY: 'auto' }}>
        {isRefetching || isLoading ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : allChats.length > 0 ? (
          <Stack sx={{ overflowWrap: 'break-word' }}>
            <DisplayMessages chats={allChats} lastReadRef={lastReadRef} />
            {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isRefetching} //  && hasNextPage
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
          sx={{ flexGrow: 1 }}
          placeholder="Send message"
          autosize
          minRows={1}
          maxRows={4}
          value={chatMsg}
          onChange={(event) => handleChatTyping(event.currentTarget.value)}
        />
        <ActionIcon h="100%" w={60} onClick={sendMessage} disabled={isSending || !chatMsg.length}>
          {isSending ? <Loader /> : <IconSend />}
        </ActionIcon>
      </Group>
    </Stack>
  );
}

function DisplayMessages({
  chats,
  lastReadRef,
}: {
  chats: ChatAllMessages;
  lastReadRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();

  // TODO adjust for lastread
  const lastReadId = chats[chats.length - 1].id;

  // TODO animation on new message received, not when getting all

  return (
    <>
      {chats.map((c) => (
        // TODO probably combine messages if within a certain amount of time
        <Stack ref={c.id === lastReadId ? lastReadRef : undefined} key={c.id}>
          <Group className={cx({ [classes.myDetails]: c.userId === currentUser?.id })}>
            <UserAvatar userId={c.userId} withUsername />
            <Text size="xs">{formatDate(c.createdAt, 'MMM DD, YYYY h:mm:ss a')}</Text>
          </Group>
          <Box
            className={cx(classes.chatMessage, {
              [classes.otherMessage]: c.userId !== currentUser?.id,
              [classes.myMessage]: c.userId === currentUser?.id,
            })}
          >
            {c.content}
          </Box>
        </Stack>
      ))}
      {/* TODO "x" is typing triple dot here */}
    </>
  );
}
