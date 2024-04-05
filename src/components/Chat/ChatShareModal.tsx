import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Highlight,
  Image,
  Loader,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { ChatMemberStatus } from '@prisma/client';
import {
  IconCloudOff,
  IconSearch,
  IconSend,
  IconUsers,
  IconUserX,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import React, { useEffect, useState } from 'react';
import { chatListStyles } from '~/components/Chat/ChatList';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const { openModal: openChatShareModal, Modal } = createContextModal<{ message: string }>({
  name: 'chatShareModal',
  title: 'Send Chat',
  size: 'sm',
  Element: ({ context, props }) => {
    const currentUser = useCurrentUser();
    const { setState } = useChatContext();
    const queryUtils = trpc.useUtils();
    const { classes, cx } = chatListStyles();
    const [filteredData, setFilteredData] = useState<ChatListMessage[]>([]);
    const [searchInput, setSearchInput] = useState<string>('');
    const [selectedChat, setSelectedChat] = useState<number | undefined>(undefined);
    const [isSending, setIsSending] = useState(false);

    const { data, isLoading } = trpc.chat.getAllByUser.useQuery();

    useEffect(() => {
      if (!data) return;

      const activeData = data.filter((d) => {
        const tStatus = d.chatMembers.find((cm) => cm.userId === currentUser?.id)?.status;
        if (tStatus === ChatMemberStatus.Joined) return d;
      });

      const activeFiltered =
        searchInput.length > 0
          ? activeData.filter((d) => {
              if (
                d.chatMembers
                  .filter((cm) => cm.userId !== currentUser?.id)
                  .some((cm) => cm.user.username?.toLowerCase().includes(searchInput))
              )
                return d;
            })
          : activeData;

      activeFiltered.sort((a, b) => {
        const aDate = a.messages[0]?.createdAt ?? a.createdAt;
        const bDate = b.messages[0]?.createdAt ?? b.createdAt;
        return aDate < bDate ? 1 : -1;
      });

      setFilteredData(activeFiltered);
    }, [currentUser?.id, data, searchInput]);

    const { mutate } = trpc.chat.createMessage.useMutation({
      onSuccess(data) {
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
        setState((prev) => ({ ...prev, existingChatId: selectedChat, open: true }));
        context.close();
        setIsSending(false);
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

    const handleClick = () => {
      if (!selectedChat) return;

      setIsSending(true);
      mutate({
        chatId: selectedChat,
        content: props.message,
      });
    };

    return (
      <Stack spacing={0} h="100%">
        <Box p="sm" pt={0}>
          <TextInput
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
        <Box h="100%" mah={500} sx={{ overflowY: 'auto' }}>
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
              {filteredData.map((d) => {
                const myMember = d.chatMembers.find((cm) => cm.userId === currentUser?.id);
                const otherMembers = d.chatMembers.filter((cm) => cm.userId !== currentUser?.id);
                const isModSender = !!otherMembers.find(
                  (om) => om.isOwner === true && om.user.isModerator === true
                );
                const hasMod = otherMembers.some((om) => om.user.isModerator === true);

                return (
                  <Group
                    key={d.id}
                    noWrap
                    className={cx(classes.selectChat, {
                      [classes.selectedChat]: d.id === selectedChat,
                    })}
                    onClick={() => {
                      setSelectedChat(d.id);
                    }}
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
                          <Image src="/images/civ-c.png" alt="Moderator" width={16} height={16} />
                        </Tooltip>
                      )}
                    </Group>
                  </Group>
                );
              })}
            </Stack>
          )}
        </Box>
        <Divider />
        <Group py="sm">
          <Badge>Message:</Badge>
          <Text size="sm" fs="italic">
            {props.message}
          </Text>
        </Group>
        <Divider />
        <Button
          loading={isSending}
          disabled={!selectedChat}
          leftIcon={<IconSend />}
          onClick={handleClick}
        >
          Send
        </Button>
      </Stack>
    );
  },
});

export { openChatShareModal };
export default Modal;
