import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

export interface ScriptedStep {
  /** Words the step writes, streamed a few characters at a time. */
  text?: string;
  /** Tool calls the step ends on. */
  calls?: { toolName: string; input: Record<string, unknown> }[];
  /** Thrown instead of answering. */
  fail?: Error;
}

type Prompt = { role: string; content: unknown }[];

/** How many tool results the prompt carries: which step of a script the model is on. */
export function toolResults(prompt: Prompt): number {
  return prompt
    .filter((message) => message.role === 'tool')
    .reduce(
      (count, message) => count + (Array.isArray(message.content) ? message.content.length : 0),
      0
    );
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** A model that answers each step as `script` says, without a network or a token. */
export function scriptedModel(
  script: (prompt: Prompt) => ScriptedStep,
  options: { chunkChars?: number; chunkDelayMs?: number } = {}
) {
  const { chunkChars = 4, chunkDelayMs = 5 } = options;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const step = script(prompt as Prompt);
      if (step.fail) throw step.fail;
      const base = toolResults(prompt as Prompt);
      const chunks: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if (step.text) {
        chunks.push({ type: 'text-start', id: 't' });
        for (let at = 0; at < step.text.length; at += chunkChars)
          chunks.push({ type: 'text-delta', id: 't', delta: step.text.slice(at, at + chunkChars) });
        chunks.push({ type: 'text-end', id: 't' });
      }
      (step.calls ?? []).forEach((call, index) => {
        chunks.push({
          type: 'tool-call',
          toolCallId: `call-${base}-${index}`,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      });
      const finishReason = step.calls?.length
        ? { unified: 'tool-calls', raw: 'tool_calls' }
        : { unified: 'stop', raw: 'stop' };
      chunks.push({ type: 'finish', finishReason, usage });
      return {
        stream: simulateReadableStream({ chunks: chunks as never[], chunkDelayInMs: chunkDelayMs }),
      };
    },
  });
  return model;
}
