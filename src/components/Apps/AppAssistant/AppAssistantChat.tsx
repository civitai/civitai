import type { FC, MutableRefObject, Ref } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Center, Loader } from '@mantine/core';
import type {
  ChatMcpServer,
  ChatTool,
  ChatToolGate,
  ChatToolResult,
  CivitaiChat,
} from '@civitai/components-chat/civitai-chat';
import {
  APP_ASSISTANT_CHAT_CONFIG,
  APP_ASSISTANT_EXAMPLES,
  APP_ASSISTANT_MCP,
  APP_ASSISTANT_PLACEHOLDER,
} from '~/components/Apps/AppAssistant/assistantChatConfig';
import { buildAssistantSystemPrompt } from '~/components/Apps/AppAssistant/assistantInstructions';
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
  /** While set, nothing can be sent and the message box shows this. */
  holdReason?: string;
  beforeToolCall?: ChatToolGate;
  onToolResult?: (result: ChatToolResult) => void;
  /** Set to the chat element once it has started. */
  chatRef?: MutableRefObject<CivitaiChat | null>;
}

export function AppAssistantChat({
  tokens,
  tools,
  instructions,
  mcpServers,
  holdReason,
  beforeToolCall,
  onToolResult,
  chatRef,
}: AppAssistantChatProps) {
  const ref = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Client-only: the element and its SDK touch `customElements` and `window` at import.
      const [{ initialize }, { configureChat }] = await Promise.all([
        import('@civitai/sdk'),
        import('@civitai/components-chat/civitai-chat'),
        import('@civitai/components-chat/civitai-chat/define'),
      ]);
      // Page-wide: any other chat on this page would inherit these limits.
      configureChat(APP_ASSISTANT_CHAT_CONFIG);
      await customElements.whenDefined('civitai-chat');
      const app = await initialize({
        token: () => tokens.getToken(),
        refresh: () => tokens.getToken({ refresh: true }),
        requestGrants: (scopes) => appAssistantHoldsScopes(scopes),
      });
      if (cancelled || !ref.current) return;
      // Set after upgrade: a property assigned before would shadow the element's accessor.
      const el = ref.current as CivitaiChat;
      el.mcp = APP_ASSISTANT_MCP;
      el.systemPrompt = buildAssistantSystemPrompt;
      el.examples = APP_ASSISTANT_EXAMPLES;
      el.placeholder = APP_ASSISTANT_PLACEHOLDER;
      el.app = app;
      if (chatRef) chatRef.current = el;
      setReady(true);
    })().catch(() => {
      if (!cancelled) setError('The assistant could not start. Reload the page to try again.');
    });
    return () => {
      cancelled = true;
      if (chatRef) chatRef.current = null;
    };
  }, [tokens, chatRef]);

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

  useEffect(() => {
    if (!ready || !ref.current) return;
    const el = ref.current as CivitaiChat;
    el.holdReason = holdReason;
    el.beforeToolCall = beforeToolCall;
  }, [ready, holdReason, beforeToolCall]);

  useEffect(() => {
    const el = ref.current;
    if (!ready || !el || !onToolResult) return;
    const listener = (event: Event) => onToolResult((event as CustomEvent<ChatToolResult>).detail);
    el.addEventListener('tool-result', listener);
    return () => el.removeEventListener('tool-result', listener);
  }, [ready, onToolResult]);

  if (error)
    return (
      <Alert color="red" variant="light" m="md">
        {error}
      </Alert>
    );

  return (
    <div className="relative min-h-0 flex-1">
      {!ready && (
        <Center className="absolute inset-0">
          <Loader size="sm" />
        </Center>
      )}
      <ChatTag ref={ref} scope="app-assistant" className={classes.chat} />
    </div>
  );
}
