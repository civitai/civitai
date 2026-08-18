import { Grid, useComputedColorScheme } from '@mantine/core';
import { registerCustomProtocol } from 'linkifyjs';
import React from 'react';
import { ChatList } from '~/components/Chat/ChatList';
import { ChatListV1 } from '~/components/Chat/ChatListV1';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { ChatSettings } from '~/components/Chat/ChatSettings';
import { ExistingChat } from '~/components/Chat/ExistingChat';
import { ExistingChatV1 } from '~/components/Chat/ExistingChatV1';
import { NewChat } from '~/components/Chat/NewChat';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import classes from './Chat.module.scss';

registerCustomProtocol('civitai', true);

export function ChatWindow() {
  return (
    <ContainerProvider containerName="chat-window" className={`size-full card ${classes.surface}`}>
      <ChatWindowContent />
    </ContainerProvider>
  );
}

function ChatWindowContent() {
  const existingChatId = useChatStore((state) => state.existingChatId);
  const isCreating = useChatStore((state) => state.isCreating);
  const isSettingsOpen = useChatStore((state) => state.isSettingsOpen);
  const colorScheme = useComputedColorScheme('dark');
  const features = useFeatureFlags();

  const isMobile = useContainerSmallerThan(700);

  // The redesign replaced the message surface rather than extending it, so the
  // previous chat ships alongside it until the flag ramps (868kguhpy).
  const redesign = !!features.chatRedesign;
  const List = redesign ? ChatList : ChatListV1;
  const Conversation = redesign ? ExistingChat : ExistingChatV1;

  if (isMobile) {
    if (redesign && isSettingsOpen) return <ChatSettings />;
    if (!!existingChatId) return <Conversation />;
    if (isCreating) return <NewChat />;
    return <List />;
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
        <List />
      </Grid.Col>
      {/* Chat Panel */}
      <Grid.Col span={{ base: 12, xs: 8 }} h="100%">
        {redesign && isSettingsOpen ? (
          <ChatSettings />
        ) : !existingChatId ? (
          <NewChat />
        ) : (
          <Conversation />
        )}
      </Grid.Col>
    </Grid>
  );
}
