import type { StackProps } from '@mantine/core';
import {
  Alert,
  Anchor,
  Box,
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
  Text,
  Textarea,
  Title,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconAlertTriangle,
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
import clsx from 'clsx';
import produce from 'immer';
import Linkify from 'linkify-react';
import { throttle } from 'lodash-es';
import { LazyMotion } from 'motion/react';
import { div } from 'motion/react-m';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatActions } from '~/components/Chat/ChatActions';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { getLinkHref, linkifyOptions, loadMotion } from '~/components/Chat/util';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import type { isTypingOutput } from '~/server/schema/chat.schema';
import { ChatMemberStatus, ChatMessageType } from '~/shared/utils/prisma/enums';
import type { ChatAllMessages } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import classes from './ExistingChat.module.scss';
import { BlurText } from '~/components/BlurText/BlurText';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportEntity } from '~/server/schema/report.schema';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useDomainColor } from '~/hooks/useDomainColor';

type TypingStatus = {
  [key: string]: boolean;
};

const PStack = createPolymorphicComponent<'div', StackProps>(Stack);

function ScamWarningContent({ chatId }: { chatId: number }) {
  return (
    <Text size="xs">
      Beware of scam messages. Civitai staff will only message you from{' '}
      <Text span c="red" fw={700}>
        red-nameplate
      </Text>{' '}
      accounts and have a Civitai moderator badge next to their name (not the profile picture!). Do
      not click unknown links or share payment info.{' '}
      <Anchor
        component="button"
        type="button"
        size="xs"
        onClick={() => openReportModal({ entityType: ReportEntity.Chat, entityId: chatId })}
      >
        Report suspicious DMs
      </Anchor>{' '}
      immediately.
    </Text>
  );
}

export function ExistingChat() {
  const currentUser = useCurrentUser();
  const { worker } = useSignalContext();
  const existingChatId = useChatStore((state) => state.existingChatId);
  const queryUtils = trpc.useUtils();
  const isMobile = useContainerSmallerThan(700);
  const colorScheme = useComputedColorScheme('dark');

  const lastReadRef = useRef<HTMLDivElement>(null);
  const [typingStatus, setTypingStatus] = useState<TypingStatus>({});
  const [typingText, setTypingText] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [replyId, setReplyId] = useState<number | undefined>(undefined);

  // TODO there is a bug here. upon rejoining, you won't get a signal for the messages in the timespan between leaving and rejoining
  const { data, fetchNextPage, isLoading, isRefetching, hasNextPage } =
    trpc.chat.getInfiniteMessages.useInfiniteQuery(
      {
        chatId: existingChatId!,
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
    () => allChatData?.find((c) => c.id === existingChatId),
    [allChatData, existingChatId]
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

          const tChat = old.find((c) => c.id === existingChatId);
          const tMember = tChat?.chatMembers?.find((cm) => cm.userId === currentUser?.id);
          if (!tMember) return old;

          tMember.lastViewedMessageId = data.lastViewedMessageId ?? null;
        })
      );
      queryUtils.chat.getUnreadCount.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const tChat = old.find((c) => c.chatId === existingChatId);
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

          const tChat = old.find((c) => c.id === existingChatId);
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
  }, [existingChatId]);

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
      if (data.chatId !== existingChatId) return;

      const newEntry = {
        [data.username]: data.isTyping,
      };

      const { newTotalStatus, isTypingText } = getTypingStatus(newEntry);

      setTypingStatus(newTotalStatus);
      setTypingText(isTypingText);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [existingChatId]
  );

  useEffect(() => {
    worker?.on(SignalMessages.ChatTypingStatus, handleIsTyping);
    return () => {
      worker?.off(SignalMessages.ChatTypingStatus, handleIsTyping);
    };
  }, [worker, handleIsTyping]);

  const goBack = () => {
    useChatStore.setState({ existingChatId: undefined });
  };

  return (
    <Stack gap={0} h="100%">
      {/* TODO this component stinks, it is hardcoded as a button */}
      <Spoiler
        showLabel={
          <Group mt={4} gap={8}>
            <IconChevronDown size={16} />
            <Text size="xs">Expand</Text>
          </Group>
        }
        hideLabel={
          <Group mt={8} gap={8}>
            <IconChevronUp size={16} />
            <Text size="xs">Hide</Text>
          </Group>
        }
        maxHeight={44}
        styles={{
          root: { textAlign: 'center' },
        }}
      >
        <Group m="sm" mb={0} justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
          {isMobile && (
            <LegacyActionIcon onClick={goBack}>
              <IconChevronLeft />
            </LegacyActionIcon>
          )}
          {allChatLoading ? (
            <Center h="100%">
              <Loader />
            </Center>
          ) : (
            <Group gap="xs">
              {/* TODO improve useravatar to show loading (if necessary) */}
              {/* TODO online status (later), blocked users, etc */}

              {otherMembers?.map((cm) => (
                <Button key={cm.userId} variant="light" color="gray" size="compact-sm">
                  <UserAvatar
                    user={cm.user}
                    size="xs"
                    withUsername
                    linkToProfile
                    badge={
                      <Group gap={6} ml={4} align="center">
                        {cm.user.isModerator ? (
                          <Image
                            src="/images/civ-c.png"
                            title="Moderator"
                            alt="Moderator"
                            className="size-4"
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
          <DismissibleAlert
            id="chat-scam-warning"
            className="shrink-0"
            color="yellow"
            icon={<IconAlertTriangle className="shrink-0" size={20} />}
            size="sm"
            p="xs"
            m="xs"
          >
            <ScamWarningContent chatId={existingChatId!} />
          </DismissibleAlert>
          <Box p="sm" style={{ flexGrow: 1, overflowY: 'auto' }} ref={lastReadRef}>
            {isRefetching || isLoading ? (
              <Center h="100%">
                <Loader />
              </Center>
            ) : allChats.length > 0 ? (
              <Stack style={{ overflowWrap: 'break-word' }} gap={12}>
                {hasNextPage && (
                  <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && hasNextPage}>
                    <Center p="xl" style={{ height: 36 }} mt="md">
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
                <Loader type="dots" />
              </Group>
            )}
          </Box>
          <Divider />
          {myMember.status === ChatMemberStatus.Joined ? (
            <>
              {!!replyId && (
                <>
                  <Group p="xs" wrap="nowrap">
                    <Text size="xs">Replying:</Text>
                    <Box style={{ textOverflow: 'ellipsis', overflow: 'hidden' }}>
                      {allChats.find((ac) => ac.id === replyId)?.content ?? ''}
                    </Box>
                    <LegacyActionIcon onClick={() => setReplyId(undefined)} ml="auto">
                      <IconX size={14} />
                    </LegacyActionIcon>
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
                    variant={colorScheme === 'dark' ? 'filled' : 'light'}
                    size="compact-sm"
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
            <Alert color="yellow" icon={<IconAlertTriangle size={20} />} p="xs" mx="sm">
              <ScamWarningContent chatId={existingChatId!} />
            </Alert>
            {allChats.length > 0 && (
              <Text mb="md" p="sm" size="xs" italic align="center">{`"${allChats[0].content.slice(
                0,
                70
              )}${allChats[0].content.length > 70 ? '...' : ''}"`}</Text>
            )}
            <Text align="center">Join the chat?</Text>
            <Group p="sm" justify="center">
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
  const existingChatId = useChatStore((state) => state.existingChatId);
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
            chatId: existingChatId!,
            userId: currentUser.id,
            isTyping: true,
          }).catch();
        },
        2000,
        { leading: true, trailing: true }
      ),
    [currentUser, doIsTyping, isMuted, existingChatId]
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
        chatId: existingChatId!,
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
      chatId: existingChatId!,
      content: strippedMessage,
      referenceMessageId: replyId,
    });
  };

  useEffect(() => {
    if (!currentUser || isMuted) return;

    doIsTyping({
      chatId: existingChatId!,
      userId: currentUser.id,
      isTyping: false,
    }).catch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedChatMsg]);

  useEffect(() => {
    setChatMsg('');
  }, [existingChatId]);

  return (
    <Group gap={0}>
      <Textarea
        style={{ flexGrow: 1 }}
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
      <LegacyActionIcon
        h="100%"
        w={60}
        onClick={sendMessage}
        disabled={isSending || !chatMsg.length || isMuted}
        style={{ borderRadius: 0 }}
      >
        {isSending ? <Loader /> : <IconSend />}
      </LegacyActionIcon>
    </Group>
  );
}

const EmbedLink = ({ href, title }: { href?: string; title: string }) => {
  if (!href) return <Title order={6}>{title}</Title>;

  if (constants.chat.externalRegex.test(href)) {
    return (
      <Anchor href={href} target="_blank" rel="noopener noreferrer" variant="link">
        <Title order={6}>{title}</Title>
      </Anchor>
    );
  }

  return (
    <Anchor component={Link} href={href} variant="link">
      <Title order={6}>{title}</Title>
    </Anchor>
  );
};

const EmbedMessage = ({ content }: { content: string }) => {
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
      style={{
        alignSelf: 'center',
        border: '1px solid gray',
      }}
      className={clsx(classes.chatMessage)}
      wrap="nowrap"
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
  const existingChatId = useChatStore((state) => state.existingChatId);
  const { data: userSettings } = trpc.chat.getUserSettings.useQuery();
  const domainColor = useDomainColor();
  const replaceBadWords = userSettings?.replaceBadWords ?? false;

  const { data: allChatData } = trpc.chat.getAllByUser.useQuery();
  const tChat = allChatData?.find((chat) => chat.id === existingChatId);

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
    <LazyMotion features={loadMotion}>
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

        const isSystemChat = c.userId === -1;

        return (
          <PStack
            component={div}
            // ref={c.id === lastReadId ? lastReadRef : undefined}
            key={c.id}
            gap={12}
            style={idx === chats.length - 1 ? { paddingBottom: 12 } : {}}
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', duration: 0.4 }}
          >
            {isSystemChat && c.contentType === ChatMessageType.Embed ? (
              <EmbedMessage content={c.content} />
            ) : isSystemChat ? (
              // <Group align="center" justify="center">
              //   <Text size="xs">{formatDate(c.createdAt)}</Text>
              //   ...Text (below)
              // </Group>
              <Text
                className={clsx(classes.chatMessage)}
                component="div"
                size="xs"
                py={0}
                style={{
                  alignSelf: 'center',
                  border: '1px solid gray',
                }}
              >
                <CustomMarkdown allowedElements={['a', 'p', 'strong']} unwrapDisallowed>
                  {c.content.replace(currentUser?.username ?? '', 'You')}
                </CustomMarkdown>
              </Text>
            ) : (
              <>
                {shouldShowInfo && (
                  <Group className={clsx({ [classes.myDetails]: isMe })}>
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
                    gap={6}
                    justify="flex-end"
                    style={{ flexDirection: !isMe ? 'row-reverse' : undefined }}
                  >
                    <IconArrowBack size={14} />
                    {!!tReplyData?.data?.user && (
                      <Tooltip label={tReplyData.data.user.username}>
                        <Box>
                          <UserAvatar user={tReplyData.data.user} size="xs" />
                        </Box>
                      </Tooltip>
                    )}
                    <Text className={clsx([classes.chatMessage, classes.replyMessage])}>
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
                  justify="flex-end"
                  className={classes.highlightRow}
                  style={{ flexDirection: !isMe ? 'row-reverse' : undefined }}
                >
                  <Menu withArrow position={isMe ? 'left-start' : 'right-start'}>
                    <Menu.Target>
                      <LegacyActionIcon style={{ alignSelf: 'flex-start', display: 'none' }}>
                        <IconDotsVertical />
                      </LegacyActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconArrowBack size={14} />}
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
                    style={{ opacity: 0.85 }}
                    openDelay={350}
                    position={isMe ? 'top-end' : 'top-start'}
                    withArrow
                  >
                    <div
                      className={clsx(classes.chatMessage, {
                        [classes.otherMessage]: !isMe,
                        [classes.myMessage]: isMe,
                      })}
                    >
                      <Linkify options={linkifyOptions}>
                        <BlurText blur={replaceBadWords || domainColor === 'green'}>
                          {c.content}
                        </BlurText>
                      </Linkify>
                    </div>
                  </Tooltip>
                </Group>
              </>
            )}
          </PStack>
        );
      })}
    </LazyMotion>
  );
}
