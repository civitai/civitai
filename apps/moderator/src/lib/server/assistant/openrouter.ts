import { env } from '$env/dynamic/private';
import { openrouterKey } from '../xguard-api';

// The model call, and nothing else. Server-only: the key is read here and never leaves the process.

const ASSISTANT_MODEL = 'z-ai/glm-5.3-flash';
/** Configurable so a model trial needs no release. Every turn records the model it ran on. */
export const assistantModel = () => env.ASSISTANT_MODEL?.trim() || ASSISTANT_MODEL;

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ToolSpec = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

export type Completion = {
  /** `reasoning`: the model's own reasoning for this call, when it returns any. Never sent back to it. */
  message: { content: string | null; tool_calls?: ToolCall[]; reasoning?: string | null };
  finishReason: string | null;
  usage: { prompt: number; completion: number };
};

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export async function complete(input: {
  /** Passed in, not read here, so the turn's recorded model is the one that ran. */
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** `none` asks for an answer from what is already in the conversation. */
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}): Promise<Completion> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openrouterKey()}`,
      'Content-Type': 'application/json',
      'X-Title': 'Civitai Mod Assistant',
    },
    signal: input.signal,
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: input.tools?.length ? input.tools : undefined,
      tool_choice: input.tools?.length ? input.toolChoice ?? 'auto' : undefined,
      temperature: 0.2,
      // Reasoning tokens are billed and counted against the turn's budget; low keeps them short.
      reasoning: { effort: 'low' },
      // Account data goes into these prompts. Route only to providers that do not retain or train on
      // what they are sent.
      provider: { data_collection: 'deny' },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
        reasoning?: unknown;
        reasoning_details?: unknown;
      };
      finish_reason?: string | null;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  const choice = body.choices?.[0];
  if (!choice?.message)
    throw new Error(
      `OpenRouter returned no message${body.error?.message ? `: ${body.error.message}` : ''}`
    );
  return {
    message: {
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
      reasoning: reasoningOf(choice.message),
    },
    finishReason: choice.finish_reason ?? null,
    usage: {
      prompt: body.usage?.prompt_tokens ?? 0,
      completion: body.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * The reasoning text, from `reasoning` or, when a model family leaves that empty, the readable parts of
 * `reasoning_details` (encrypted ones have no text). Anything not shaped as documented reads as none: it
 * is display only, so it must never fail the turn that carried a good answer.
 */
export function reasoningOf(message: { reasoning?: unknown; reasoning_details?: unknown }) {
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) return message.reasoning;
  if (!Array.isArray(message.reasoning_details)) return null;
  const parts = message.reasoning_details.flatMap((d: { text?: unknown; summary?: unknown }) =>
    typeof d?.text === 'string' ? [d.text] : typeof d?.summary === 'string' ? [d.summary] : []
  );
  return parts.join('\n\n').trim() || null;
}
