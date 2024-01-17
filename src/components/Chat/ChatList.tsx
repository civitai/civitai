import {
  ActionIcon,
  Box,
  Center,
  createPolymorphicComponent,
  createStyles,
  Divider,
  Group,
  GroupProps,
  Input,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconCirclePlus,
  IconCloudOff,
  IconSearch,
  IconUser,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import React, { Dispatch, SetStateAction, useState } from 'react';
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
}));

export function ChatList({
  existingChat,
  setNewChat,
  setExistingChat,
}: {
  existingChat: number | undefined;
  setNewChat: Dispatch<SetStateAction<boolean>>;
  setExistingChat: Dispatch<SetStateAction<number | undefined>>;
}) {
  const { data, isLoading } = trpc.chat.getAllByUser.useQuery();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const [searchInput, setSearchInput] = useState<string>('');

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
              setExistingChat(undefined);
              setNewChat(true);
            }}
          />
        </ActionIcon>
      </Group>
      <Box p="sm" pt={0}>
        <Input
          icon={<IconSearch size={16} />}
          placeholder="Search users"
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
                return (
                  <PGroup
                    key={d.id}
                    component={motion.div}
                    noWrap
                    className={cx(classes.selectChat, {
                      [classes.selectedChat]: d.id === existingChat,
                    })}
                    initial={{ y: -20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ type: 'spring', duration: 0.4 }}
                    onClick={() => {
                      setExistingChat(d.id);
                      setNewChat(false);
                    }}
                  >
                    <Box>{d.chatMembers.length > 2 ? <IconUsers /> : <IconUser />}</Box>
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
                        {d.chatMembers
                          .filter((cm) => cm.userId !== currentUser?.id)
                          .map((cm) => cm.user.username)
                          .join(', ')}
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
