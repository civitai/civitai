import { chosenAppOf, type ToolResult } from '@civitai/app-assistant';

/**
 * The backfill's matcher (`scripts/backfill-app-assistant-traces.ts`): for a publish request that
 * predates session tracing, which of its submitter's App Assistant chats chose the request's app.
 * A chat counts when any call the gate reads as choosing an app (`chosenAppOf`: a `create_app` that
 * made it, a `use_open_app` or `wake_app` that opened it) answered with the slug. Pure.
 */

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object';

/** A saved tool output as the tool returned it (the chat saves `{ type: 'json', value }`). */
function unwrap(output: unknown): { output: unknown; isError: boolean } {
  if (!isRec(output) || typeof output.type !== 'string') return { output, isError: false };
  if (output.type === 'json' || output.type === 'text')
    return {
      output: output.value,
      isError: isRec(output.value) && output.value.error !== undefined,
    };
  return {
    output: output.value,
    isError: output.type.startsWith('error') || output.type === 'execution-denied',
  };
}

/** Every finished tool call a saved chat holds, as the gate reads results. */
export function toolResultsOfChat(chat: unknown): ToolResult[] {
  const results: ToolResult[] = [];
  const turns = isRec(chat) && Array.isArray(chat.turns) ? chat.turns : [];
  for (const turn of turns) {
    const messages =
      isRec(turn) && isRec(turn.assistant) && Array.isArray(turn.assistant.messages)
        ? (turn.assistant.messages as unknown[])
        : [];
    const outputs = new Map<string, ReturnType<typeof unwrap>>();
    for (const message of messages)
      if (isRec(message) && message.role === 'tool' && Array.isArray(message.content))
        for (const part of message.content)
          if (isRec(part) && part.type === 'tool-result' && typeof part.toolCallId === 'string')
            outputs.set(part.toolCallId, unwrap(part.output));
    for (const message of messages)
      if (isRec(message) && message.role === 'assistant' && Array.isArray(message.content))
        for (const part of message.content) {
          if (!isRec(part) || part.type !== 'tool-call' || typeof part.toolName !== 'string')
            continue;
          const done = outputs.get(String(part.toolCallId));
          if (!done) continue;
          results.push({
            name: part.toolName,
            input: part.input,
            output: done.output,
            isError: done.isError,
          } as ToolResult);
        }
  }
  return results;
}

/** Whether a saved chat ever chose `slug`. */
export function chatChoseApp(chat: unknown, slug: string): boolean {
  return toolResultsOfChat(chat).some((result) => chosenAppOf(result) === slug);
}

/** The ids of the chats among `chats` that chose `slug`, in order, once each. */
export function conversationsChoosing(
  chats: ReadonlyArray<{ conversationId: string }>,
  slug: string
): string[] {
  const ids: string[] = [];
  for (const chat of chats)
    if (!ids.includes(chat.conversationId) && chatChoseApp(chat, slug))
      ids.push(chat.conversationId);
  return ids;
}
