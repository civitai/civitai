import {
  ActionIcon,
  Box,
  Center,
  createStyles,
  Divider,
  Group,
  Input,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import { IconCirclePlus, IconSearch, IconUser, IconUsers, IconX } from '@tabler/icons-react';
import React, { Dispatch, SetStateAction } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

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
      {/* TODO search  */}
      <Box p="sm" pt={0}>
        <Input
          icon={<IconSearch size={16} />}
          placeholder="Search"
          rightSection={
            <ActionIcon onClick={() => {}}>
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
        ) : !data || data.length === 0 ? (
          <Stack p="sm">
            <Text>No chats.</Text>
            <Text>Get started by hitting the &quot;plus&quot;sign above.</Text>
          </Stack>
        ) : (
          <Stack p="xs" spacing={4}>
            {data.map((d) => {
              return (
                <Group
                  key={d.id}
                  noWrap
                  className={cx(classes.selectChat, {
                    [classes.selectedChat]: d.id === existingChat,
                  })}
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
                </Group>
              );
            })}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
