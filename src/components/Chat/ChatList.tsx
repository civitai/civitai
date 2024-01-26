import {
  ActionIcon,
  Box,
  Center,
  createPolymorphicComponent,
  createStyles,
  Divider,
  Group,
  GroupProps,
  Indicator,
  Input,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconBadge,
  IconCirclePlus,
  IconCloudOff,
  IconSearch,
  IconUsers,
  IconUserX,
  IconX,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import React, { useState } from 'react';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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
  modChat: {
    backgroundColor: theme.fn.rgba(theme.colors.red[theme.fn.primaryShade()], 0.05),
    '&:hover': {
      backgroundColor: theme.fn.rgba(theme.colors.red[theme.fn.primaryShade()], 0.2),
    },
  },
  modSelectedChat: {
    backgroundColor: `${theme.fn.rgba(theme.colors.red[theme.fn.primaryShade()], 0.4)} !important`,
  },
}));

export function ChatList() {
  const { state, setState } = useChatContext();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useUtils();
  const [searchInput, setSearchInput] = useState<string>('');

  const { data, isLoading } = trpc.chat.getAllByUser.useQuery();
  const chatCounts = queryUtils.chat.getUnreadCount.getData();

  // TODO we could probably search all messages, but that involves another round trip to grab ALL messages for all chats
  //      or at least a new endpoint for searching
  const filteredData =
    searchInput.length > 0 && !!data
      ? data.filter((d) => {
          if (
            d.chatMembers
              .filter((cm) => cm.userId !== currentUser?.id)
              .some((cm) => cm.user.username?.toLowerCase().includes(searchInput))
          )
            return d;
        })
      : data;

  return (
    <Stack spacing={0} h="100%">
      <Group p="sm" position="apart" align="center">
        <Text>Chats</Text>
        <ActionIcon>
          <IconCirclePlus
            onClick={() => {
              setState((prev) => ({ ...prev, isCreating: true, existingChatId: undefined }));
            }}
          />
        </ActionIcon>
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
            >
              <IconX size={16} />
            </ActionIcon>
          }
        />
      </Box>
      <Divider />
      <Box h="100%" sx={{ overflowY: 'auto' }}>
        {isLoading ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : !filteredData || filteredData.length === 0 ? (
          <Stack p="sm" align="center">
            <Text>No chats yet.</Text>
            <IconCloudOff size={36} />
          </Stack>
        ) : (
          <Stack p="xs" spacing={4}>
            <AnimatePresence initial={false} mode="sync">
              {filteredData.map((d) => {
                const unreadCount = chatCounts?.find((cc) => cc.chatId === d.id)?.cnt;
                const otherMembers = d.chatMembers.filter((cm) => cm.userId !== currentUser?.id);
                const isModSender = !!otherMembers.find(
                  (om) => om.isOwner === true && om.user.isModerator === true
                );
                return (
                  <PGroup
                    key={d.id}
                    component={motion.div}
                    noWrap
                    className={cx(classes.selectChat, {
                      [classes.modChat]: isModSender,
                      [classes.selectedChat]: !isModSender && d.id === state.existingChatId,
                      [classes.modSelectedChat]: isModSender && d.id === state.existingChatId,
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
                          <IconUsers />
                        ) : otherMembers.length === 0 ? (
                          <IconUserX />
                        ) : (
                          <UserAvatar userId={otherMembers[0].userId} />
                        )}
                      </Box>
                    </Indicator>
                    <Stack sx={{ overflow: 'hidden' }} spacing={0}>
                      <Text
                        size="sm"
                        fw={500}
                        sx={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          minWidth: 0,
                        }}
                      >
                        {otherMembers.map((cm) => cm.user.username).join(', ')}
                      </Text>
                      {!!d.messages[0]?.content && (
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
                    {isModSender && (
                      <Tooltip
                        withArrow={false}
                        label="Moderator chat"
                        sx={{ border: '1px solid gray' }}
                      >
                        <ThemeIcon
                          size="xs"
                          color="violet"
                          variant="filled"
                          sx={{ marginLeft: 'auto' }}
                        >
                          <IconBadge />
                        </ThemeIcon>
                      </Tooltip>
                    )}
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
