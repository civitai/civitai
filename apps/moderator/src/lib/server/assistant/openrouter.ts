import { openrouterKey } from '../xguard-api';

// The model call, and nothing else. Server-only: the key is read here and never leaves the process.

export const ASSISTANT_MODEL = 'z-ai/glm-5.3-flash';

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
  message: { content: string | null; tool_calls?: ToolCall[] };
  finishReason: string | null;
  usage: { prompt: number; completion: number };
};

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export async function complete(input: {
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
      model: ASSISTANT_MODEL,
      messages: input.messages,
      tools: input.tools?.length ? input.tools : undefined,
      tool_choice: input.tools?.length ? input.toolChoice ?? 'auto' : undefined,
      temperature: 0.2,
      // Account data goes into these prompts. Route only to providers that do not retain or train on
      // what they are sent.
      provider: { data_collection: 'deny' },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: ToolCall[] };
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
    message: { content: choice.message.content ?? null, tool_calls: choice.message.tool_calls },
    finishReason: choice.finish_reason ?? null,
    usage: {
      prompt: body.usage?.prompt_tokens ?? 0,
      completion: body.usage?.completion_tokens ?? 0,
    },
  };
}
