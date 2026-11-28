import type { FC, Ref } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Card, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconMessageQuestion } from '@tabler/icons-react';
import type {
  ChatBackend,
  ChatConversation,
  ChatConversationStore,
  ChatExample,
  CivitaiChat,
} from '@civitai/components-chat/civitai-chat';
import {
  REVIEW_AGENT_CHAT_HEADERS,
  REVIEW_AGENT_CHAT_MODEL_ID,
  REVIEW_AGENT_CHAT_URL,
} from '~/shared/constants/review-agent-chat.constants';
import chatClasses from '~/components/Apps/AppAssistant/AppAssistant.module.scss';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW chat: the moderator asks the review agent follow-up
 * questions about its report ("why did you flag scope X", "show the call site").
 *
 * The `<civitai-chat>` element on a HOST BACKEND (`backend`, not `app`): no Civitai sign-in, no
 * Buzz, no orchestration. Every reply goes to the moderator-only endpoint at
 * `REVIEW_AGENT_CHAT_URL`, which authorizes the request, builds the prompt from the persisted
 * report, runs the model with read-only tools over this request's report, diff and source, and
 * streams the answer. The headers name the publish request and the report on screen.
 *
 * NOTHING IS STORED: the store below keeps chats in memory, so a conversation lives as long as
 * this panel does, as the chat always has.
 *
 * Page-wide `configureChat` is deliberately never called here (App Assistant's call would leak
 * into this chat and this one into it); the limits that matter (model, output tokens, steps, tool
 * output) are enforced by the endpoint, whatever the element sends.
 *
 * Adversarial output: the element renders replies through `marked` + DOMPurify (no `<img>`), and
 * the endpoint neutralizes every `<` in the text it streams (`neutralizeChatMarkup`), so a
 * prompt-injected reply cannot become HTML that loads a remote resource.
 */

const ChatTag = 'civitai-chat' as unknown as FC<{
  ref: Ref<HTMLElement>;
  scope: string;
  layout: string;
  className?: string;
}>;

export const REVIEW_AGENT_CHAT_EXAMPLES: ChatExample[] = [
  { title: 'Riskiest finding', prompt: 'Which finding in your report is the riskiest, and why?' },
  { title: 'What changed', prompt: 'What does this version change, and does any of it worry you?' },
];

/** Conversations kept in memory for the life of the panel: nothing leaves the page. */
export function createSessionConversationStore(): ChatConversationStore {
  const chats = new Map<string, ChatConversation>();
  return {
    list: async () => ({
      items: [...chats.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      next: null,
    }),
    load: async (id) => chats.get(id) ?? null,
    save: async (conversation) => {
      chats.set(conversation.id, structuredClone(conversation));
    },
    delete: async (id) => {
      chats.delete(id);
    },
  };
}

/** The element's backend for one publish request (and the report on screen). */
export function reviewAgentChatBackend(publishRequestId: string, reportId?: string): ChatBackend {
  return {
    url: REVIEW_AGENT_CHAT_URL,
    model: REVIEW_AGENT_CHAT_MODEL_ID,
    store: createSessionConversationStore(),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(REVIEW_AGENT_CHAT_HEADERS.publishRequestId, publishRequestId);
      if (reportId) headers.set(REVIEW_AGENT_CHAT_HEADERS.reportId, reportId);
      return fetch(input, { ...init, headers, credentials: 'same-origin' });
    },
  };
}

export function AgentReviewChat({
  publishRequestId,
  reportId,
}: {
  publishRequestId: string;
  /** The run on screen; the server grounds the answer on it. Omitted ⇒ the latest run. */
  reportId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Client-only: the element touches `customElements` and `window` at import.
      await import('@civitai/components-chat/civitai-chat/define');
      await customElements.whenDefined('civitai-chat');
      if (cancelled || !ref.current) return;
      // Set after upgrade: a property assigned before would shadow the element's accessor.
      const el = ref.current as CivitaiChat;
      // The endpoint builds the real prompt and ignores this; a short one keeps requests small.
      el.systemPrompt = 'You are the App Blocks review agent.';
      el.examples = REVIEW_AGENT_CHAT_EXAMPLES;
      el.placeholder = 'Ask about this review…';
      // Last: setting `backend` starts the chat.
      el.backend = reviewAgentChatBackend(publishRequestId, reportId);
      setReady(true);
    })().catch(() => {
      if (!cancelled) setError('The review chat could not start. Reload the page to try again.');
    });
    return () => {
      cancelled = true;
    };
  }, [publishRequestId, reportId]);

  return (
    <Card withBorder padding="xs" radius="sm" data-testid="agent-review-chat">
      <Stack gap={6}>
        <Group gap={6}>
          <IconMessageQuestion size={14} />
          <Text size="sm" fw={600}>
            Ask the review agent
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          Ask the agent follow-up questions about its review (e.g. why a scope was flagged, or to
          show a call site). It can read its report, the diff and the app&apos;s files. Answers are
          advisory — you retain the approve / reject decision. The chat is not saved.
        </Text>
        {error ? (
          <Alert color="red" variant="light">
            <Text size="xs">{error}</Text>
          </Alert>
        ) : (
          <div className="relative" style={{ height: 460 }}>
            {!ready && (
              <Center className="absolute inset-0">
                <Loader size="sm" />
              </Center>
            )}
            <ChatTag
              ref={ref}
              scope="app-review-agent"
              layout="compact"
              className={chatClasses.chat}
            />
          </div>
        )}
      </Stack>
    </Card>
  );
}
