import { env } from '$env/dynamic/private';
import {
  ASSISTANT_MODELS,
  DEFAULT_ASSISTANT_MODEL,
  findModel,
  type Price,
} from '$lib/assistant/models';
import { openrouterKey } from '../xguard-api';

// The model call, and nothing else. Server-only: the key is read here and never leaves the process.

/**
 * The model a question runs on when the moderator picks none: `ASSISTANT_MODEL` if it names a listed
 * model, else the default. Only listed models were checked to route under the no-retention policy, so
 * a setting outside the list is ignored rather than trusted.
 */
export const assistantModel = () =>
  findModel(env.ASSISTANT_MODEL?.trim())?.id ?? DEFAULT_ASSISTANT_MODEL;

/** The model to run for a request: the one asked for if it is listed, else the default. */
export const resolveModel = (id: string | null | undefined) =>
  findModel(id)?.id ?? assistantModel();

const PRICE_TTL_MS = 60 * 60_000;
// A failed read is retried sooner, so one blip does not pin the release's prices for an hour.
const PRICE_RETRY_MS = 5 * 60_000;
let prices: { until: number; byId: Record<string, Price> } | null = null;

/**
 * OpenRouter's current list price for each listed model, from its public model list (no key), read
 * at most hourly. List prices move, so the release's own copy is only the fallback: for a model the
 * list does not return, or when OpenRouter cannot be reached.
 */
export async function listPrices(now = Date.now()): Promise<Record<string, Price>> {
  if (prices && now < prices.until) return prices.byId;
  const byId = Object.fromEntries(ASSISTANT_MODELS.map((m) => [m.id, m.price]));
  // A price is a non-negative number given as a string; OpenRouter marks "no price" with "-1".
  const perMillion = (raw: unknown) => {
    const n = typeof raw === 'string' && raw.trim() ? Number(raw) * 1_000_000 : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let ttl = PRICE_TTL_MS;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(3_000),
    });
    const body = (await res.json()) as {
      data?: { id: string; pricing?: { prompt?: unknown; completion?: unknown } }[];
    };
    if (!res.ok || !Array.isArray(body.data)) throw new Error(`price list status ${res.status}`);
    for (const m of body.data) {
      const input = perMillion(m?.pricing?.prompt);
      const output = perMillion(m?.pricing?.completion);
      if (m && m.id in byId && input !== null && output !== null)
        byId[m.id] = { input, output, current: true };
    }
  } catch (e) {
    ttl = PRICE_RETRY_MS;
    console.error('[assistant] OpenRouter price list unavailable; using the listed prices', e);
  }
  prices = { until: now + ttl, byId };
  return byId;
}

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
      temperature: findModel(input.model)?.noTemperature ? undefined : 0.2,
      // Reasoning tokens are billed and counted against the turn's budget; low keeps them short.
      reasoning: { effort: 'low' },
      // Account data goes into these prompts. Route only to providers that do not retain or train on
      // what they are sent, and that honour every parameter sent (tools above all): a provider that
      // drops them answers without the lookups.
      provider: { data_collection: 'deny', require_parameters: true },
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
