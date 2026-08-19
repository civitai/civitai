import type { GroupProps } from '@mantine/core';
import {
  Badge,
  Box,
  Button,
  Center,
  createPolymorphicComponent,
  Divider,
  Group,
  Highlight,
  Image,
  Indicator,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconCirclePlus,
  IconCloudOff,
  IconEye,
  IconPin,
  IconPlugConnected,
  IconSearch,
  IconSettings,
  IconUsers,
  IconUserX,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import { LazyMotion } from 'motion/react';
import { div } from 'motion/react-m';
import React, { useEffect, useState } from 'react';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { loadMotion } from '~/components/Chat/util';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';
import type { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import styles from './ChatList.module.css';
import clsx from 'clsx';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';
import { BlurText } from '~/components/BlurText/BlurText';
import { useDomainColor } from '~/hooks/useDomainColor';
import { stripStickerTokens } from '~/shared/utils/sticker-token';
import type { ChatBucket } from '~/shared/utils/chat';
import { chatBucketFor } from '~/shared/utils/chat';

const PGroup = createPolymorphicComponent<'div', GroupProps>(Group);

// export const chatListStyles = createStyles((theme) => ({
//   selectChat: {
//     cursor: 'pointer',
//     borderRadius: theme.spacing.xs,
//     padding: theme.spacing.xs,
//     paddingTop: '6px',
//     paddingBottom: '6px',
//     '&:hover': {
//       backgroundColor: theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.2),
//     },
//   },
//   selectedChat: {
//     backgroundColor: `${theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.5)} !important`,
//   },
// }));

export function ChatList() {
  const existingChatId = useChatStore((state) => state.existingChatId);
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [searchInput, setSearchInput] = useState<string>('');
  const [activeTab, setActiveTab] = useState<ChatBucket>('Inbox');
  const [filteredData, setFilteredData] = useState<ChatListMessage[]>([]);
  const { connected } = useSignalContext();
  const isMobile = useContainerSmallerThan(700);
  const domainColor = useDomainColor();
  const { data: userSettings } = trpc.chat.getUserSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const replaceBadWords = userSettings?.replaceBadWords ?? false;

  const { data, isLoading } = trpc.chat.getAllByUser.useQuery();
  const chatCounts = queryUtils.chat.getUnreadCount.getData();

  const requestCount = !!data
    ? data.filter((d) => {
        const myMember = d.chatMembers.find((cm) => cm.userId === currentUser?.id);
        return !!myMember && chatBucketFor(myMember) === 'Requests';
      }).length
    : 0;

  const activeIds = !!data
    ? data
        .filter(
          (d) =>
            d.chatMembers.find((cm) => cm.userId === currentUser?.id)?.status ===
            ChatMemberStatus.Joined
        )
        .map((d) => d.id)
    : [];

  const activeCount = !!chatCounts
    ? chatCounts.reduce((acc, val) => {
        if (activeIds.includes(val.chatId)) return acc + val.cnt;
        return acc;
      }, 0)
    : 0;

  const { mutate: markAsRead } = trpc.chat.markAllAsRead.useMutation({
    onSuccess(data) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          for (const changed of data) {
            const tChat = old.find((c) => c.id === changed.chatId);
            const tMember = tChat?.chatMembers?.find((cm) => cm.userId === currentUser?.id);
            if (!tMember) continue;

            tMember.lastViewedMessageId = changed.lastViewedMessageId;
          }
        })
      );
      queryUtils.chat.getUnreadCount.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          for (const changed of data) {
            const tChat = old.find((c) => c.chatId === changed.chatId);
            if (!tChat) continue;

            tChat.cnt = 0;
          }
        })
      );
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to mark as read.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  useEffect(() => {
    if (!data) return;
    const activeMember = data
      .find((d) => d.id === existingChatId)
      ?.chatMembers?.find((cm) => cm.userId === currentUser?.id);
    if (!activeMember) return;
    setActiveTab(chatBucketFor(activeMember));
  }, [currentUser?.id, data, existingChatId]);

  useEffect(() => {
    if (!data) return;

    const tabData = data.filter((d) => {
      const myMember = d.chatMembers.find((cm) => cm.userId === currentUser?.id);
      return !!myMember && chatBucketFor(myMember) === activeTab;
    });

    // TODO we could probably search all messages, but that involves another round trip to grab ALL messages for all chats
    //      or at least a new endpoint for searching
    const tabFiltered =
      searchInput.length > 0
        ? tabData.filter((d) => {
            if (
              d.chatMembers
                .filter((cm) => cm.userId !== currentUser?.id)
                .some((cm) => cm.user.username?.toLowerCase().includes(searchInput))
            )
              return d;
          })
        : tabData;

    const pinnedFor = (chat: ChatListMessage) =>
      !!chat.chatMembers.find((cm) => cm.userId === currentUser?.id)?.pinnedAt;

    tabFiltered.sort((a, b) => {
      const pinDiff = Number(pinnedFor(b)) - Number(pinnedFor(a));
      if (pinDiff !== 0) return pinDiff;

      const aDate = a.messages[0]?.createdAt ?? a.createdAt;
      const bDate = b.messages[0]?.createdAt ?? b.createdAt;
      return aDate < bDate ? 1 : -1;
    });

    setFilteredData(tabFiltered);
  }, [currentUser?.id, data, searchInput, activeTab]);

  return (
    <Stack gap={0} h="100%">
      <Group p="sm" justify="space-between" align="center">
        <Group gap="xs">
          <Tooltip label="Chat settings">
            <LegacyActionIcon
              variant="light"
              aria-label="Chat settings"
              onClick={() =>
                useChatStore.setState({ isSettingsOpen: true, settingsScope: 'global' })
              }
            >
              <IconSettings size={18} strokeWidth={1.5} />
            </LegacyActionIcon>
          </Tooltip>
          <Text>Chats</Text>
          {!connected && (
            <Tooltip label="Not connected. May not receive live messages or alerts.">
              <IconPlugConnected color="orangered" />
            </Tooltip>
          )}
        </Group>
        <Group gap="xs">
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            disabled={activeCount === 0}
            leftSection={<IconEye size={14} />}
            onClick={() => markAsRead()}
          >
            {`Mark all read${activeCount > 0 ? ` (${activeCount})` : ''}`}
          </Button>
          <Button
            size="xs"
            variant="light"
            styles={{ section: { marginRight: 6 } }}
            leftSection={<IconCirclePlus size={18} />}
            onClick={() => {
              useChatStore.setState({
                isCreating: true,
                existingChatId: undefined,
                isSettingsOpen: false,
              });
            }}
          >
            New
          </Button>

          {isMobile && (
            <LegacyActionIcon onClick={() => useChatStore.setState({ open: false })}>
              <IconX />
            </LegacyActionIcon>
          )}
        </Group>
      </Group>
      <Box p="sm" pt={0}>
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="Filter by user"
          value={searchInput}
          onChange={(event) => setSearchInput(event.currentTarget.value.toLowerCase())}
          rightSection={
            <LegacyActionIcon
              onClick={() => {
                setSearchInput('');
              }}
              disabled={!searchInput.length}
            >
              <IconX size={16} />
            </LegacyActionIcon>
          }
        />
      </Box>
      <Divider />
      <Box>
        <SegmentedControl
          value={activeTab}
          onChange={(value) => setActiveTab(value as ChatBucket)}
          fullWidth
          data={[
            { value: 'Inbox', label: 'Inbox' },
            {
              value: 'Requests',
              label: (
                <Center>
                  {requestCount > 0 && (
                    <Badge p={5} color="gray" variant="filled">
                      {requestCount > 9 ? '9+' : requestCount}
                    </Badge>
                  )}
                  <Box ml={6}>Requests</Box>
                </Center>
              ),
            },
            { value: 'Archived', label: 'Archived' },
          ]}
        />
      </Box>
      <Box h="100%" style={{ overflowY: 'auto' }}>
        {isLoading ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : !filteredData || filteredData.length === 0 ? (
          <Stack p="sm" align="center">
            <Text>No chats.</Text>
            <IconCloudOff size={36} />
          </Stack>
        ) : (
          <Stack p="xs" gap={4}>
            <LazyMotion features={loadMotion}>
              {filteredData.map((d) => {
                const myMember = d.chatMembers.find((cm) => cm.userId === currentUser?.id);
                const otherMembers = d.chatMembers.filter((cm) => cm.userId !== currentUser?.id);
                const unreadCount =
                  myMember?.status === ChatMemberStatus.Invited
                    ? 0
                    : chatCounts?.find((cc) => cc.chatId === d.id)?.cnt;
                const isModSender = !!otherMembers.find(
                  (om) => om.isOwner === true && om.user.isModerator === true
                );
                const hasMod = otherMembers.some((om) => om.user.isModerator === true);

                return (
                  <PGroup
                    key={d.id}
                    component={div}
                    wrap="nowrap"
                    className={clsx(styles.selectChat, {
                      [styles.selectedChat]: d.id === existingChatId,
                    })}
                    initial={{ y: -20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ type: 'spring', duration: 0.4 }}
                    onClick={() => {
                      useChatStore.setState({ existingChatId: d.id, isSettingsOpen: false });
                    }}
                  >
                    <Indicator
                      color="red"
                      position="top-start"
                      disabled={!unreadCount || unreadCount === 0}
                      label={unreadCount}
                      size={16}
                      inline
                    >
                      <Box>
                        {otherMembers.length > 1 ? (
                          <IconUsers width={26} />
                        ) : otherMembers.length === 0 ? (
                          <IconUserX width={26} />
                        ) : (
                          <UserAvatar user={otherMembers[0].user} />
                        )}
                      </Box>
                    </Indicator>
                    <Stack style={{ overflow: 'hidden' }} gap={0}>
                      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                        <Highlight
                          size="sm"
                          fw={500}
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            minWidth: 0,
                          }}
                          c={hasMod ? 'red' : undefined}
                          highlight={searchInput}
                        >
                          {otherMembers.map((cm) => cm.user.username).join(', ')}
                        </Highlight>
                        {!!myMember?.pinnedAt && (
                          <IconPin size={12} style={{ flex: 'none', opacity: 0.6 }} />
                        )}
                      </Group>
                      {/* TODO this is kind of a hack, we should be returning only valid latest message */}
                      {!!d.messages[0]?.content && myMember?.status === ChatMemberStatus.Joined && (
                        <BlurText
                          size="xs"
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            minWidth: 0,
                          }}
                          blur={replaceBadWords || domainColor === 'green'}
                        >
                          {stripStickerTokens(d.messages[0].content)}
                        </BlurText>
                      )}
                    </Stack>
                    {isModSender && (
                      <Tooltip
                        withArrow={false}
                        label="Moderator chat"
                        style={{ border: '1px solid gray' }}
                      >
                        <Image src="/images/civ-c.png" alt="Moderator" className="size-4" />
                      </Tooltip>
                    )}
                  </PGroup>
                );
              })}
            </LazyMotion>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
