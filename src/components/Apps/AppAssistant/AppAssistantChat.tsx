import type { FC, Ref } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Center, Loader } from '@mantine/core';
import type { ChatMcpServer, ChatTool, CivitaiChat } from '@civitai/components-chat/civitai-chat';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import { appAssistantHoldsScopes } from '~/shared/constants/app-assistant.constants';
import classes from './AppAssistant.module.scss';

const ChatTag = 'civitai-chat' as unknown as FC<{
  ref: Ref<HTMLElement>;
  scope: string;
  className?: string;
}>;

export interface AppAssistantChatProps {
  tokens: AssistantTokenProvider;
  tools: Record<string, ChatTool>;
  instructions: () => string;
  /** Connections are kept while each entry's `id` and `url` stay the same. */
  mcpServers: ChatMcpServer[];
}

export function AppAssistantChat({
  tokens,
  tools,
  instructions,
  mcpServers,
}: AppAssistantChatProps) {
  const ref = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Client-only: the element and its SDK touch `customElements` and `window` at import.
      const [{ initialize }] = await Promise.all([
        import('@civitai/sdk'),
        import('@civitai/components-chat/civitai-chat/define'),
      ]);
      await customElements.whenDefined('civitai-chat');
      const app = await initialize({
        token: () => tokens.getToken(),
        refresh: () => tokens.getToken({ refresh: true }),
        requestGrants: (scopes) => appAssistantHoldsScopes(scopes),
      });
      if (cancelled || !ref.current) return;
      // Set after upgrade: a property assigned before would shadow the element's accessor.
      (ref.current as CivitaiChat).app = app;
      setReady(true);
    })().catch(() => {
      if (!cancelled) setError('The assistant could not start. Reload the page to try again.');
    });
    return () => {
      cancelled = true;
    };
  }, [tokens]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    const el = ref.current as CivitaiChat;
    el.tools = tools;
    el.instructions = instructions;
  }, [ready, tools, instructions]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    (ref.current as CivitaiChat).mcpServers = mcpServers;
  }, [ready, mcpServers]);

  if (error)
    return (
      <Alert color="red" variant="light" m="md">
        {error}
      </Alert>
    );

  return (
    <div className="relative h-full min-h-0">
      {!ready && (
        <Center className="absolute inset-0">
          <Loader size="sm" />
        </Center>
      )}
      <ChatTag ref={ref} scope="app-assistant" className={classes.chat} />
    </div>
  );
}
