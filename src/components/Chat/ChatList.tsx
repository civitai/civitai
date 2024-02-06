import {
  ActionIcon,
  Badge,
  Box,
  Center,
  createPolymorphicComponent,
  createStyles,
  Divider,
  Group,
  GroupProps,
  Highlight,
  Indicator,
  Input,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { ChatMemberStatus } from '@prisma/client';
import {
  IconCirclePlus,
  IconCloudOff,
  IconPlugConnected,
  IconSearch,
  IconUsers,
  IconUserX,
  IconX,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useState } from 'react';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ChatListMessage } from '~/types/router';
import { trpc } from '~/utils/trpc';

const PGroup = createPolymorphicComponent<'div', GroupProps>(Group);

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

const statusMap = {
  [ChatMemberStatus.Invited]: 'Pending',
  [ChatMemberStatus.Ignored]: 'Archived',
  [ChatMemberStatus.Left]: 'Archived',
  [ChatMemberStatus.Kicked]: 'Archived',
  [ChatMemberStatus.Joined]: 'Active',
};
type StatusKeys = keyof typeof statusMap;
type StatusValues = (typeof statusMap)[StatusKeys];

export function ChatList() {
  const { state, setState } = useChatContext();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useUtils();
  const [searchInput, setSearchInput] = useState<string>('');
  const [activeTab, setActiveTab] = useState<StatusValues>('Active');
  const [filteredData, setFilteredData] = useState<ChatListMessage[]>([]);
  const { connected } = useSignalContext();
  const isMobile = useIsMobile();

  const { data, isLoading } = trpc.chat.getAllByUser.useQuery();
  const chatCounts = queryUtils.chat.getUnreadCount.getData();

  const pendingCount = !!data
    ? data.filter(
        (d) =>
          d.chatMembers.find((cm) => cm.userId === currentUser?.id)?.status ===
          ChatMemberStatus.Invited
      ).length
    : 0;

  useEffect(() => {
    if (!data) return;
    const activeStatus = data
      .find((d) => d.id === state.existingChatId)
      ?.chatMembers?.find((cm) => cm.userId === currentUser?.id)?.status;
    if (!activeStatus) return;
    const defaultActiveTab = statusMap[activeStatus];
    setActiveTab(defaultActiveTab);
  }, [currentUser?.id, data, state.existingChatId]);

  useEffect(() => {
    if (!data) return;

    const tabData = data.filter((d) => {
      const tStatus = d.chatMembers.find((cm) => cm.userId === currentUser?.id)?.status;
      if (!tStatus) return;
      if (statusMap[tStatus] === activeTab) return d;
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

    tabFiltered.sort((a, b) => {
      const aDate = a.messages[0]?.createdAt ?? a.createdAt;
      const bDate = b.messages[0]?.createdAt ?? b.createdAt;
      return aDate < bDate ? 1 : -1;
    });

    setFilteredData(tabFiltered);
  }, [currentUser?.id, data, searchInput, activeTab]);

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart" align="center">
        <Group>
          <Text>Chats</Text>
          {!connected && (
            <Tooltip label="Not connected. May not receive live messages or alerts.">
              <IconPlugConnected color="orangered" />
            </Tooltip>
          )}
        </Group>
        <Group>
          <ActionIcon>
            <IconCirclePlus
              onClick={() => {
                setState((prev) => ({ ...prev, isCreating: true, existingChatId: undefined }));
              }}
            />
          </ActionIcon>
          {isMobile && (
            <ActionIcon onClick={() => setState((prev) => ({ ...prev, open: false }))}>
              <IconX />
            </ActionIcon>
          )}
        </Group>
      </Group>
      <Box p="sm" pt={0}>
        <Input
          icon={<IconSearch size={16} />}
          placeholder="Filter by user"
          value={searchInput}
          onChange={(event) => setSearchInput(event.currentTarget.value.toLowerCase())}
          rightSection={
            <ActionIcon
              onClick={() => {
                setSearchInput('');
              }}
              disabled={!searchInput.length}
            >
              <IconX size={16} />
            </ActionIcon>
          }
        />
      </Box>
      <Divider />
      <Box>
        <SegmentedControl
          value={activeTab}
          onChange={setActiveTab}
          fullWidth
          data={[
            { value: 'Active', label: 'Active' },
            {
              value: 'Pending',
              label: (
                <Center>
                  {pendingCount > 0 && (
                    <Badge p={5} color="red" variant="filled">
                      {pendingCount > 9 ? '9+' : pendingCount}
                    </Badge>
                  )}
                  <Box ml={6}>Pending</Box>
                </Center>
              ),
            },
            { value: 'Archived', label: 'Archived' },
          ]}
        />
      </Box>
      <Box h="100%" sx={{ overflowY: 'auto' }}>
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
          <Stack p="xs" spacing={4}>
            <AnimatePresence initial={false} mode="sync">
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
                    component={motion.div}
                    noWrap
                    className={cx(classes.selectChat, {
                      [classes.selectedChat]: d.id === state.existingChatId,
                    })}
                    initial={{ y: -20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ type: 'spring', duration: 0.4 }}
                    onClick={() => {
                      setState((prev) => ({ ...prev, existingChatId: d.id }));
                    }}
                  >
                    <Indicator
                      color="red"
                      position="top-start"
                      disabled={!unreadCount || unreadCount === 0}
                      label={unreadCount}
                      inline
                      size={16}
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
                    <Stack sx={{ overflow: 'hidden' }} spacing={0}>
                      <Highlight
                        size="sm"
                        fw={500}
                        sx={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          minWidth: 0,
                        }}
                        color={hasMod ? 'red' : undefined}
                        highlight={searchInput}
                      >
                        {otherMembers.map((cm) => cm.user.username).join(', ')}
                      </Highlight>
                      {/* TODO this is kind of a hack, we should be returning only valid latest message */}
                      {!!d.messages[0]?.content && myMember?.status === ChatMemberStatus.Joined && (
                        <Text
                          size="xs"
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
                    <Group sx={{ marginLeft: 'auto' }} noWrap spacing={6}>
                      {isModSender && (
                        <Tooltip
                          withArrow={false}
                          label="Moderator chat"
                          sx={{ border: '1px solid gray' }}
                        >
                          <ThemeIcon size="xs" variant="light">
                            {/*<IconBadge />*/}
                            {/* TODO don't do the uuid thing */}
                            <EdgeMedia src={'c8f81b5d-b271-4ad4-0eeb-64c42621e300'} />
                          </ThemeIcon>
                        </Tooltip>
                      )}
                    </Group>
                  </PGroup>
                );
              })}
            </AnimatePresence>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
