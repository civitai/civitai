import { Grid, useComputedColorScheme } from '@mantine/core';
import { registerCustomProtocol } from 'linkifyjs';
import React from 'react';
import { ChatList } from '~/components/Chat/ChatList';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { ExistingChat } from '~/components/Chat/ExistingChat';
import { NewChat } from '~/components/Chat/NewChat';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';

registerCustomProtocol('civitai', true);

export function ChatWindow() {
  return (
    <ContainerProvider containerName="chat-window" className="size-full card">
      <ChatWindowContent />
    </ContainerProvider>
  );
}

function ChatWindowContent() {
  const existingChatId = useChatStore((state) => state.existingChatId);
  const isCreating = useChatStore((state) => state.isCreating);
  const colorScheme = useComputedColorScheme('dark');

  const isMobile = useContainerSmallerThan(700);

  if (isMobile) {
    if (!!existingChatId) return <ExistingChat />;
    if (isCreating) return <NewChat />;
    return <ChatList />;
  }

  return (
    <Grid h="100%" classNames={{ inner: 'h-full' }} gutter={0} overflow="hidden">
      {/* List and Search Panel */}
      <Grid.Col
        span={{ base: 12, xs: 4 }}
        style={{
          borderRight: colorScheme === 'dark' ? '1px solid #373A40' : '1px solid #CED4DA',
          height: '100%',
        }}
      >
        <ChatList />
      </Grid.Col>
      {/* Chat Panel */}
      <Grid.Col span={{ base: 12, xs: 8 }} h="100%">
        {!existingChatId ? <NewChat /> : <ExistingChat />}
      </Grid.Col>
    </Grid>
  );
}
