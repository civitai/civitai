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
  useMantineTheme,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { ChatMemberStatus } from '@prisma/client';
import {
  IconChevronLeft,
  IconCircleCheck,
  IconCircleMinus,
  IconCircleX,
  IconCrown,
  IconSend,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import produce from 'immer';
import { throttle } from 'lodash-es';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatActions } from '~/components/Chat/ChatActions';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
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

export function ExistingChat() {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const { connected, worker } = useSignalContext();
  const { state, setState } = useChatContext();
  const queryUtils = trpc.useUtils();
  const mobile = useIsMobile();
  const theme = useMantineTheme();

  const lastReadRef = useRef<HTMLDivElement>(null);
  const [chatMsg, setChatMsg] = useState<string>('');
  const [debouncedChatMsg] = useDebouncedValue(chatMsg, 2000);
  const [isSending, setIsSending] = useState(false);
  const [typingStatus, setTypingStatus] = useState<TypingStatus>({});
  const [typingText, setTypingText] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  // const oldPagesLength = useRef(1);

  // TODO there is a bug here. upon rejoining, you won't get a signal for the messages in the timespan between leaving and rejoining
  const { data, fetchNextPage, isLoading, isRefetching, hasNextPage } =
    trpc.chat.getInfiniteMessages.useInfiniteQuery(
      {
        chatId: state.existingChatId!,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        select: (data) => ({
          pages: [...data.pages].reverse(),
          pageParams: [...data.pageParams].reverse(),
        }),
      }
    );

  const { data: allChatData, isLoading: allChatLoading } = trpc.chat.getAllByUser.useQuery();

  const thisChat = allChatData?.find((c) => c.id === state.existingChatId);
  const myMember = thisChat?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const otherMembers = thisChat?.chatMembers.filter((cm) => cm.userId !== currentUser?.id);
  // const lastViewed = myMember?.lastViewedMessageId;

  const { mutateAsync: changeLastViewed } = trpc.chat.modifyUser.useMutation({
    onMutate(data) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const tChat = old.find((c) => c.id === state.existingChatId);
          const tMember = tChat?.chatMembers?.find((cm) => cm.userId === currentUser?.id);
          if (!tMember) return old;

          tMember.lastViewedMessageId = data.lastViewedMessageId ?? null;
        })
      );
      queryUtils.chat.getUnreadCount.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const tChat = old.find((c) => c.chatId === state.existingChatId);
          if (!tChat) return old;

          tChat.cnt = 0;
        })
      );
    },
  });

  const { mutate: modifyMembership } = trpc.chat.modifyUser.useMutation({
    onSuccess(data) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const tChat = old.find((c) => c.id === state.existingChatId);
          const tMember = tChat?.chatMembers?.find((cm) => cm.userId === data.userId);
          if (!tMember) return old;

          tMember.status = data.status;

          // don't think we need this on the FE
          // if (data.status === ChatMemberStatus.Joined) tMember.joinedAt = data.joinedAt;
          // ...etc
        })
      );

      if (data.status === ChatMemberStatus.Ignored) {
        queryUtils.chat.getUnreadCount.setData(
          undefined,
          produce((old) => {
            if (!old) return old;

            const tChat = old.find((c) => c.chatId === data.chatId);
            if (!tChat) return old;

            tChat.cnt = 0;
          })
        );
      }

      setIsJoining(false);
      // if (data.status !== ChatMemberStatus.Joined) {
      //   setState((prev) => ({ ...prev, existingChatId: undefined }));
      // }
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
    onSuccess(data) {
      setIsSending(false);
      setChatMsg('');

      if (!currentUser) return;

      const newEntry = {
        [currentUser.username]: false,
      };
      const { newTotalStatus, isTypingText } = getTypingStatus(newEntry);

      setTypingStatus(newTotalStatus);
      setTypingText(isTypingText);

      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId: data.chatId },
        produce((old) => {
          if (!old) return old;

          const lastPage = old.pages[old.pages.length - 1];

          lastPage.items.push(data);
        })
      );

      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const thisChat = old.find((o) => o.id === data.chatId);
          if (!thisChat) return old;
          thisChat.messages = [
            {
              content: data.content,
              createdAt: new Date(data.createdAt),
            },
          ];
        })
      );
    },
    onError(error) {
      setIsSending(false);
      showErrorNotification({
        title: 'Failed to send message.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
    onSettled() {
      throttledTyping.cancel();

      if (!currentUser) return;

      doIsTyping({
        chatId: state.existingChatId!,
        userId: currentUser.id,
        isTyping: false,
      }).catch();
    },
  });

  const { mutateAsync: doIsTyping } = trpc.chat.isTyping.useMutation();

  const allChats = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  useEffect(() => {
    // - on a new message or initial load, scroll to the bottom. on load more, don't scroll

    if (!allChats.length) return;

    // if (data.pages.length !== oldPagesLength.current) return;
    //
    // oldPagesLength.current = data.pages.length;

    lastReadRef.current?.scrollTo(
      0,
      lastReadRef.current?.scrollHeight - lastReadRef.current?.clientHeight
    );

    if (!myMember) return;
    const newestMessageId = allChats[allChats.length - 1].id;
    if ((myMember.lastViewedMessageId ?? 0) >= newestMessageId) return;
    changeLastViewed({
      chatMemberId: myMember.id,
      lastViewedMessageId: newestMessageId,
    }).catch();
  }, [allChats, changeLastViewed, myMember]);

  useEffect(() => {
    setTypingStatus({});
    setTypingText(null);
    setChatMsg('');
  }, [state.existingChatId]);

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
      if (data.chatId !== state.existingChatId) return;

      const newEntry = {
        [data.username]: data.isTyping,
      };

      const { newTotalStatus, isTypingText } = getTypingStatus(newEntry);

      setTypingStatus(newTotalStatus);
      setTypingText(isTypingText);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.existingChatId]
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
      chatId: state.existingChatId!,
      userId: currentUser.id,
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
            chatId: state.existingChatId!,
            userId: currentUser.id,
            isTyping: true,
          }).catch();
        },
        2000,
        { leading: true, trailing: true }
      ),
    [currentUser, doIsTyping, state.existingChatId]
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
      chatId: state.existingChatId!,
      content: strippedMessage,
    });
  };

  const goBack = () => {
    setState((prev) => ({ ...prev, existingChatId: undefined }));
  };

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart" noWrap>
        {mobile && (
          <ActionIcon onClick={goBack}>
            <IconChevronLeft />
          </ActionIcon>
        )}
        {allChatLoading ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : (
          <Group>
            {/* TODO limit this to one line, then expand */}
            {/* TODO improve useravatar to show loading */}
            {/* TODO online status (later), blocked users, etc */}
            {otherMembers?.map((cm) => (
              <Button key={cm.userId} variant="light" color="gray" compact>
                <UserAvatar
                  userId={cm.userId}
                  size="xs"
                  withUsername
                  linkToProfile
                  // TODO don't do the uuid thing
                  badge={
                    <Group spacing={6} ml={4} align="center">
                      {cm.user.isModerator ? (
                        <EdgeMedia
                          title="Moderator"
                          src={'c8f81b5d-b271-4ad4-0eeb-64c42621e300'}
                          width={16}
                        />
                      ) : undefined}
                      {cm.isOwner === true ? (
                        <Box title="Creator" display="flex">
                          <IconCrown size={16} fill="currentColor" />
                        </Box>
                      ) : undefined}
                      <Box
                        title={
                          cm.status === ChatMemberStatus.Invited ||
                          cm.status === ChatMemberStatus.Ignored
                            ? 'Invited'
                            : cm.status
                        }
                        display="flex"
                      >
                        {cm.status === ChatMemberStatus.Joined ? (
                          <IconCircleCheck size={16} color="green" />
                        ) : cm.status === ChatMemberStatus.Left ||
                          cm.status === ChatMemberStatus.Kicked ? (
                          <IconCircleX size={16} color="orangered" />
                        ) : (
                          <IconCircleMinus size={16} />
                        )}
                      </Box>
                    </Group>
                  }
                />
              </Button>
            ))}
          </Group>
        )}
        <ChatActions chatObj={thisChat} />
      </Group>
      <Divider />
      {!myMember ? (
        <Center h="100%">
          <Loader />
        </Center>
      ) : myMember.status === ChatMemberStatus.Joined ||
        myMember.status === ChatMemberStatus.Left ||
        myMember.status === ChatMemberStatus.Kicked ? (
        <>
          <Box p="sm" sx={{ flexGrow: 1, overflowY: 'auto' }} ref={lastReadRef}>
            {isRefetching || isLoading ? (
              <Center h="100%">
                <Loader />
              </Center>
            ) : allChats.length > 0 ? (
              <Stack sx={{ overflowWrap: 'break-word' }}>
                {hasNextPage && (
                  <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && hasNextPage}>
                    <Center p="xl" sx={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
                <DisplayMessages chats={allChats} />
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
          {myMember.status === ChatMemberStatus.Joined ? (
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
                disabled={isSending || !chatMsg.length || currentUser?.muted}
                sx={{ borderRadius: 0 }}
              >
                {isSending ? <Loader /> : <IconSend />}
              </ActionIcon>
            </Group>
          ) : (
            <Center p="sm">
              <Group>
                <Text>
                  You {myMember.status === ChatMemberStatus.Left ? 'left' : 'were kicked from'} this
                  chat.
                </Text>
                {myMember.status === ChatMemberStatus.Left && (
                  <Button
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    compact
                    disabled={isJoining}
                    onClick={handleJoinChat}
                  >
                    Rejoin?
                  </Button>
                )}
              </Group>
            </Center>
          )}
        </>
      ) : myMember.status === ChatMemberStatus.Invited ||
        myMember.status === ChatMemberStatus.Ignored ? (
        <Center h="100%">
          <Stack>
            {allChats.length > 0 && (
              <Text mb="md" p="sm" size="xs" italic align="center">{`"${allChats[0].content.slice(
                0,
                70
              )}${allChats[0].content.length > 70 ? '...' : ''}"`}</Text>
            )}
            <Text align="center">Join the chat?</Text>
            <Group p="sm" position="center">
              <Button
                disabled={isJoining || myMember.status === ChatMemberStatus.Ignored}
                variant="light"
                color="gray"
                onClick={handleIgnoreChat}
              >
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
          style={idx === chats.length - 1 ? { paddingBottom: 12 } : {}}
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
              <Text
                className={cx(classes.chatMessage, {
                  [classes.otherMessage]: c.userId !== currentUser?.id,
                  [classes.myMessage]: c.userId === currentUser?.id,
                })}
              >
                {c.content}
              </Text>
            </>
          )}
        </PStack>
      ))}
    </AnimatePresence>
  );
}
