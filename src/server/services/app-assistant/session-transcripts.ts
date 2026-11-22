import type { StoredConversationMetadata } from '@civitai/components-chat/core';

/**
 * Reads a user's App Assistant chats where the chat itself keeps them: orchestration `echo` workflows
 * tagged `cvt:head` + `cvt:conv:<id>`, the whole conversation in the workflow's metadata, as
 * `@civitai/components-chat`'s `ThreadStore` (browser) and the server runner's
 * `OrchestrationConversationStore` write them. Orchestration shows a token only its own user's
 * workflows, so the read goes with an App Assistant `chat` token civitai mints FOR the chat's user,
 * exactly the token the runner reads and writes the same chats with. The token is used for these
 * reads only: never stored, returned or logged.
 *
 * A user who has turned App Assistant off (consent revoked) gets no token, and their chats are not
 * read (`consent`). Everything is imported lazily so this module adds nothing to the server's static
 * graph.
 */

/** One orchestration read's bound: a snapshot is best-effort and must not hang. */
const READ_TIMEOUT_MS = 15_000;
/** The heads one listing page asks for. */
const LIST_PAGE = 50;

export type TranscriptReaderRefusal = 'consent' | 'unavailable';

export interface TranscriptReader {
  /** The chat's latest head, or null when the user has no such chat. */
  read(conversationId: string): Promise<StoredConversationMetadata | null>;
  /** One page of the user's chats (their latest heads), newest first as orchestration lists them. */
  list(cursor?: string): Promise<{ items: StoredConversationMetadata[]; next?: string }>;
}

type Workflow = { id?: string | null; metadata?: unknown };

/** The highest turn a head holds. */
function lastSeq(metadata: StoredConversationMetadata): number {
  return Math.max(0, ...(metadata.turns ?? []).map((turn) => turn.seq));
}

/**
 * The newest head per conversation among `workflows`, as the runner's store picks it (an older head
 * whose `cvt:head` tag was not removed yet loses to the one with the later turn).
 */
export function newestHeads(
  workflows: readonly Workflow[],
  parse: (workflow: Workflow) => StoredConversationMetadata | null
): StoredConversationMetadata[] {
  const best = new Map<string, StoredConversationMetadata>();
  for (const workflow of workflows) {
    const metadata = parse(workflow);
    if (!metadata || !workflow.id) continue;
    const current = best.get(metadata.conversationId);
    if (!current || lastSeq(metadata) > lastSeq(current))
      best.set(metadata.conversationId, metadata);
  }
  return [...best.values()];
}

/** A reader of `userId`'s chats, or why there is none. */
export async function transcriptReaderFor(
  userId: number
): Promise<TranscriptReader | { refused: TranscriptReaderRefusal }> {
  const [{ mintAppAssistantToken }, chat, { createOrchestratorClient }, orchestration, timeouts] =
    await Promise.all([
      import('~/server/services/app-assistant/app-assistant-token'),
      import('@civitai/components-chat/core'),
      import('~/server/services/orchestrator/client'),
      import('@civitai/orchestration-client'),
      import('~/server/utils/fetch-timeout'),
    ]);
  let token: string;
  try {
    const minted = await mintAppAssistantToken(userId, 'chat', null);
    if (!minted) return { refused: 'consent' };
    token = minted.token;
  } catch {
    return { refused: 'unavailable' };
  }
  const client = createOrchestratorClient(token);
  const parse = (workflow: Workflow) =>
    chat.conversationMetadataOf(workflow as Parameters<typeof chat.conversationMetadataOf>[0]);

  const query = async (tags: string[], take: number, cursor?: string) => {
    const { data, error } = await orchestration.queryWorkflows({
      client,
      signal: timeouts.fetchTimeoutSignal(READ_TIMEOUT_MS),
      query: { tags, take, ...(cursor ? { cursor } : {}) },
    });
    if (error || !data) throw new Error('orchestration refused the chat read');
    return data as { items?: Workflow[]; next?: string };
  };

  return {
    async read(conversationId) {
      const page = await query(
        [chat.APP_TAG, chat.HEAD_TAG, chat.conversationTag(conversationId)],
        5
      );
      return (
        newestHeads(page.items ?? [], parse).find(
          (metadata) => metadata.conversationId === conversationId
        ) ?? null
      );
    },
    async list(cursor) {
      const page = await query([chat.APP_TAG, chat.HEAD_TAG], LIST_PAGE, cursor);
      return {
        items: newestHeads(page.items ?? [], parse),
        ...(page.next ? { next: page.next } : {}),
      };
    },
  };
}
