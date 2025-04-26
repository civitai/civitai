import { Grid } from '@mantine/core';
import React from 'react';
import { ChatList } from '~/components/Chat/ChatList';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { ExistingChat } from '~/components/Chat/ExistingChat';
import { NewChat } from '~/components/Chat/NewChat';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import styles from './ChatWindow.module.scss';

export function ChatWindow() {
  return (
    <ContainerProvider containerName="chat-window" className="size-full card">
      <ChatWindowContent />
    </ContainerProvider>
  );
}

function ChatWindowContent() {
  const { state } = useChatContext();
  const isMobile = useContainerSmallerThan(700);

  if (isMobile) {
    if (!!state.existingChatId) return <ExistingChat />;
    if (state.isCreating) return <NewChat />;
    return <ChatList />;
  }

  return (
    <Grid h="100%" m={0}>
      {/* List and Search Panel */}
      <Grid.Col span={12} xs={4} p={0} className={styles.chatList}>
        <ChatList />
      </Grid.Col>
      {/* Chat Panel */}
      <Grid.Col span={12} xs={8} p={0} h="100%">
        {!state.existingChatId ? <NewChat /> : <ExistingChat />}
      </Grid.Col>
    </Grid>
  );
}

