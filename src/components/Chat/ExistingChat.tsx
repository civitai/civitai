import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Center,
  createPolymorphicComponent,
  createStyles,
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
import { useDebouncedValue } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { ChatMemberStatus, ChatMessageType } from '@prisma/client';
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
import { AnimatePresence, motion } from 'framer-motion';
import produce from 'immer';
import Linkify from 'linkify-react';
import type { IntermediateRepresentation, OptFn, Opts } from 'linkifyjs';
import { throttle } from 'lodash-es';
import Link from 'next/link';
import React, { ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatActions } from '~/components/Chat/ChatActions';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client.mjs';
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
  replyMessage: {
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    overflowWrap: 'normal',
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[5],
    fontSize: theme.spacing.sm,
  },
  myDetails: {
    flexDirection: 'row-reverse',
  },
  myMessage: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.blue[8] : theme.colors.blue[4],
  },
  otherMessage: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[2],
  },
  highlightRow: {
    '&:hover': {
      '> button': {
        display: 'initial',
      },
    },
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
    // backdropFilter: 'blur(16px)',
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
    setReplyId(undefined);
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

  const goBack = () => {
    setState((prev) => ({ ...prev, existingChatId: undefined }));
  };

  return (
    <Stack spacing={0} h="100%">
      {/* TODO this component stinks, it is hardcoded as a button */}
      <Spoiler
        showLabel={
          <Group mt={4} spacing={8}>
            <IconChevronDown size={16} />
            <Text size="xs">Expand</Text>
          </Group>
        }
        hideLabel={
          <Group mt={8} spacing={8}>
            <IconChevronUp size={16} />
            <Text size="xs">Hide</Text>
          </Group>
        }
        maxHeight={44}
        styles={{
          root: { textAlign: 'center' },
        }}
      >
        <Group m="sm" mb={0} position="apart" noWrap align="flex-start" spacing="sm">
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
            <Group spacing="xs">
              {/* TODO improve useravatar to show loading (if necessary) */}
              {/* TODO online status (later), blocked users, etc */}

              {otherMembers?.map((cm) => (
                <Button key={cm.userId} variant="light" color="gray" compact>
                  <UserAvatar
                    user={cm.user}
                    size="xs"
                    withUsername
                    linkToProfile
                    badge={
                      <Group spacing={6} ml={4} align="center">
                        {cm.user.isModerator ? (
                          <Image
                            src="/images/civ-c.png"
                            title="Moderator"
                            alt="Moderator"
                            width={16}
                            height={16}
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
      </Spoiler>
      <Divider mt="sm" />
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
              <Stack sx={{ overflowWrap: 'break-word' }} spacing={12}>
                {hasNextPage && (
                  <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && hasNextPage}>
                    <Center p="xl" sx={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
                <DisplayMessages chats={allChats} setReplyId={setReplyId} />
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
            <>
              {!!replyId && (
                <>
                  <Group p="xs" noWrap>
                    <Text size="xs">Replying:</Text>
                    <Box sx={{ textOverflow: 'ellipsis', overflow: 'hidden' }}>
                      {allChats.find((ac) => ac.id === replyId)?.content ?? ''}
                    </Box>
                    <ActionIcon onClick={() => setReplyId(undefined)} ml="auto">
                      <IconX size={14} />
                    </ActionIcon>
                  </Group>
                  <Divider />
                </>
              )}
              <ChatInputBox
                isModSender={!!modSender}
                replyId={replyId}
                setReplyId={setReplyId}
                getTypingStatus={getTypingStatus}
                setTypingStatus={setTypingStatus}
                setTypingText={setTypingText}
              />
            </>
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
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const { state } = useChatContext();
  const queryUtils = trpc.useUtils();

  const [isSending, setIsSending] = useState(false);
  const [chatMsg, setChatMsg] = useState<string>('');
  const [debouncedChatMsg] = useDebouncedValue(chatMsg, 2000);

  const isMuted = currentUser?.muted && !isModSender;

  const { mutateAsync: doIsTyping } = trpc.chat.isTyping.useMutation();
  // const doIsTyping = async (x) => {};

  const throttledTyping = useMemo(
    () =>
      throttle(
        () => {
          if (!currentUser || isMuted) return;

          doIsTyping({
            chatId: state.existingChatId!,
            userId: currentUser.id,
            isTyping: true,
          }).catch();
        },
        2000,
        { leading: true, trailing: true }
      ),
    [currentUser, doIsTyping, isMuted, state.existingChatId]
  );

  const { mutate } = trpc.chat.createMessage.useMutation({
    // TODO onMutate for optimistic
    onSuccess(data) {
      setIsSending(false);
      setChatMsg('');
      setReplyId(undefined);

      if (!currentUser) return;

      const newEntry = {
        [currentUser.username ?? 'Unknown user']: false,
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
              contentType: data.contentType,
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

      if (!currentUser || isMuted) return;

      doIsTyping({
        chatId: state.existingChatId!,
        userId: currentUser.id,
        isTyping: false,
      }).catch();
    },
  });

  const handleChatTyping = (value: string) => {
    setChatMsg(value);
    if (!currentUser) return;

    // only send signal if they're not erasing the chat
    if (value.length) {
      throttledTyping();
    }
  };

  const sendMessage = () => {
    if (isSending) return;

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
      referenceMessageId: replyId,
    });
  };

  useEffect(() => {
    if (!currentUser || isMuted) return;

    doIsTyping({
      chatId: state.existingChatId!,
      userId: currentUser.id,
      isTyping: false,
    }).catch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedChatMsg]);

  useEffect(() => {
    setChatMsg('');
  }, [state.existingChatId]);

  return (
    <Group spacing={0}>
      <Textarea
        sx={{ flexGrow: 1 }}
        disabled={isMuted}
        placeholder={isMuted ? 'Your account has been restricted' : 'Send message'}
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
        disabled={isSending || !chatMsg.length || isMuted}
        sx={{ borderRadius: 0 }}
      >
        {isSending ? <Loader /> : <IconSend />}
      </ActionIcon>
    </Group>
  );
}

// TODO disable just "image.civitai.com" with nothing else
const civRegex = new RegExp(
  `^(?:https?://)?(?:image\\.)?(?:${(env.NEXT_PUBLIC_BASE_URL ?? 'civitai.com')
    .replace(/^https?:\/\//, '')
    .replace(/\./g, '\\.')}|civitai\\.com)`
);
const externalRegex = /^(?:https?:\/\/)?(?:www\.)?(github\.com|twitter\.com|x\.com)/;
// const airRegex = /^(?:urn:air:\w+:\w+:)?civitai:(?<mId>\d+)@(?<mvId>\d+)$/i;
export const airRegex = /^civitai:(?<mId>\d+)@(?<mvId>\d+)$/i;

function getLinkHref(href: string | undefined) {
  if (!href) return;

  if (externalRegex.test(href)) return href;

  let newHref: string;
  const airMatch = href.match(airRegex);
  if (airMatch && airMatch.groups) {
    const { mId, mvId } = airMatch.groups;
    newHref = `/models/${mId}?modelVersionId=${mvId}`;
  } else {
    newHref = href.replace(civRegex, '') || '/';
  }
  return newHref;
}

const EmbedLink = ({ href, title }: { href?: string; title: string }) => {
  if (!href) return <Title order={6}>{title}</Title>;

  if (externalRegex.test(href)) {
    return (
      <Anchor href={href} target="_blank" rel="noopener noreferrer" variant="link">
        <Title order={6}>{title}</Title>
      </Anchor>
    );
  }

  return (
    <Anchor component={NextLink} href={href} variant="link">
      <Title order={6}>{title}</Title>
    </Anchor>
  );
};
const renderLink: OptFn<(ir: IntermediateRepresentation) => ReactElement | undefined> = ({
  attributes,
  content,
}) => {
  const { href, ...props }: { href?: string } = attributes;

  const modHref = getLinkHref(href);
  if (!modHref) return;

  if (externalRegex.test(modHref)) {
    return (
      <Anchor
        href={modHref}
        target="_blank"
        rel="noopener noreferrer"
        variant="link"
        sx={{ textDecoration: 'underline', color: 'unset' }}
        {...props}
      >
        {content}
      </Anchor>
    );
  }

  return (
    <Link href={modHref} passHref {...props}>
      <Text variant="link" component="a" sx={{ textDecoration: 'underline', color: 'unset' }}>
        {content}
      </Text>
    </Link>
  );
};
const validateLink = {
  url: (value: string) => civRegex.test(value) || airRegex.test(value) || externalRegex.test(value),
};
export const linkifyOptions: Opts = {
  render: renderLink,
  validate: validateLink,
};

const EmbedMessage = ({ content }: { content: string }) => {
  const { classes, cx } = useStyles();

  let contentObj: {
    title: string | null;
    description: string | null;
    image: string | null;
    href?: string;
  };
  try {
    contentObj = JSON.parse(content);
  } catch {
    return <></>;
  }

  const { title, description, image, href } = contentObj;

  if (!title && !description && !image) return <></>;

  const modHref = getLinkHref(href);

  return (
    <Group
      sx={{
        alignSelf: 'center',
        border: '1px solid gray',
      }}
      className={cx(classes.chatMessage)}
      noWrap
    >
      {(!!title || !!description) && (
        <Stack>
          {!!title && <EmbedLink href={modHref} title={title} />}
          {!!description && <Text size="xs">{description}</Text>}
        </Stack>
      )}
      {!!image && (
        <EdgeMedia
          src={image}
          width={75}
          height={75}
          alt="Link preview"
          style={{ objectFit: 'cover' }}
        />
      )}
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
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const { state } = useChatContext();

  const { data: allChatData } = trpc.chat.getAllByUser.useQuery();
  const tChat = allChatData?.find((chat) => chat.id === state.existingChatId);

  // TODO we should be checking first if this exists in `chats`
  //      then, grab the content
  //      then, grab the user info from chatMembers (but what if its not there?)
  const replyIds = chats
    .filter((c) => isDefined(c.referenceMessageId))
    .map((c) => c.referenceMessageId as number);
  const replyData = trpc.useQueries((t) =>
    replyIds.map((r) => t.chat.getMessageById({ messageId: r }))
  );

  let loopMsgDate = new Date(1970);
  let loopPreviousChatter = 0;

  return (
    <AnimatePresence initial={false} mode="sync">
      {chats.map((c, idx) => {
        const hourDiff = (c.createdAt.valueOf() - loopMsgDate.valueOf()) / (1000 * 60 * 60);
        const sameChatter = loopPreviousChatter === c.userId;
        const shouldShowInfo = hourDiff >= 1 || !sameChatter;

        loopMsgDate = c.createdAt;
        loopPreviousChatter = c.userId;

        const cachedUser = tChat?.chatMembers?.find((cm) => cm.userId === c.userId)?.user;
        const isMe = c.userId === currentUser?.id;

        const tReplyData =
          !!c.referenceMessageId && replyIds.indexOf(c.referenceMessageId) > -1
            ? replyData[replyIds.indexOf(c.referenceMessageId)]
            : undefined;

        return (
          <PStack
            component={motion.div}
            // ref={c.id === lastReadId ? lastReadRef : undefined}
            key={c.id}
            spacing={12}
            style={idx === chats.length - 1 ? { paddingBottom: 12 } : {}}
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', duration: 0.4 }}
          >
            {c.userId === -1 && c.contentType === ChatMessageType.Embed ? (
              <EmbedMessage content={c.content} />
            ) : c.userId === -1 ? (
              // <Group align="center" position="center">
              //   <Text size="xs">{formatDate(c.createdAt)}</Text>
              //   ...Text (below)
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
                {shouldShowInfo && (
                  <Group className={cx({ [classes.myDetails]: isMe })}>
                    {!!cachedUser ? (
                      <UserAvatar user={cachedUser} withUsername />
                    ) : (
                      <UserAvatar userId={c.userId} withUsername />
                    )}
                    <Text size="xs">{formatDate(c.createdAt, 'MMM DD, YYYY h:mm:ss a')}</Text>
                  </Group>
                )}
                {/* TODO this needs better styling and click -> message */}
                {!!c.referenceMessageId && (
                  <Group
                    spacing={6}
                    position="right"
                    sx={{ flexDirection: !isMe ? 'row-reverse' : undefined }}
                  >
                    <IconArrowBack size={14} />
                    {!!tReplyData?.data?.user && (
                      <Tooltip label={tReplyData.data.user.username}>
                        <Box>
                          <UserAvatar user={tReplyData.data.user} size="xs" />
                        </Box>
                      </Tooltip>
                    )}
                    <Text className={cx([classes.chatMessage, classes.replyMessage])}>
                      {!tReplyData || tReplyData.isError ? (
                        <em>Could not load message.</em>
                      ) : tReplyData.isLoading ? (
                        <em>Loading content...</em>
                      ) : (
                        tReplyData.data?.content ?? <em>Could not load message.</em>
                      )}
                    </Text>
                  </Group>
                )}
                <Group
                  position="right"
                  className={classes.highlightRow}
                  sx={{ flexDirection: !isMe ? 'row-reverse' : undefined }}
                >
                  <Menu withArrow position={isMe ? 'left-start' : 'right-start'}>
                    <Menu.Target>
                      <ActionIcon sx={{ alignSelf: 'flex-start', display: 'none' }}>
                        <IconDotsVertical />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        icon={<IconArrowBack size={14} />}
                        onClick={() => setReplyId(c.id)}
                      >
                        Reply
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                  <Tooltip
                    label={
                      !shouldShowInfo
                        ? formatDate(c.createdAt, 'MMM DD, YYYY h:mm:ss a')
                        : undefined
                    }
                    disabled={shouldShowInfo}
                    sx={{ opacity: 0.85 }}
                    openDelay={350}
                    position={isMe ? 'top-end' : 'top-start'}
                    withArrow
                  >
                    <div
                      className={cx(classes.chatMessage, {
                        [classes.otherMessage]: !isMe,
                        [classes.myMessage]: isMe,
                      })}
                    >
                      <Linkify options={linkifyOptions}>{c.content}</Linkify>
                    </div>
                  </Tooltip>
                </Group>
              </>
            )}
          </PStack>
        );
      })}
    </AnimatePresence>
  );
}
