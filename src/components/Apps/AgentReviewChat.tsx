import { Alert, Box, Button, Card, Group, Loader, ScrollArea, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { IconMessageQuestion, IconSend, IconAlertTriangle } from '@tabler/icons-react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { trpc } from '~/utils/trpc';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW in-modal CHAT (P3). A child of
 * AgentReviewPanel, shown only while the agent POD is up (status running |
 * complete | cost-capped). Lets the moderator ask the SAME agent follow-up
 * questions about its review ("why did you flag scope X", "show the call site").
 *
 * DARK: the parent panel only mounts under the `app-blocks-agentic-review` client
 * flag (fail-closed), and the `blocks.agentReviewChat` proc has its own
 * server-side flag gate → inert on merge until the Flipt flag exists.
 *
 * NON-STREAMING v1: each Send is one request/response turn (turns are slow,
 * 30–90s) — a "thinking…" indicator covers the wait; streaming SSE is a follow-up.
 *
 * ADVISORY + ADVERSARIAL-SAFE: the reply is derived from an UNTRUSTED bundle, so
 * it is rendered through the shared `CustomMarkdown` (react-markdown) — which uses
 * NO `rehype-raw` and NO `dangerouslySetInnerHTML`, so raw HTML embedded in
 * adversarial agent output is escaped to inert text rather than parsed into live
 * DOM. That preserves the stored-XSS-at-render contract for adversarial LLM output
 * while letting normal markdown (bold, lists, code) format. User-typed messages
 * stay plain inert text — only the agent's own replies carry markdown.
 */

type ChatMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Client-side sliding window on the conversation SENT to the agent. The server
 * schema caps `messages` at 20 (agentReviewChatSchema.messages.max(20)), so a
 * long chat would otherwise fail the zod cap around the 11th user turn
 * (2N-1 > 20) with a raw BAD_REQUEST and dead-end. We keep the FULL history in
 * UI state (the mod still sees the whole scrollback) but only ever send the
 * last MAX_CHAT_HISTORY_SENT turns — comfortably under the server's 20, so the
 * cap can never be tripped and the chat works indefinitely. Older turns simply
 * drop out of the agent's context.
 */
export const MAX_CHAT_HISTORY_SENT = 18;

export function AgentReviewChat({ publishRequestId }: { publishRequestId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chatMut = trpc.blocks.agentReviewChat.useMutation();
  const inFlight = chatMut.isPending;

  const send = () => {
    const content = input.trim();
    if (!content || inFlight) return;
    setError(null);
    // Optimistically append the user's message; send the RUNNING conversation
    // (the server prepends its own system grounding message).
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(nextMessages);
    setInput('');
    // Slide a window over the SENT conversation so we stay under the server's
    // .max(20) cap no matter how long the chat runs (see MAX_CHAT_HISTORY_SENT).
    const sentMessages = nextMessages.slice(-MAX_CHAT_HISTORY_SENT);
    chatMut.mutate(
      { publishRequestId, messages: sentMessages },
      {
        onSuccess: (data) => {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: data.reply || '(the agent returned an empty reply)' },
          ]);
        },
        onError: (e) => {
          // Keep the conversation intact; surface the error inline.
          setError(e.message || 'The review agent did not respond.');
        },
      }
    );
  };

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
          Ask the agent follow-up questions about its review (e.g. why a scope was
          flagged, or to show a call site). Answers are advisory — you retain the
          approve / reject decision.
        </Text>

        {messages.length > 0 && (
          <ScrollArea.Autosize mah={260} type="auto">
            <Stack gap={6} pr={6}>
              {messages.length > MAX_CHAT_HISTORY_SENT && (
                <Text size="xs" c="dimmed" ta="center" data-testid="chat-window-trim-note">
                  Earlier messages are no longer included in the agent&apos;s context.
                </Text>
              )}
              {messages.map((m, i) => {
                const isUser = m.role === 'user';
                return (
                  <Group key={i} justify={isUser ? 'flex-end' : 'flex-start'} gap={0} wrap="nowrap">
                    <Box
                      data-testid={isUser ? 'chat-user-msg' : 'chat-agent-msg'}
                      style={{
                        maxWidth: '85%',
                        minWidth: 0,
                        borderRadius: 8,
                        padding: '6px 10px',
                        // Keep markdown (long paths, urls, code) inside the bubble
                        // rather than blowing past its max-width.
                        overflowWrap: 'anywhere',
                      }}
                      // Theme-aware bubble surface + text — matches the
                      // `light-dark(...)` precedent in reviewDiffPanels.tsx. The old
                      // fixed `gray.1` rendered a near-white agent bubble in dark
                      // mode; these flip with the color scheme. User = filled accent.
                      bg={
                        isUser
                          ? 'light-dark(var(--mantine-color-blue-6), var(--mantine-color-blue-8))'
                          : 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))'
                      }
                      c={
                        isUser
                          ? 'white'
                          : 'light-dark(var(--mantine-color-dark-9), var(--mantine-color-gray-0))'
                      }
                    >
                      {isUser ? (
                        // User-typed message — plain inert TEXT (no markdown),
                        // matching the existing convention.
                        <Text
                          size="sm"
                          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                        >
                          {m.content}
                        </Text>
                      ) : (
                        // Agent reply — markdown via the shared, XSS-safe
                        // CustomMarkdown (react-markdown, NO rehype-raw / no
                        // dangerouslySetInnerHTML): raw HTML in adversarial output is
                        // escaped to inert text, normal markdown formats. `size="sm"`
                        // sizing via the sm font-size var on the markdown container.
                        <div
                          className="markdown-content"
                          style={{
                            fontSize: 'var(--mantine-font-size-sm)',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          <CustomMarkdown>{m.content}</CustomMarkdown>
                        </div>
                      )}
                    </Box>
                  </Group>
                );
              })}
              {inFlight && (
                <Group gap={6} justify="flex-start">
                  <Loader size="xs" />
                  <Text size="xs" c="dimmed">
                    Thinking… (agent turns can take up to a minute)
                  </Text>
                </Group>
              )}
            </Stack>
          </ScrollArea.Autosize>
        )}

        {messages.length === 0 && inFlight && (
          <Group gap={6}>
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              Thinking… (agent turns can take up to a minute)
            </Text>
          </Group>
        )}

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={14} />} py={6}>
            <Text size="xs">{error}</Text>
          </Alert>
        )}

        <Group gap={6} align="flex-end" wrap="nowrap">
          <Textarea
            aria-label="Ask the review agent"
            placeholder="Why did you flag scope X?"
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={inFlight}
            autosize
            minRows={1}
            maxRows={4}
            style={{ flex: 1 }}
          />
          <Button
            size="xs"
            variant="light"
            leftSection={<IconSend size={14} />}
            loading={inFlight}
            disabled={inFlight || input.trim().length === 0}
            onClick={send}
          >
            Send
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
