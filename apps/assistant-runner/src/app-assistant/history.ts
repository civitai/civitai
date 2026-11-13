import type { ToolResult } from '@civitai/app-assistant';
import { REFUSED_BY_PAGE_NOTE } from '@civitai/components-chat/core';
import type { ModelMessage } from 'ai';

/**
 * The tool calls `messages` hold, each with its result, in the order they were made, as the gate is
 * told of them when they finish. A call with no result yet (cut off) has `isError` and no output. A
 * call the gate refused is marked `refused`, from the note the gate puts on its output.
 */
export function toolResultsOf(messages: readonly ModelMessage[]): ToolResult[] {
  const outputs = new Map<string, { output: unknown; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      outputs.set(part.toolCallId, outputOf(part.output));
    }
  }
  const results: ToolResult[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue;
      const done = outputs.get(part.toolCallId);
      const output = done?.output;
      const refused =
        isRecord(output) && output.note === REFUSED_BY_PAGE_NOTE && typeof output.error === 'string'
          ? output.error
          : undefined;
      results.push({
        name: part.toolName,
        input: part.input,
        output,
        isError: done?.isError ?? true,
        ...(refused !== undefined ? { refused } : {}),
      });
    }
  }
  return results;
}

/** A saved result as the tool returned it, and whether it reads as a failure. */
function outputOf(output: unknown): { output: unknown; isError: boolean } {
  if (!isRecord(output) || typeof output.type !== 'string') return { output, isError: false };
  const value = output.value;
  switch (output.type) {
    case 'text':
    case 'json':
      return { output: value, isError: isRecord(value) && value.error !== undefined };
    case 'error-text':
    case 'error-json':
      return { output: { error: value }, isError: true };
    case 'execution-denied':
      return { output: { error: output.reason ?? 'denied' }, isError: true };
    default:
      return { output: value, isError: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
