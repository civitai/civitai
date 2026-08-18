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
  Spoiler,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
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
  IconSend,
  IconTrash,
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
import { Sticker } from '~/components/Sticker/Sticker';
import { StickerPicker } from '~/components/Sticker/StickerPicker';
import { StickerProvider } from '~/components/Sticker/StickerProvider';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { useCleanText } from '~/hooks/useCheckProfanity';
import {
  STICKER_SIZE,
  isStickerOnlyContent,
  parseStickerIds,
  parseStickerLines,
  resolveStickerTokens,
  stripStickerTokens,
} from '~/shared/utils/sticker-token';
import { MAX_CHAT_MESSAGE_LENGTH } from '~/shared/utils/chat';
import { isJumboEmojiText } from '~/shared/constants/base-emoji';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useDomainColor } from '~/hooks/useDomainColor';

type TypingStatus = {
  [key: string]: boolean;
};

/** The counter turns amber here, far enough out to still be editing rather than deleting. */
const COUNTER_WARN_AT = 1800;

const PStack = createPolymorphicComponent<'div', StackProps>(Stack);

/**
 * The detail sits behind a disclosure because this renders above every
 * conversation: at full length it was the loudest thing in the pane and got
 * read once, then dismissed. The claim and the report link stay in the line.
 */
function ScamWarningContent({ chatId }: { chatId: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Text size="xs">
      Civitai staff only message you from{' '}
      <Text span c="red" fw={700}>
        red-nameplate
      </Text>{' '}
      accounts.{' '}
      {expanded && (
        <>
          They carry a Civitai moderator badge next to their name — not on the profile picture.
          Never click unknown links or share payment info.{' '}
        </>
      )}
      <Anchor component="button" type="button" size="xs" onClick={() => setExpanded((o) => !o)}>
        {expanded ? 'Less' : 'More'}
      </Anchor>
      {' · '}
      <Anchor
        component="button"
        type="button"
        size="xs"
        onClick={() => openReportModal({ entityType: ReportEntity.Chat, entityId: chatId })}
      >
        Report
      </Anchor>
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
  const { data, fetchNextPage, isLoading, isRefetching, hasNextPage, isError, error } =
    trpc.chat.getInfiniteMessages.useInfiniteQuery(
      {
        chatId: existingChatId!,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  const { data: allChatData, isLoading: allChatLoading } = trpc.chat.getAllByUser.useQuery();

  // Reversal is intentionally here in useMemo, not in useInfiniteQuery's select.
  // Mutating pages + pageParams simultaneously inside select breaks RQ v5 cursor
  // tracking and causes the hook to return empty data.
  // Note: We reverse the `pages` array (chunks) instead of the flattened array
  // because the backend returns chunks in newest-to-oldest order, but the items
  // *inside* the chunks are correctly ordered chronologically. Reversing the
  // flattened array would break the internal chronological order of the messages.
  const messagesChronological = useMemo(() => {
    if (!data?.pages) return [];
    return [...data.pages].reverse().flatMap((x) => x.items ?? []);
  }, [data]);

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
          // Accepting clears the request mark server-side; dropping it here left
          // the conversation stuck in the Requests tab.
          tMember.filteredAt = data.filteredAt;

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

  // Captured the moment an older page starts loading, so the prepend can be
  // anchored. Reading it after the fact is too late — the DOM has already grown.
  const olderPageAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const anchorPageCount = useRef(0);

  const loadOlderMessages = useCallback(() => {
    const el = lastReadRef.current;
    if (el) olderPageAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    return fetchNextPage();
  }, [fetchNextPage]);

  useEffect(() => {
    olderPageAnchor.current = null;
  }, [existingChatId]);

  useEffect(() => {
    const el = lastReadRef.current;
    if (!el || !messagesChronological.length) return;

    const anchor = olderPageAnchor.current;
    const pageCount = data?.pages.length ?? 0;
    // Older messages prepend, growing the list above the viewport. Jumping to
    // the bottom there is what made paging unusable and forced the 1,000-message
    // default page. The page-count check matters: a message arriving while the
    // fetch is in flight would otherwise consume the anchor, leaving the real
    // prepend to take the jump-to-bottom branch.
    if (anchor && pageCount > anchorPageCount.current) {
      el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
      olderPageAnchor.current = null;
      anchorPageCount.current = pageCount;
    } else if (!anchor) {
      el.scrollTop = el.scrollHeight - el.clientHeight;
    }
  }, [messagesChronological, data?.pages.length]);

  useEffect(() => {
    if (!messagesChronological.length || !myMember) return;

    const newestMessageId = messagesChronological[messagesChronological.length - 1].id;
    if ((myMember.lastViewedMessageId ?? 0) >= newestMessageId) return;
    changeLastViewed({
      chatMemberId: myMember.id,
      lastViewedMessageId: newestMessageId,
    }).catch();
  }, [messagesChronological, changeLastViewed, myMember]);

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
      ) : !myMember.filteredAt &&
        (myMember.status === ChatMemberStatus.Joined ||
          myMember.status === ChatMemberStatus.Left ||
          myMember.status === ChatMemberStatus.Kicked) ? (
        <>
          <DismissibleAlert
            id="chat-scam-warning"
            className="shrink-0"
            color="yellow"
            icon={<IconAlertTriangle className="shrink-0" size={16} />}
            size="sm"
            py={6}
            px="xs"
            mx="sm"
            mt="xs"
          >
            <ScamWarningContent chatId={existingChatId!} />
          </DismissibleAlert>
          <Box py="sm" style={{ flexGrow: 1, overflowY: 'auto' }} ref={lastReadRef}>
            {isRefetching || isLoading ? (
              <Center h="100%">
                <Loader />
              </Center>
            ) : isError ? (
              <Center h="100%">
                <Text color="red">Error: {error?.message}</Text>
              </Center>
            ) : messagesChronological.length > 0 ? (
              // gap 0: row spacing is each row's own padding, so a grouped message sits
              // tight under its header instead of being spaced like a new sender.
              <Stack style={{ overflowWrap: 'break-word' }} gap={0}>
                {hasNextPage && (
                  <InViewLoader
                    loadFn={loadOlderMessages}
                    loadCondition={!isRefetching && hasNextPage}
                  >
                    <Center p="xl" style={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
                <DisplayMessages chats={messagesChronological} setReplyId={setReplyId} />
              </Stack>
            ) : (
              <Center h="100%">
                <Text>Start the conversation below!</Text>
              </Center>
            )}
            {!!typingText && (
              <Group px="sm" className={classes.isTypingBox}>
                <Text size="xs">{typingText}</Text>
                <Loader type="dots" />
              </Group>
            )}
          </Box>
          <Divider />
          {myMember.status === ChatMemberStatus.Joined ? (
            <>
              {!!replyId && (
                <Group px="sm" pt="xs" gap={8} wrap="nowrap" className={classes.replyStrip}>
                  <Text size="xs" c="blue" fw={600}>
                    Replying to
                  </Text>
                  <Text size="xs" truncate style={{ minWidth: 0 }}>
                    {stripStickerTokens(
                      messagesChronological.find((ac) => ac.id === replyId)?.content ?? ''
                    )}
                  </Text>
                  <LegacyActionIcon
                    size="sm"
                    variant="subtle"
                    onClick={() => setReplyId(undefined)}
                    ml="auto"
                    aria-label="Cancel reply"
                  >
                    <IconX size={14} />
                  </LegacyActionIcon>
                </Group>
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
      ) : !!myMember.filteredAt ||
        myMember.status === ChatMemberStatus.Invited ||
        myMember.status === ChatMemberStatus.Ignored ? (
        <Center h="100%">
          <Stack>
            <Alert color="yellow" icon={<IconAlertTriangle size={20} />} p="xs" mx="sm">
              <ScamWarningContent chatId={existingChatId!} />
            </Alert>
            {messagesChronological.length > 0 && (
              <Text mb="md" p="sm" size="xs" italic align="center">{`"${stripStickerTokens(
                messagesChronological[0].content
              ).slice(0, 70)}${
                stripStickerTokens(messagesChronological[0].content).length > 70 ? '...' : ''
              }"`}</Text>
            )}
            <Text align="center">
              {!myMember.filteredAt
                ? 'Join the chat?'
                : myMember.clearedAt && myMember.clearedAt < myMember.filteredAt
                ? 'You deleted this conversation. Accept it again?'
                : 'Accept this request?'}
            </Text>
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
  const ownedSticker = useOwnedSticker();

  const isMuted = currentUser?.muted && !isModSender;

  // Counted against what actually gets sent: sticker tokens resolve to a longer
  // `:sticker:<id>:` form, so counting the typed `:slug:` would under-report and
  // the server would reject a message the counter called fine.
  const charCount = resolveStickerTokens(chatMsg.trim(), {
    resolveSlug: (slug) => ownedSticker.bySlug.get(slug)?.id,
  }).length;
  const isOverLimit = charCount > MAX_CHAT_MESSAGE_LENGTH;

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

          // The backend returns messages grouped in chunks (pages).
          // `old.pages[0]` contains the newest chunk of messages, while older messages
          // are appended to the end of the array during infinite scrolling.
          // Therefore, newly sent messages must be appended to `pages[0]`.
          const newestPage = old.pages[0];
          newestPage.items.push(data);
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
    if (isSending || isOverLimit) return;

    // TODO can probably handle this earlier to disable from sending blank messages
    const strippedMessage = chatMsg.trim();
    if (!strippedMessage.length) {
      setChatMsg('');
      return;
    }

    setIsSending(true);
    mutate({
      chatId: existingChatId!,
      content: resolveStickerTokens(strippedMessage, {
        resolveSlug: (slug) => ownedSticker.bySlug.get(slug)?.id,
      }),
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
    <>
      <div className={classes.composerRow}>
        <StickerPicker
          surface="chat"
          disabled={isMuted}
          // The trigger sits at the composer's left edge, so anchoring the
          // dropdown's right edge to it throws the panel across the thread list.
          position="top-start"
          onSelect={(sticker) =>
            handleChatTyping(
              `${chatMsg}${chatMsg && !chatMsg.endsWith(' ') ? ' ' : ''}:${sticker.slug}: `
            )
          }
          onSelectEmoji={(char) => handleChatTyping(`${chatMsg}${char}`)}
        />
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
          classNames={{ input: classes.chatInput }}
        />
        <LegacyActionIcon
          radius="xl"
          size="lg"
          variant="filled"
          className={classes.sendButton}
          onClick={sendMessage}
          disabled={isSending || !chatMsg.length || isMuted || isOverLimit}
          aria-label="Send"
        >
          {isSending ? <Loader size="xs" /> : <IconSend size={18} />}
        </LegacyActionIcon>
      </div>
      <div className={classes.composerFoot}>
        <Text className={classes.hint}>
          <b>Enter</b> to send · <b>Shift+Enter</b> for a new line
        </Text>
        {isOverLimit && (
          <Text size="xs" c="red">
            Too long to send — trim {charCount - MAX_CHAT_MESSAGE_LENGTH} characters.
          </Text>
        )}
        <Text
          className={clsx(classes.counter, {
            [classes.near]: !isOverLimit && charCount >= COUNTER_WARN_AT,
            [classes.over]: isOverLimit,
          })}
        >
          {`${charCount} / ${MAX_CHAT_MESSAGE_LENGTH}`}
        </Text>
      </div>
    </>
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
      style={{ alignSelf: 'center' }}
      className={clsx(classes.chatMessage, classes.embedCard)}
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
  const queryUtils = trpc.useUtils();
  const { mutate: deleteMessage } = trpc.chat.deleteMessage.useMutation({
    onSuccess({ messageId, chatId }) {
      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId },
        produce((old) => {
          if (!old) return old;
          for (const page of old.pages) {
            const idx = page.items.findIndex((m) => m.id === messageId);
            if (idx !== -1) page.items.splice(idx, 1);
          }
        })
      );
      queryUtils.chat.getAllByUser.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to delete message.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });
  const existingChatId = useChatStore((state) => state.existingChatId);
  const { data: userSettings } = trpc.chat.getUserSettings.useQuery();
  const domainColor = useDomainColor();
  const replaceBadWords = userSettings?.replaceBadWords ?? false;

  const { data: allChatData } = trpc.chat.getAllByUser.useQuery();
  const tChat = allChatData?.find((chat) => chat.id === existingChatId);

  const stickerIds = useMemo(
    () => [
      ...new Set(
        chats.flatMap((c) => [
          ...parseStickerIds(c.content),
          ...(c.referenceMessage ? parseStickerIds(c.referenceMessage.content) : []),
        ])
      ),
    ],
    [chats]
  );

  const blur = replaceBadWords || domainColor === 'green';

  let loopMsgDate = new Date(1970);
  let loopPreviousChatter = 0;

  return (
    <StickerProvider ids={stickerIds}>
      <LazyMotion features={loadMotion}>
        {chats.map((c, idx) => {
          const hourDiff = (c.createdAt.valueOf() - loopMsgDate.valueOf()) / (1000 * 60 * 60);
          const sameChatter = loopPreviousChatter === c.userId;
          const shouldShowInfo = hourDiff >= 1 || !sameChatter;
          const showDayChip = !isSameDay(c.createdAt, loopMsgDate);

          loopMsgDate = c.createdAt;
          loopPreviousChatter = c.userId;

          const cachedUser = tChat?.chatMembers?.find((cm) => cm.userId === c.userId)?.user;
          const isMe = c.userId === currentUser?.id;
          const isSystemChat = c.userId === -1;

          const quotedUser = !!c.referenceMessage
            ? tChat?.chatMembers?.find((cm) => cm.userId === c.referenceMessage?.userId)?.user
            : undefined;

          return (
            <React.Fragment key={c.id}>
              {showDayChip && !isSystemChat && (
                <div className={classes.dayChip}>{dayChipLabel(c.createdAt)}</div>
              )}
              <PStack
                component={div}
                gap={0}
                style={idx === chats.length - 1 ? { paddingBottom: 12 } : {}}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12 }}
              >
                {isSystemChat && c.contentType === ChatMessageType.Embed ? (
                  <EmbedMessage content={c.content} />
                ) : isSystemChat ? (
                  <Text className={classes.systemNote} component="div" size="xs">
                    <CustomMarkdown allowedElements={['a', 'p', 'strong']} unwrapDisallowed>
                      {c.content.replace(currentUser?.username ?? '', 'You')}
                    </CustomMarkdown>
                  </Text>
                ) : (
                  <div className={clsx(classes.messageRow, { [classes.grouped]: !shouldShowInfo })}>
                    {shouldShowInfo && (
                      <Group gap={8} align="center" wrap="nowrap" className={classes.messageHead}>
                        {!!cachedUser ? (
                          <UserAvatar user={cachedUser} withUsername size="sm" />
                        ) : (
                          <UserAvatar userId={c.userId} withUsername size="sm" />
                        )}
                        <Text className={classes.messageTime}>
                          {formatDate(c.createdAt, 'h:mm A')}
                        </Text>
                      </Group>
                    )}

                    <div className={classes.messageBody}>
                      {!!c.referenceMessage && (
                        <div className={classes.replyQuote}>
                          <div className={classes.replyQuoteName}>
                            {quotedUser?.username ?? 'Unknown user'}
                          </div>
                          <div className={classes.replyQuoteText}>
                            <ChatMessageContent
                              content={c.referenceMessage.content}
                              blur={blur}
                              stickerSize={STICKER_SIZE.preview}
                              fallback={<em>Could not load message.</em>}
                            />
                          </div>
                        </div>
                      )}
                      <Tooltip
                        label={formatDate(c.createdAt, 'MMM DD, YYYY h:mm:ss a')}
                        style={{ opacity: 0.85 }}
                        openDelay={350}
                        position={isMe ? 'top-end' : 'top-start'}
                        withArrow
                      >
                        <div
                          className={clsx(classes.messageText, {
                            [classes.stickerOnlyMessage]: isStickerOnlyContent(c.content),
                          })}
                        >
                          <ChatMessageContent content={c.content} blur={blur} />
                        </div>
                      </Tooltip>
                    </div>

                    <div className={classes.messageActions}>
                      <Tooltip label="Reply" withArrow openDelay={350}>
                        <LegacyActionIcon
                          size="sm"
                          variant="subtle"
                          aria-label="Reply"
                          onClick={() => setReplyId(c.id)}
                        >
                          <IconArrowBack size={16} />
                        </LegacyActionIcon>
                      </Tooltip>
                      {(isMe || currentUser?.isModerator) && (
                        <Tooltip label="Delete" withArrow openDelay={350}>
                          <LegacyActionIcon
                            size="sm"
                            variant="subtle"
                            color="red"
                            aria-label="Delete message"
                            onClick={() =>
                              openConfirmModal({
                                title: 'Delete this message?',
                                children: (
                                  <Text size="sm">
                                    It disappears for everyone in this conversation.
                                  </Text>
                                ),
                                centered: true,
                                labels: { confirm: 'Delete', cancel: 'Cancel' },
                                confirmProps: { color: 'red' },
                                onConfirm: () => deleteMessage({ messageId: c.id }),
                              })
                            }
                          >
                            <IconTrash size={16} />
                          </LegacyActionIcon>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                )}
              </PStack>
            </React.Fragment>
          );
        })}
      </LazyMotion>
    </StickerProvider>
  );
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayChipLabel(date: Date) {
  const now = new Date();
  if (isSameDay(date, now)) return 'Today';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return 'Yesterday';

  return formatDate(date, 'MMM D, YYYY');
}

/**
 * Profanity is checked once over the whole message with sticker tokens removed —
 * splitting first would let `fu:sticker:1:ck` past the filter as two clean runs.
 */
function ChatMessageContent({
  content,
  blur,
  stickerSize,
  fallback,
}: {
  content: string;
  blur: boolean;
  stickerSize?: number;
  fallback?: React.ReactNode;
}) {
  const scannable = stripStickerTokens(content);
  const cleaned = useCleanText(scannable, { enabled: blur, replacementStyle: 'asterisk' });

  if (!content.length) return <>{fallback ?? null}</>;

  // A censored message renders as flat text, losing its sticker: re-inserting them
  // means splitting again, which is the bypass this component exists to close.
  if (cleaned !== scannable)
    return (
      <Text component="span">
        <Linkify options={linkifyOptions}>{cleaned}</Linkify>
      </Text>
    );

  return (
    <>
      {parseStickerLines(content).map((line, lineIdx) => (
        <React.Fragment key={lineIdx}>
          {/* `white-space: pre-line` renders these; splitting into lines would otherwise flatten them. */}
          {lineIdx > 0 && '\n'}
          {line.parts.map((part, idx) =>
            part.type === 'sticker' ? (
              <Sticker
                key={idx}
                cosmeticId={part.cosmeticId}
                size={stickerSize ?? (line.jumbo ? STICKER_SIZE.jumbo : STICKER_SIZE.inline)}
              />
            ) : (
              <Text
                component="span"
                key={idx}
                className={
                  !stickerSize && line.parts.length === 1 && isJumboEmojiText(part.value)
                    ? classes.jumboEmoji
                    : undefined
                }
              >
                <Linkify options={linkifyOptions}>{part.value}</Linkify>
              </Text>
            )
          )}
        </React.Fragment>
      ))}
    </>
  );
}
