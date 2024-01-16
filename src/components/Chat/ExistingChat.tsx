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
import { useDebouncedValue } from '@mantine/hooks';
import { IconSend, IconX } from '@tabler/icons-react';
import { throttle } from 'lodash-es';
import Link from 'next/link';
import React, {
  Dispatch,
  MutableRefObject,
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

// TODO handle enter key for send, shift enter for new line (when it matters)
// TODO handle scrolldown (ideally to last read)

type TypingStatus = {
  [key: string]: boolean;
};

const useStyles = createStyles((theme) => ({
  chatMessage: {
    borderRadius: theme.spacing.xs,
    padding: theme.spacing.xs,
    width: 'max-content',
    maxWidth: '70%',
    whiteSpace: 'pre-line',
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
}: {
  setOpened: Dispatch<SetStateAction<boolean>>;
  existingChat: number;
}) {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  // TODO reset chat message when clicking different group
  const [chatMsg, setChatMsg] = useState<string>('');
  const [debouncedChatMsg] = useDebouncedValue(chatMsg, 2000);
  const [isSending, setIsSending] = useState(false);
  const lastReadRef = useRef<HTMLDivElement>(null);
  const { connected, worker } = useSignalContext();
  const [typingStatus, setTypingStatus] = useState<TypingStatus>({});
  const [typingText, setTypingText] = useState<string | null>(null);

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
    async onSuccess() {
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

  const { mutateAsync: doIsTyping } = trpc.chat.isTyping.useMutation();

  const allChats = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  useEffect(() => {
    if (!allChats.length) return;
    // TODO this doesn't quite scroll all the way down, need to add some padding here
    lastReadRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' });
  }, [allChats]);

  useEffect(() => {
    setTypingStatus({});
    setTypingText(null);
  }, [existingChat]);

  const handleIsTyping = useCallback(
    (d: unknown) => {
      const data = d as isTypingOutput;

      if (data.userId === currentUser?.id) return;
      if (data.chatId !== existingChat) return;

      const newEntry = {
        [data.username]: data.isTyping,
      };

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

    throttledTyping();
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
      {chats.map((c, idx) => (
        // TODO probably combine messages if within a certain amount of time
        <Stack
          ref={c.id === lastReadId ? lastReadRef : undefined}
          key={c.id}
          spacing="xs"
          style={idx === chats.length - 1 ? { marginBottom: 12 } : {}}
        >
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
        </Stack>
      ))}
    </>
  );
}
