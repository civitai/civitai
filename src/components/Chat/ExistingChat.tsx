import {
  ActionIcon,
  Box,
  Button,
  Center,
  createPolymorphicComponent,
  createStyles,
  Divider,
  Group,
  Loader,
  Stack,
  StackProps,
  Text,
  Textarea,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { ChatMemberStatus } from '@prisma/client';
import { IconSend } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import produce from 'immer';
import { throttle } from 'lodash-es';
import Link from 'next/link';
import React, {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGemoji from 'remark-gemoji';
import remarkGfm from 'remark-gfm';
import { ChatActions } from '~/components/Chat/ChatActions';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SignalMessages } from '~/server/common/enums';
import { isTypingOutput } from '~/server/schema/chat.schema';
import { ChatAllMessages } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

type TypingStatus = {
  [key: string]: boolean;
};

const PStack = createPolymorphicComponent<'div', StackProps>(Stack);

const useStyles = createStyles((theme) => ({
  chatMessage: {
    borderRadius: theme.spacing.xs,
    padding: `${theme.spacing.xs / 2}px ${theme.spacing.xs}px`,
    width: 'max-content',
    maxWidth: '70%',
    whiteSpace: 'pre-line',
  },
  myDetails: {
    flexDirection: 'row-reverse',
  },
  myMessage: {
    // backgroundColor: theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.5),
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.blue[8] : theme.colors.blue[4],
    alignSelf: 'flex-end',
  },
  otherMessage: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[2],
  },
  chatInput: {
    borderRadius: 0,
    borderLeft: 0,
    borderTop: 0,
    borderBottom: 0,
  },
  isTypingBox: {
    position: 'sticky',
    bottom: 0,
    backdropFilter: 'blur(16px)',
    display: 'inline-flex',
    // backgroundColor:
    //   theme.colorScheme === 'dark'
    //     ? theme.fn.rgba(theme.colors.green[7], 0.1)
    //     : theme.fn.rgba(theme.colors.green[2], 0.1),
  },
}));

export function ExistingChat({
  setOpened,
  existingChat,
  setNewChat,
  setExistingChat,
}: {
  setOpened: Dispatch<SetStateAction<boolean>>;
  existingChat: number;
  setNewChat: Dispatch<SetStateAction<boolean>>;
  setExistingChat: Dispatch<SetStateAction<number | undefined>>;
}) {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const { connected, worker } = useSignalContext();
  const queryUtils = trpc.useUtils();

  const lastReadRef = useRef<HTMLDivElement>(null);
  // TODO reset chat message when clicking different group
  const [chatMsg, setChatMsg] = useState<string>('');
  const [debouncedChatMsg] = useDebouncedValue(chatMsg, 2000);
  const [isSending, setIsSending] = useState(false);
  const [typingStatus, setTypingStatus] = useState<TypingStatus>({});
  const [typingText, setTypingText] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);

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

  const thisChat = allChatData?.find((c) => c.id === existingChat);
  const myMember = thisChat?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const otherMembers = thisChat?.chatMembers.filter((cm) => cm.userId !== currentUser?.id);

  const { mutate: modifyMembership } = trpc.chat.modifyUser.useMutation({
    onSuccess(data) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          if (data.status !== ChatMemberStatus.Joined) {
            return old.filter((c) => c.id !== existingChat);
          }

          const tChat = old.find((c) => c.id === existingChat);
          const tMember = tChat?.chatMembers?.find((cm) => cm.userId === data.userId);
          if (!tMember) return old;

          tMember.status = data.status;
          tMember.joinedAt = data.joinedAt;
        })
      );
      setIsJoining(false);
      if (data.status !== ChatMemberStatus.Joined) {
        setExistingChat(undefined);
        setNewChat(true);
      }
    },
    onError(error) {
      setIsJoining(false);
      showErrorNotification({
        title: 'Failed to update chat membership.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const handleIgnoreChat = () => {
    if (!myMember || !currentUser) {
      showErrorNotification({
        title: 'Failed to update chat membership.',
        error: new Error('Could not find membership or user'),
        autoClose: false,
      });
      return;
    }
    setIsJoining(true);
    modifyMembership({
      chatMemberId: myMember.id,
      status: ChatMemberStatus.Ignored,
    });
  };

  const handleJoinChat = () => {
    if (!myMember || !currentUser) {
      showErrorNotification({
        title: 'Failed to update chat membership.',
        error: new Error('Could not find membership or user'),
        autoClose: false,
      });
      return;
    }
    setIsJoining(true);
    modifyMembership({
      chatMemberId: myMember.id,
      status: ChatMemberStatus.Joined,
    });
  };

  const { mutate } = trpc.chat.createMessage.useMutation({
    // TODO onMutate for optimistic
    onSuccess() {
      setIsSending(false);
      setChatMsg('');

      if (!currentUser) return;

      const newEntry = {
        [currentUser.username]: false,
      };
      const { newTotalStatus, isTypingText } = getTypingStatus(newEntry);

      setTypingStatus(newTotalStatus);
      setTypingText(isTypingText);
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

  const { mutateAsync: doIsTyping } = trpc.chat.isTyping.useMutation();

  const allChats = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  useEffect(() => {
    if (!allChats.length) return;

    lastReadRef.current?.scrollTo(
      0,
      lastReadRef.current?.scrollHeight - lastReadRef.current?.clientHeight
    );
  }, [allChats]);

  useEffect(() => {
    setTypingStatus({});
    setTypingText(null);
  }, [existingChat]);

  function getTypingStatus(newEntry: { [p: string]: boolean }) {
    const newTotalStatus = { ...typingStatus, ...newEntry };

    const isTypingArray = Object.entries(newTotalStatus)
      .map(([tsU, tsV]) => {
        if (tsV) return tsU;
      })
      .filter(isDefined);

    // TODO this sometimes flips back and forth for multiple users, overwriting itself. why?
    const isTypingText =
      isTypingArray.length > 1
        ? `${isTypingArray.length} people are typing`
        : isTypingArray.length === 1
        ? `${isTypingArray[0]} is typing`
        : null;
    return { newTotalStatus, isTypingText };
  }

  const handleIsTyping = useCallback(
    (d: unknown) => {
      const data = d as isTypingOutput;

      if (data.userId === currentUser?.id) return;
      if (data.chatId !== existingChat) return;

      const newEntry = {
        [data.username]: data.isTyping,
      };

      const { newTotalStatus, isTypingText } = getTypingStatus(newEntry);

      setTypingStatus(newTotalStatus);
      setTypingText(isTypingText);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [existingChat]
  );

  useEffect(() => {
    if (connected && worker) {
      worker.on(SignalMessages.ChatTypingStatus, handleIsTyping);
    }

    return () => {
      worker?.off(SignalMessages.ChatTypingStatus, handleIsTyping);
    };
  }, [connected, worker, handleIsTyping]);

  useEffect(() => {
    if (!currentUser) return;

    doIsTyping({
      chatId: existingChat,
      userId: currentUser?.id,
      isTyping: false,
    }).catch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedChatMsg]);

  const throttledTyping = useMemo(
    () =>
      throttle(
        () => {
          if (!currentUser) return;
          doIsTyping({
            chatId: existingChat,
            userId: currentUser.id,
            isTyping: true,
          }).catch();
        },
        2000,
        { leading: true, trailing: true }
      ),
    [currentUser, doIsTyping, existingChat]
  );

  const handleChatTyping = (value: string) => {
    setChatMsg(value);
    if (!currentUser) return;

    // only send signal if they're not erasing the chat
    if (value.length) {
      throttledTyping();
    }
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
            {/* TODO improve useravatar to show loading */}
            {/* TODO mark when a user is the owner, online status (later), blocked users, etc */}
            {otherMembers?.map((cm) => (
              <UserAvatar key={cm.userId} userId={cm.userId} size="sm" withUsername linkToProfile />
            ))}
          </Group>
        )}
        <ChatActions
          setOpened={setOpened}
          setNewChat={setNewChat}
          setExistingChat={setExistingChat}
          chatObj={thisChat}
        />
      </Group>
      <Divider />
      {!myMember ? (
        <Loader />
      ) : myMember.status === ChatMemberStatus.Joined ? (
        <>
          <Box p="sm" sx={{ flexGrow: 1, overflowY: 'auto' }} ref={lastReadRef}>
            {isRefetching || isLoading ? (
              <Center h="100%">
                <Loader />
              </Center>
            ) : allChats.length > 0 ? (
              <Stack sx={{ overflowWrap: 'break-word' }}>
                <DisplayMessages chats={allChats} />
                {hasNextPage && (
                  <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && hasNextPage}>
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
            {!!typingText && (
              <Group className={classes.isTypingBox}>
                <Text size="xs">{typingText}</Text>
                <Loader variant="dots" />
              </Group>
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
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (!e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }
              }}
              classNames={{ input: classes.chatInput }} // should test this border more with active highlighting
            />
            <ActionIcon
              h="100%"
              w={60}
              onClick={sendMessage}
              disabled={isSending || !chatMsg.length}
              sx={{ borderRadius: 0 }}
            >
              {isSending ? <Loader /> : <IconSend />}
            </ActionIcon>
          </Group>
        </>
      ) : myMember.status === ChatMemberStatus.Invited ? (
        <Center h="100%">
          <Stack>
            <Text align="center">Join the chat?</Text>
            <Group p="sm" position="center">
              <Button disabled={isJoining} variant="light" color="gray" onClick={handleIgnoreChat}>
                Ignore
              </Button>
              <Button disabled={isJoining} onClick={handleJoinChat}>
                Join
              </Button>
            </Group>
          </Stack>
        </Center>
      ) : (
        // TODO show old messages if kicked/left?
        <Center h="100%">
          <Text>Not a member of this chat.</Text>
        </Center>
      )}
    </Stack>
  );
}

function DisplayMessages({ chats }: { chats: ChatAllMessages }) {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();

  return (
    <AnimatePresence initial={false} mode="sync">
      {chats.map((c, idx) => (
        // TODO probably combine messages if within a certain amount of time
        <PStack
          component={motion.div}
          // ref={c.id === lastReadId ? lastReadRef : undefined}
          key={c.id}
          spacing="xs"
          style={idx === chats.length - 1 ? { marginBottom: 12 } : {}}
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', duration: 0.4 }}
        >
          {c.userId === -1 ? (
            // <Group align="center" position="center">
            //   <Text size="xs">{formatDate(c.createdAt)}</Text>
            //   <Text
            //     className={cx(classes.chatMessage)}
            //     size="xs"
            //     py={0}
            //     sx={{
            //       // alignSelf: 'center',
            //       border: '1px solid gray',
            //     }}
            //   >
            //     {c.content}
            //   </Text>
            // </Group>
            <Text
              className={cx(classes.chatMessage)}
              size="xs"
              py={0}
              sx={{
                alignSelf: 'center',
                border: '1px solid gray',
              }}
            >
              {c.content}
            </Text>
          ) : (
            <>
              <Group className={cx({ [classes.myDetails]: c.userId === currentUser?.id })}>
                <UserAvatar userId={c.userId} withUsername />
                <Text size="xs">{formatDate(c.createdAt, 'MMM DD, YYYY h:mm:ss a')}</Text>
              </Group>
              {/* TODO this should match the text writer, autoformatting as its entered and selecting emojis */}
              <ReactMarkdown
                allowedElements={['a', 'strong', 'em', 'code', 'u', 'img', 'ul', 'li']} // TODO check more of these: 'pre'
                rehypePlugins={[rehypeRaw, remarkGfm, remarkGemoji]}
                unwrapDisallowed
                components={{
                  a: ({ node, ...props }) => {
                    return (
                      <Link href={props.href as string}>
                        <a target={props.href?.includes('http') ? '_blank' : '_self'}>
                          {props.children[0]}
                        </a>
                      </Link>
                    );
                  },
                }}
                className={cx(classes.chatMessage, 'markdown-content', {
                  [classes.otherMessage]: c.userId !== currentUser?.id,
                  [classes.myMessage]: c.userId === currentUser?.id,
                })}
              >
                {c.content}
              </ReactMarkdown>
            </>
          )}
        </PStack>
      ))}
    </AnimatePresence>
  );
}
