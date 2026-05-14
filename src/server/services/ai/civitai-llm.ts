import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { SimpleMessage } from '~/server/services/ai/openrouter';

export type { SimpleMessage } from '~/server/services/ai/openrouter';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalCivitaiLLM: CivitaiLLM | undefined;
}

type GetJsonCompletionInput = {
  model: string;
  messages: SimpleMessage[];
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  /** Opt-in info logging for this call. Errors are logged regardless. */
  debug?: boolean;
  /**
   * Append a "JSON only, no preamble" instruction to the last user message.
   * Enable for models that emit chain-of-thought by default (e.g. Qwen3
   * thinking variants) so they don't burn the token budget on preamble.
   * Off by default — the client is model-agnostic.
   */
  suppressThinking?: boolean;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { role: string; content?: string | null };
    finish_reason?: string;
  }>;
};

// Orchestrator's /v1/chat/completions only accepts `string` content (not the
// OpenAI multimodal array form). Flatten text-only arrays to a single string;
// pass arrays that contain images through unchanged so any vision support added
// later still works (and surfaces a clear server error if it doesn't yet).
function normalizeMessage(msg: SimpleMessage): SimpleMessage {
  if (typeof msg.content === 'string') return msg;
  const hasImage = msg.content.some((c) => c.type === 'image_url');
  if (hasImage) return msg;
  const text = msg.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { ...msg, content: text };
}

// Opt-in helper for models that emit chain-of-thought before JSON (e.g. Qwen3
// thinking variants). The instruction-based approach is the only reliable
// switch today — the soft `/no_think` token is ignored by the current
// orchestrator proxy, and `chat_template_kwargs: { enable_thinking: false }`
// trips a 500 there. Callers enable this via `suppressThinking: true` on a
// per-request basis.
const NO_PREAMBLE_INSTRUCTION =
  '\n\nIMPORTANT: Respond with ONLY the raw JSON object. Do NOT include any analysis, planning, thinking steps, markdown fences, or preamble before or after the JSON. Begin your response with `{` and end with `}`.';

function appendNoPreamble(messages: SimpleMessage[]): SimpleMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;
  return messages.map((m, i) => {
    if (i !== lastUserIdx) return m;
    if (typeof m.content === 'string')
      return { ...m, content: `${m.content}${NO_PREAMBLE_INSTRUCTION}` };
    return {
      ...m,
      content: [...m.content, { type: 'text', text: NO_PREAMBLE_INSTRUCTION }],
    };
  });
}

// Last-ditch JSON extractor: take the substring from the first `{` to the
// last `}`. Handles models that wrap JSON in prose or markdown.
function extractJsonSlice(content: string): string | null {
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  return content.slice(first, last + 1);
}

export type CivitaiLLM = {
  getJsonCompletion: <T>(params: GetJsonCompletionInput) => Promise<T>;
};

function createCivitaiLLM(endpoint: string, token: string): CivitaiLLM {
  const url = `${endpoint.replace(/\/+$/, '')}/v1/chat/completions`;

  const getJsonCompletion = async <T>({
    model,
    messages,
    temperature = 1,
    maxTokens = 8192,
    retries = 0,
    debug = false,
    suppressThinking = false,
  }: GetJsonCompletionInput): Promise<T> => {
    const normalized = messages.map(normalizeMessage);
    const finalMessages = suppressThinking ? appendNoPreamble(normalized) : normalized;
    const body = {
      model,
      messages: finalMessages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };

    if (debug) {
      console.log('[civitai-llm] REQUEST', {
        model,
        maxTokens,
        retries,
        messageCount: finalMessages.length,
      });
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[civitai-llm] HTTP', res.status, errText.slice(0, 500));
      throw new Error(`Civitai LLM error ${res.status}: ${errText.slice(0, 500)}`);
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const choice = json.choices?.[0];
    const content = choice?.message?.content;

    if (debug) {
      console.log('[civitai-llm] RESPONSE', {
        finishReason: choice?.finish_reason,
        contentLength: typeof content === 'string' ? content.length : 0,
      });
    }

    if (!content || typeof content !== 'string') {
      if (retries > 0) {
        return getJsonCompletion<T>({
          model,
          messages,
          temperature,
          maxTokens,
          retries: retries - 1,
          debug,
          suppressThinking,
        });
      }
      throw new Error('No content in Civitai LLM response');
    }

    const candidates: string[] = [content];
    const fenced = content.match(/```json\n(.*?)\n```/s)?.[1];
    if (fenced) candidates.push(fenced);
    const slice = extractJsonSlice(content);
    if (slice) candidates.push(slice);

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // try next candidate
      }
    }

    if (retries > 0) {
      return getJsonCompletion<T>({
        model,
        messages,
        temperature,
        maxTokens,
        retries: retries - 1,
        debug,
        suppressThinking,
      });
    }
    console.error(
      '[civitai-llm] JSON parse failed; finishReason=',
      choice?.finish_reason,
      '\n',
      content
    );
    throw new Error('Failed to parse JSON from Civitai LLM completion');
  };

  return { getJsonCompletion };
}

export let civitaiLLM: CivitaiLLM | undefined;
const endpoint = env.ORCHESTRATOR_ENDPOINT;
const token = env.ORCHESTRATOR_ACCESS_TOKEN;
if (endpoint && token) {
  if (isProd) {
    civitaiLLM = createCivitaiLLM(endpoint, token);
  } else {
    if (!global.globalCivitaiLLM) global.globalCivitaiLLM = createCivitaiLLM(endpoint, token);
    civitaiLLM = global.globalCivitaiLLM;
  }
} else {
  console.warn(
    '[civitai-llm] ORCHESTRATOR_ENDPOINT and/or ORCHESTRATOR_ACCESS_TOKEN missing — calls to urn:air:* models will throw "Civitai LLM not connected".'
  );
}
