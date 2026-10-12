import type { FC, Ref } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Center, Loader } from '@mantine/core';
import type { ChatTool } from '@civitai/components-chat/civitai-chat';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import classes from './AppAssistant.module.scss';

/**
 * An MCP server whose tools join the assistant's.
 * TODO(@civitai/components-chat 0.4.0): delete this and `ChatElement`'s `mcpServers` in favour of
 * the package's own types once the dependency is bumped to the release that ships the property.
 */
export interface ChatMcpServer {
  id: string;
  url: string;
  token?: () => string | Promise<string>;
  label?: string;
}

type ChatElement = HTMLElement & {
  app?: unknown;
  tools?: Record<string, ChatTool>;
  instructions?: string | (() => string | undefined);
  mcpServers?: ChatMcpServer[];
};

const ChatTag = 'civitai-chat' as unknown as FC<{
  ref: Ref<HTMLElement>;
  scope: string;
  className?: string;
}>;

export interface AppAssistantChatProps {
  tokens: AssistantTokenProvider;
  tools: Record<string, ChatTool>;
  instructions: () => string;
  /** Pass a stable array: a new array reconnects the servers. */
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
        // The token route already holds `ai:write:budgeted` for this session.
        requestGrants: () => true,
      });
      if (cancelled || !ref.current) return;
      // Set after upgrade: a property assigned before would shadow the element's accessor.
      (ref.current as ChatElement).app = app;
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
    const el = ref.current as ChatElement;
    el.tools = tools;
    el.instructions = instructions;
  }, [ready, tools, instructions]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    (ref.current as ChatElement).mcpServers = mcpServers;
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
