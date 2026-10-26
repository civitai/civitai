import { isHttpError } from '@sveltejs/kit';
import type { TurnEvent, TurnSource, TurnStatus, TurnToolCall } from '$lib/assistant/types';
import { unverifiedCitations } from '$lib/assistant/answer';
import type { ChatMessage, Completion, ToolCall, ToolSpec } from './openrouter';
import type { ToolContext, ToolResult } from './tools';
import type { z } from 'zod';

// One turn of the conversation: ask the model, run the tools it calls, feed the results back, until
// it answers. Everything it talks to is passed in.

/** Rounds in which the model may call tools. One further call, with tools off, forces an answer. */
export const MAX_ROUNDS = 10;
/** Tokens per moderator per UTC day, across all chats: a circuit breaker for a wrong price. The
 *  allowance is the dollar cap. */
export const DAILY_TOKEN_CAP = 10_000_000;
export const TOOL_TIMEOUT_MS = 45_000;
/** The forced final answer's own window when the turn deadline passed during the last lookups. */
export const FINAL_ANSWER_GRACE_MS = 30_000;
/** A whole turn; past this the in-flight model call is aborted. */
export const TURN_DEADLINE_MS = 4 * 60_000;
/**
 * One tool result as the model sees it, roughly: see `fitJson`. Every later round resends it, so a
 * turn's prompt tokens grow with the sum of its results, not the last one.
 */
export const MAX_TOOL_CHARS = 20_000;
/** Tokens one question may spend before it must answer with what it has, unless configured. */
export const TURN_TOKEN_BUDGET = 60_000;
export const BUDGET_NOTICE =
  '_Stopped at this question’s token budget. Ask to continue if you need more._';

// Appended to the moderator's question, never stored with it. GLM reasons at length unless steered;
// the shape follows the pilot moderator's own reasoning instruction for GLM.
export const REASONING_NOTE = `

# Reasoning
Reason in telegraphic bullets, never prose, through these steps in order:
1. Ask: what exactly was asked, and what was not.
2. Lookups: the fewest that answer it.
3. Results: what they show, and what they do not.
4. Key points: the 1-10 points the answer needs.
Never restate the request. Never put the reasoning in the answer.`;

const TIMED_OUT = 'The lookup timed out.';
// A filed tool request means the question needs something the assistant cannot do. It stops there and
// asks, rather than spending the turn on what it can do, which the moderator usually already knows.
const STOPS_TURN = new Set(['request_tool']);
const STOP_AFTER_REQUEST =
  'You filed a tool request. Stop investigating now: tell the moderator what you could not do and that you filed the request, report only what you had already found that answers the question, and ask whether they want you to look into anything else with the tools you have.';
const STOP_AT_BUDGET =
  'This question has reached its token budget. Answer now with what you have found, and say what you could not check.';

export type AnyTool = {
  name: string;
  input: z.ZodType;
  run: (args: never, ctx: ToolContext) => Promise<ToolResult>;
  /** Longer than `TOOL_TIMEOUT_MS` for a tool measured to need it. */
  timeoutMs?: number;
  /** Added to the timed-out result, so the model can say exactly what went unchecked. */
  onTimeout?: (args: never) => Record<string, unknown>;
};

export type TurnOutcome = {
  status: Exclude<TurnStatus, 'running'>;
  answer: string | null;
  error: string | null;
  toolCalls: TurnToolCall[];
  sources: TurnSource[];
  unverified: string[];
  /** Every round's reasoning, in order, capped at `MAX_REASONING_CHARS`. Null when the model gave none. */
  reasoning: string | null;
  promptTokens: number;
  completionTokens: number;
};

/** Kept for the moderator to read, not resent to the model, so the cap only bounds the row and page. */
export const MAX_REASONING_CHARS = 20_000;
export const REASONING_CUT = '\n\n[Reasoning cut here: it ran past what is kept.]';

export async function runTurn(input: {
  system: string;
  history: { prompt: string; answer: string | null }[];
  prompt: string;
  tools: readonly AnyTool[];
  specs: ToolSpec[];
  ctx: ToolContext;
  /** Tokens left in the moderator's day, at this model's price. The turn stops once it has spent them. */
  budget: number;
  /** Tokens this question may spend before it must answer. Defaults to `TURN_TOKEN_BUDGET`. */
  turnBudget?: number;
  /** Refs earlier turns in this chat returned, which an answer may still cite. */
  knownRefs: string[];
  complete: (req: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'none';
    signal?: AbortSignal;
  }) => Promise<Completion>;
  emit: (event: TurnEvent) => void;
  /** The turn's running token totals after each model call, so a turn that dies mid-way still shows
   *  what it spent. */
  onUsage?: (promptTokens: number, completionTokens: number) => Promise<void>;
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
    { role: 'user', content: input.prompt + REASONING_NOTE },
  ];
  const toolCalls: TurnToolCall[] = [];
  const sources = new Map<string, TurnSource>();
  let promptTokens = 0;
  let completionTokens = 0;
  const reasoning: string[] = [];

  const finish = (
    status: TurnOutcome['status'],
    answer: string | null,
    error: string | null
  ): TurnOutcome => {
    clearTimeout(timer);
    const known = [...input.knownRefs, ...sources.keys()];
    const thought = reasoning.join('\n\n');
    return {
      reasoning: !thought
        ? null
        : thought.length > MAX_REASONING_CHARS
        ? thought.slice(0, MAX_REASONING_CHARS) + REASONING_CUT
        : thought,
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

  // Why the next round must be the last, if anything has said so.
  let stopWith: 'request' | 'budget' | null = null;

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const last = stopWith !== null || round === MAX_ROUNDS || now() > deadline - TOOL_TIMEOUT_MS;
      if (last)
        messages.push({
          role: 'user',
          content:
            stopWith === 'request'
              ? STOP_AFTER_REQUEST
              : stopWith === 'budget'
              ? STOP_AT_BUDGET
              : 'You are out of tool calls for this turn. Answer now with what you have found, and say what you could not check.',
        });
      const completion = await input.complete({
        messages,
        tools: input.specs,
        toolChoice: last ? 'none' : 'auto',
        // The answer that reports what was and was not checked always gets at least a short window,
        // even when the lookups before it ran up to or past the deadline; otherwise the turn ends
        // with nothing for the moderator to read.
        signal: last
          ? AbortSignal.timeout(Math.max(deadline - now(), FINAL_ANSWER_GRACE_MS))
          : abort.signal,
      });
      promptTokens += completion.usage.prompt;
      completionTokens += completion.usage.completion;
      await input.onUsage?.(promptTokens, completionTokens);
      const thought = completion.message.reasoning?.trim();
      if (thought) reasoning.push(thought);
      const calls = last ? [] : completion.message.tool_calls ?? [];

      if (!calls.length) {
        const answer = completion.message.content?.trim() || null;
        // Said by the app, not left to the model: a budget stop must never read as a full answer.
        if (answer && stopWith === 'budget')
          return finish('done', `${answer}\n\n${BUDGET_NOTICE}`, null);
        return answer
          ? finish('done', answer, null)
          : finish('error', null, 'The model returned an empty answer.');
      }
      // 🔴 Checked after the call that crossed it, so a turn overshoots by at most one model call; it
      // can never start another.
      if (promptTokens + completionTokens >= input.budget)
        return finish(
          'capped',
          null,
          'Today’s assistant allowance is used up. It resets at midnight UTC.'
        );

      messages.push({ role: 'assistant', content: completion.message.content, tool_calls: calls });
      const results = await Promise.all(calls.map((call) => callTool(call, input, now)));
      for (const r of results) {
        toolCalls.push({ ...r.log, round: round + 1 });
        for (const s of r.sources) sources.set(s.ref, s);
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
      if (results.some((r) => STOPS_TURN.has(r.log.name) && !r.log.error)) stopWith = 'request';
      else if (promptTokens + completionTokens >= (input.turnBudget ?? TURN_TOKEN_BUDGET))
        stopWith = 'budget';
    }
    return finish('error', null, 'The model did not answer.');
  } catch (e) {
    const message = abort.signal.aborted
      ? 'The turn took too long and was stopped.'
      : e instanceof Error
      ? e.message
      : isHttpError(e)
      ? e.body.message
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
  const fail = (error: string, detail: Record<string, unknown> = {}) => {
    const log = { name, args, rows: 0, truncated: false, ms: now() - started, error };
    input.emit({ type: 'tool-done', name, rows: 0, error, ms: log.ms });
    return { id: call.id, content: JSON.stringify({ ...detail, error }), log, sources: [] };
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
        timer = setTimeout(() => reject(new Error(TIMED_OUT)), tool.timeoutMs ?? TOOL_TIMEOUT_MS);
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
    if (e instanceof Error && e.message === TIMED_OUT) {
      let detail: Record<string, unknown> = {};
      try {
        detail = tool.onTimeout?.(parsed.data as never) ?? {};
      } catch (inner) {
        console.error(`[assistant] tool ${name} onTimeout failed`, inner);
      }
      return fail(TIMED_OUT, detail);
    }
    return fail('The lookup failed.');
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
