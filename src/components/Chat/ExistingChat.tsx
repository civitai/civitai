import {
  ActionIcon,
  Anchor,
  Box,
  BoxProps,
  Button,
  Center,
  createPolymorphicComponent,
  Divider,
  Group,
  Image,
  Loader,
  Menu,
  Spoiler,
  Stack,
  StackProps,
  Text,
  Textarea,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { createStyles } from '@mantine/styles';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconArrowBack,
  IconChevronDown,
  IconChevronLeft,
  IconChevronUp,
  IconCircleCheck,
  IconCircleMinus,
  IconCircleX,
  IconCrown,
  IconDotsVertical,
  IconSend,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import Linkify from 'linkify-react';
import { throttle } from 'lodash-es';
import { LazyMotion } from 'motion/react';
import { div } from 'motion/react-m';
import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef } from 'react';
import { ChatActions } from '~/components/Chat/ChatActions';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { getLinkHref, linkifyOptions, loadMotion } from '~/components/Chat/util';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import { isTypingOutput } from '~/server/schema/chat.schema';
import { ChatMemberStatus, ChatMessageType } from '~/shared/utils/prisma/enums';
import { ChatAllMessages } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import styles from './ExistingChat.module.scss';

type TypingStatus = {
  [key: string]: boolean;
};

const PStack = createPolymorphicComponent<'div', StackProps>(Stack);

const useStyles = createStyles(styles);

export interface ExistingChatProps extends BoxProps {
  isMyMessage?: boolean;
  isReply?: boolean;
  isTyping?: boolean;
}

export const ExistingChat = forwardRef<HTMLDivElement, ExistingChatProps>((props, ref) => {
  const { isMyMessage, isReply, isTyping, className, ...others } = props;

  return (
    <Box
      className={`${styles.chatMessage} ${isMyMessage ? styles.myMessage : styles.otherMessage} ${
        isReply ? styles.replyMessage : ''
      } ${isTyping ? styles.isTypingBox : ''} ${className}`}
      {...others}
      ref={ref}
    />
  );
});

ExistingChat.displayName = 'ExistingChat';

export function ExistingChat() {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const { worker } = useSignalContext();
  const { state, setState } = useChatContext();
  const queryUtils = trpc.useUtils();
  const isMobile = useContainerSmallerThan(700);
  const theme = useMantineTheme();

  const lastReadRef = useRef<HTMLDivElement>(null);
  const [typingStatus, setTypingStatus] = useState<TypingStatus>({});
  const [typingText, setTypingText] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [replyId, setReplyId] = useState<number | undefined>(undefined);

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

  const thisChat = useMemo(
    () => allChatData?.find((c) => c.id === state.existingChatId),
    [allChatData, state.existingChatId]
  );
  const myMember = useMemo(
    () => thisChat?.chatMembers.find((cm) => cm.userId === currentUser?.id),
    [thisChat, currentUser]
  );
  const otherMembers = useMemo(
    () => thisChat?.chatMembers.filter((cm) => cm.userId !== currentUser?.id),
    [thisChat, currentUser]
  );
  // const lastViewed = myMember?.lastViewedMessageId;
  const modSender = useMemo(
    () => thisChat?.chatMembers.find((cm) => cm.isOwner === true && cm.user.isModerator === true),
    [thisChat]
  );

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

    modifyMembership({
      chatId: state.existingChatId!,
      userId: currentUser.id,
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
      chatId: state.existingChatId!,
      userId: currentUser.id,
      status: ChatMemberStatus.Joined,
    });
  };

  function getTypingStatus(newEntry: { [p: string]: boolean }) {
    const newTotalStatus = { ...typingStatus, ...newEntry };
    const isTypingText = Object.entries(newTotalStatus)
      .filter(([_, isTyping]) => isTyping)
      .map(([username]) => username)
      .join(', ');

    return {
      newTotalStatus,
      isTypingText: isTypingText
        ? `${isTypingText} ${isTypingText.includes(',') ? 'are' : 'is'} typing...`
        : null,
    };
  }

  const goBack = () => {
    setState((prev) => ({ ...prev, existingChatId: undefined }));
  };

  useEffect(() => {
    if (!worker) return;

    worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === SignalMessages.ChatMessage) {
        queryUtils.chat.getInfiniteMessages.setData(
          { chatId: state.existingChatId! },
          produce((old) => {
            if (!old) return old;

            const lastPage = old.pages[old.pages.length - 1];
            if (!lastPage) return old;

            lastPage.items.push(data.message);
          })
        );
      } else if (data.type === SignalMessages.ChatTyping) {
        const { newTotalStatus, isTypingText } = getTypingStatus({
          [data.username]: data.isTyping,
        });
        setTypingStatus(newTotalStatus);
        setTypingText(isTypingText);
      }
    };

    return () => {
      worker.onmessage = null;
    };
  }, [worker, state.existingChatId, queryUtils.chat.getInfiniteMessages]);

  useEffect(() => {
    if (!data?.pages[0]?.items[0]?.id) return;

    changeLastViewed({
      chatId: state.existingChatId!,
      userId: currentUser?.id!,
      lastViewedMessageId: data.pages[0].items[0].id,
    });
  }, [data?.pages[0]?.items[0]?.id, state.existingChatId, currentUser?.id, changeLastViewed]);

  if (isLoading || allChatLoading) {
    return (
      <Center h="100%">
        <Loader />
      </Center>
    );
  }

  if (!thisChat) {
    return (
      <Center h="100%">
        <Text>Chat not found</Text>
      </Center>
    );
  }

  if (!myMember) {
    return (
      <Center h="100%">
        <Text>You are not a member of this chat</Text>
      </Center>
    );
  }

  if (myMember.status === ChatMemberStatus.Ignored) {
    return (
      <Stack h="100%" align="center" justify="center">
        <Text>You have ignored this chat</Text>
        <Button onClick={handleJoinChat} loading={isJoining}>
          Rejoin chat
        </Button>
      </Stack>
    );
  }

  if (myMember.status === ChatMemberStatus.Left) {
    return (
      <Stack h="100%" align="center" justify="center">
        <Text>You have left this chat</Text>
        <Button onClick={handleJoinChat} loading={isJoining}>
          Rejoin chat
        </Button>
      </Stack>
    );
  }

  return (
    <Stack h="100%" spacing={0}>
      <Group position="apart" p="xs">
        <Group>
          <ActionIcon onClick={goBack}>
            <IconArrowBack />
          </ActionIcon>
          <Stack spacing={0}>
            <Group spacing="xs">
              <Title order={4}>{thisChat.name}</Title>
              {modSender && (
                <Tooltip label="Moderated by a moderator">
                  <IconCrown size={16} />
                </Tooltip>
              )}
            </Group>
            <Text size="xs" color="dimmed">
              {otherMembers?.map((cm) => cm.user.username).join(', ')}
            </Text>
          </Stack>
        </Group>
        <Menu position="bottom-end">
          <Menu.Target>
            <ActionIcon>
              <IconDotsVertical />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item color="red" onClick={handleIgnoreChat}>
              Ignore chat
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <Divider />
      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        <Stack h="100%" spacing={0}>
          <Box sx={{ flex: 1, overflow: 'auto' }}>
            {data && <DisplayMessages chats={data} setReplyId={setReplyId} />}
            {hasNextPage && (
              <InViewLoader
                loadFn={() => fetchNextPage()}
                loadCondition={!isRefetching}
                style={{ width: '100%' }}
              >
                <Center p="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )}
          </Box>
          <Divider />
          <ChatInputBox
            isModSender={modSender?.userId === currentUser?.id}
            replyId={replyId}
            setReplyId={setReplyId}
            getTypingStatus={getTypingStatus}
            setTypingStatus={setTypingStatus}
            setTypingText={setTypingText}
          />
          {typingText && (
            <Box className={classes.isTypingBox}>
              <Text size="xs" color="dimmed">
                {typingText}
              </Text>
            </Box>
          )}
        </Stack>
      </Box>
    </Stack>
  );
}

function ChatInputBox({
  isModSender,
  replyId,
  setReplyId,
  getTypingStatus,
  setTypingStatus,
  setTypingText,
}: {
  isModSender: boolean;
  replyId: number | undefined;
  setReplyId: React.Dispatch<React.SetStateAction<number | undefined>>;
  getTypingStatus: (newEntry: { [p: string]: boolean }) => {
    newTotalStatus: {
      // noinspection JSUnusedLocalSymbols
      [p: string]: boolean;
    };
    isTypingText: string | null;
  };
  setTypingStatus: React.Dispatch<React.SetStateAction<TypingStatus>>;
  setTypingText: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const { classes } = useStyles();
  const { state } = useChatContext();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [message, setMessage] = useState('');
  const [debouncedMessage] = useDebouncedValue(message, 500);

  const { mutate: sendMessageMutation } = trpc.chat.sendMessage.useMutation({
    onSuccess(data) {
      queryUtils.chat.getInfiniteMessages.setData(
        { chatId: state.existingChatId! },
        produce((old) => {
          if (!old) return old;

          const lastPage = old.pages[old.pages.length - 1];
          if (!lastPage) return old;

          lastPage.items.push(data);
        })
      );
      setMessage('');
      setReplyId(undefined);
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to send message.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
    onSettled() {
      const { newTotalStatus, isTypingText } = getTypingStatus({
        [currentUser?.username ?? '']: false,
      });
      setTypingStatus(newTotalStatus);
      setTypingText(isTypingText);
    },
  });

  const handleChatTyping = (value: string) => {
    setMessage(value);
    const { newTotalStatus, isTypingText } = getTypingStatus({
      [currentUser?.username ?? '']: true,
    });
    setTypingStatus(newTotalStatus);
    setTypingText(isTypingText);
  };

  const sendMessage = () => {
    if (!message.trim()) return;

    sendMessageMutation({
      chatId: state.existingChatId!,
      content: message,
      replyId,
    });
  };

  return (
    <Stack spacing={0}>
      {replyId && (
        <Group position="apart" p="xs" className={classes.replyMessage}>
          <Text size="xs">Replying to message</Text>
          <ActionIcon size="xs" onClick={() => setReplyId(undefined)}>
            <IconX />
          </ActionIcon>
        </Group>
      )}
      <Group spacing={0}>
        <Textarea
          className={classes.chatInput}
          placeholder="Type a message..."
          value={message}
          onChange={(e) => handleChatTyping(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          autosize
          minRows={1}
          maxRows={4}
          sx={{ flex: 1 }}
        />
        <ActionIcon
          size="lg"
          variant="filled"
          color="blue"
          onClick={sendMessage}
          disabled={!message.trim()}
        >
          <IconSend size={16} />
        </ActionIcon>
      </Group>
    </Stack>
  );
}

const EmbedLink = ({ href, title }: { href?: string; title: string }) => {
  if (!href) return null;

  return (
    <Link href={href} target="_blank">
      <Group spacing="xs" noWrap>
        <Text size="xs">{title}</Text>
        <IconChevronRight size={16} />
      </Group>
    </Link>
  );
};

const EmbedMessage = ({ content }: { content: string }) => {
  const { classes } = useStyles();
  const { state } = useChatContext();
  const currentUser = useCurrentUser();

  const isMyMessage = content.includes(currentUser?.username ?? '');

  return (
    <Group position={isMyMessage ? 'right' : 'left'} spacing="xs" className={classes.highlightRow}>
      <Stack spacing={0} className={classes.chatMessage}>
        <Group spacing="xs" className={isMyMessage ? classes.myDetails : undefined}>
          <UserAvatar user={currentUser} size="sm" />
          <Text size="xs" color="dimmed">
            {currentUser?.username}
          </Text>
        </Group>
        <Text className={isMyMessage ? classes.myMessage : classes.otherMessage}>{content}</Text>
      </Stack>
    </Group>
  );
};

function DisplayMessages({
  chats,
  setReplyId,
}: {
  chats: ChatAllMessages;
  setReplyId: React.Dispatch<React.SetStateAction<number | undefined>>;
}) {
  const { classes } = useStyles();
  const { state } = useChatContext();
  const currentUser = useCurrentUser();

  return (
    <Stack spacing="xs" p="xs">
      {chats.pages.map((page) =>
        page.items.map((message) => {
          const isMyMessage = message.userId === currentUser?.id;

          return (
            <Group
              key={message.id}
              position={isMyMessage ? 'right' : 'left'}
              spacing="xs"
              className={classes.highlightRow}
            >
              <Stack spacing={0} className={classes.chatMessage}>
                <Group spacing="xs" className={isMyMessage ? classes.myDetails : undefined}>
                  <UserAvatar user={message.user} size="sm" />
                  <Text size="xs" color="dimmed">
                    {message.user.username}
                  </Text>
                </Group>
                {message.replyTo && (
                  <Box className={classes.replyMessage}>
                    <Text size="xs" color="dimmed">
                      Replying to {message.replyTo.user.username}
                    </Text>
                    <Text size="xs">{message.replyTo.content}</Text>
                  </Box>
                )}
                <Text className={isMyMessage ? classes.myMessage : classes.otherMessage}>
                  {message.content}
                </Text>
                <Group position="right" spacing="xs">
                  <Text size="xs" color="dimmed">
                    {formatDate(message.createdAt)}
                  </Text>
                  <ActionIcon size="xs" variant="subtle" onClick={() => setReplyId(message.id)}>
                    <IconChevronUp />
                  </ActionIcon>
                </Group>
              </Stack>
            </Group>
          );
        })
      )}
    </Stack>
  );
}
