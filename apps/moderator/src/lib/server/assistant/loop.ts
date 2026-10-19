import type { TurnEvent, TurnSource, TurnStatus, TurnToolCall } from '$lib/assistant/types';
import { unverifiedCitations } from '$lib/assistant/answer';
import type { ChatMessage, Completion, ToolCall, ToolSpec } from './openrouter';
import type { ToolContext, ToolResult } from './tools';
import type { z } from 'zod';

// One turn of the conversation: ask the model, run the tools it calls, feed the results back, until
// it answers. Everything it talks to is passed in.

/** Rounds in which the model may call tools. One further call, with tools off, forces an answer. */
export const MAX_ROUNDS = 10;
/** Tokens one moderator may spend per UTC day, across all chats. */
export const DAILY_TOKEN_CAP = 2_000_000;
export const TOOL_TIMEOUT_MS = 45_000;
/** A whole turn; past this the in-flight model call is aborted. */
export const TURN_DEADLINE_MS = 4 * 60_000;
/** One tool result as the model sees it, roughly: see `fitJson`. */
export const MAX_TOOL_CHARS = 40_000;

const TIMED_OUT = 'The lookup timed out.';

export type AnyTool = {
  name: string;
  input: z.ZodType;
  run: (args: never, ctx: ToolContext) => Promise<ToolResult>;
};

export type TurnOutcome = {
  status: Exclude<TurnStatus, 'running'>;
  answer: string | null;
  error: string | null;
  toolCalls: TurnToolCall[];
  sources: TurnSource[];
  unverified: string[];
  promptTokens: number;
  completionTokens: number;
};

export async function runTurn(input: {
  system: string;
  history: { prompt: string; answer: string | null }[];
  prompt: string;
  tools: readonly AnyTool[];
  specs: ToolSpec[];
  ctx: ToolContext;
  /** Tokens left in the moderator's day. The turn stops once it has spent them. */
  budget: number;
  /** Refs earlier turns in this chat returned, which an answer may still cite. */
  knownRefs: string[];
  complete: (req: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'none';
    signal?: AbortSignal;
  }) => Promise<Completion>;
  emit: (event: TurnEvent) => void;
  now?: () => number;
}): Promise<TurnOutcome> {
  const now = input.now ?? Date.now;
  const deadline = now() + TURN_DEADLINE_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_DEADLINE_MS);

  const messages: ChatMessage[] = [
    { role: 'system', content: input.system },
    ...input.history.flatMap((h): ChatMessage[] => [
      { role: 'user', content: h.prompt },
      { role: 'assistant', content: h.answer ?? '(no answer was given to this)' },
    ]),
    { role: 'user', content: input.prompt },
  ];
  const toolCalls: TurnToolCall[] = [];
  const sources = new Map<string, TurnSource>();
  let promptTokens = 0;
  let completionTokens = 0;

  const finish = (
    status: TurnOutcome['status'],
    answer: string | null,
    error: string | null
  ): TurnOutcome => {
    clearTimeout(timer);
    const known = [...input.knownRefs, ...sources.keys()];
    return {
      status,
      answer,
      error,
      toolCalls,
      sources: [...sources.values()],
      unverified: answer ? unverifiedCitations(answer, known) : [],
      promptTokens,
      completionTokens,
    };
  };

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS || now() > deadline - TOOL_TIMEOUT_MS;
      if (last)
        messages.push({
          role: 'user',
          content:
            'You are out of tool calls for this turn. Answer now with what you have found, and say what you could not check.',
        });
      const completion = await input.complete({
        messages,
        tools: input.specs,
        toolChoice: last ? 'none' : 'auto',
        signal: abort.signal,
      });
      promptTokens += completion.usage.prompt;
      completionTokens += completion.usage.completion;
      const calls = last ? [] : completion.message.tool_calls ?? [];

      if (!calls.length) {
        const answer = completion.message.content?.trim() || null;
        return answer
          ? finish('done', answer, null)
          : finish('error', null, 'The model returned an empty answer.');
      }
      // 🔴 Checked after the call that crossed it, so a turn overshoots by at most one model call; it
      // can never start another.
      if (promptTokens + completionTokens >= input.budget)
        return finish('capped', null, 'Daily token limit reached. It resets at midnight UTC.');

      messages.push({ role: 'assistant', content: completion.message.content, tool_calls: calls });
      const results = await Promise.all(calls.map((call) => callTool(call, input, now)));
      for (const r of results) {
        toolCalls.push(r.log);
        for (const s of r.sources) sources.set(s.ref, s);
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
    return finish('error', null, 'The model did not answer.');
  } catch (e) {
    const message = abort.signal.aborted
      ? 'The turn took too long and was stopped.'
      : e instanceof Error
      ? e.message
      : String(e);
    return finish('error', null, message);
  }
}

async function callTool(
  call: ToolCall,
  input: { tools: readonly AnyTool[]; ctx: ToolContext; emit: (e: TurnEvent) => void },
  now: () => number
): Promise<{ id: string; content: string; log: TurnToolCall; sources: TurnSource[] }> {
  const started = now();
  const name = call.function.name;
  let args: unknown = call.function.arguments;
  const fail = (error: string) => {
    const log = { name, args, rows: 0, truncated: false, ms: now() - started, error };
    input.emit({ type: 'tool-done', name, rows: 0, error, ms: log.ms });
    return { id: call.id, content: JSON.stringify({ error }), log, sources: [] };
  };

  // A model may name a tool it saw earlier or was told about by quoted text; it gets an error.
  const tool = input.tools.find((t) => t.name === name);
  if (!tool) return fail(`No tool named "${name}".`);
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return fail('The arguments were not valid JSON.');
  }
  const parsed = tool.input.safeParse(args);
  if (!parsed.success)
    return fail(
      `Invalid arguments: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ')}`
    );
  input.emit({ type: 'tool', name, args: parsed.data });

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      (tool.run as (a: unknown, c: ToolContext) => Promise<ToolResult>)(parsed.data, input.ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(TIMED_OUT)), TOOL_TIMEOUT_MS);
      }),
    ]);
    const { json, trimmed } = fitJson(
      { data: result.data, truncated: result.truncated },
      MAX_TOOL_CHARS
    );
    const log = {
      name,
      args: parsed.data,
      rows: result.rows,
      truncated: result.truncated || trimmed,
      ms: now() - started,
      error: null,
    };
    input.emit({ type: 'tool-done', name, rows: result.rows, error: null, ms: log.ms });
    return { id: call.id, content: json, log, sources: result.sources };
  } catch (e) {
    console.error(`[assistant] tool ${name} failed`, e);
    // 🔴 Never the error's own text: a ClickHouse error quotes the whole query, addresses included, and
    // this string reaches the model, the moderator's screen and the audit.
    return fail(e instanceof Error && e.message === TIMED_OUT ? TIMED_OUT : 'The lookup failed.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * About `max` characters of JSON: the longest array is halved (up to 40 times), then the text is cut.
 * Either way the output carries `trimmedForSize`, so the model does not present a slice as the whole.
 */
export function fitJson(value: unknown, max: number): { json: string; trimmed: boolean } {
  let json = JSON.stringify(value);
  if (json.length <= max) return { json, trimmed: false };
  const copy = JSON.parse(json) as unknown;
  for (let i = 0; i < 40 && json.length > max; i++) {
    const longest = longestArray(copy);
    if (!longest || longest.length <= 1) break;
    longest.length = Math.ceil(longest.length / 2);
    json = JSON.stringify({ trimmedForSize: true, result: copy });
  }
  if (json.length > max)
    json = JSON.stringify({ trimmedForSize: true, result: json.slice(0, max) });
  return { json, trimmed: true };
}

function longestArray(value: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      if (!best || JSON.stringify(v).length > JSON.stringify(best).length) best = v;
      v.forEach(visit);
    } else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return best;
}
