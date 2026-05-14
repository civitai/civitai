# Civitai LLM Client

OpenAI-compatible chat completions client targeting Civitai's Orchestrator (`POST /v1/chat/completions`). Lets the application call Civitai-hosted LLMs (Qwen3 and future additions) with the same call shape used for OpenRouter, while keeping non-Civitai-hosted models (`openai/*`, `anthropic/*`, etc.) on OpenRouter via a model-prefix dispatcher.

## What It Provides

- **OpenAI-compatible chat completions** against the Orchestrator endpoint.
- **`getJsonCompletion<T>`** — schema-typed JSON output with built-in parse fallbacks.
- **Prefix-based routing** — `urn:air:*` models route to this client; everything else stays on OpenRouter. No call site has to choose a backend manually.
- **Drop-in API** — same `SimpleMessage` shape, same `temperature` / `maxTokens` / `retries` semantics, same return type as `openrouter.getJsonCompletion`.
- **Defensive normalization** for the Orchestrator's stricter validator and Qwen's default thinking behavior.
- **Per-call `debug` flag** for opt-in request/response logging.

## Architecture

```
            ┌──────────────────────────────────┐
            │ generative-content.ts call site  │
            │   model = input.model            │
            │        ?? DEFAULT_*_MODEL        │
            └──────────────┬───────────────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ pickClient(model)   │
                │  urn:air:* → civitai│
                │  else      → openR  │
                └────────┬────────────┘
              ┌──────────┴───────────┐
              ▼                      ▼
   ┌────────────────────┐ ┌────────────────────┐
   │ civitaiLLM         │ │ openrouter         │
   │ src/server/        │ │ src/server/        │
   │   services/ai/     │ │   services/ai/     │
   │   civitai-llm.ts   │ │   openrouter.ts    │
   └─────────┬──────────┘ └─────────┬──────────┘
             │                      │
             ▼                      ▼
   Orchestrator                OpenRouter
   /v1/chat/completions        /api/v1/chat/completions
```

Dispatcher rule (`src/server/games/daily-challenge/generative-content.ts`):

```ts
function pickClient(model: string) {
  if (model.startsWith('urn:air:')) {
    if (!civitaiLLM) throw new Error('Civitai LLM not connected');
    return civitaiLLM;
  }
  if (!openrouter) throw new Error('OpenRouter not connected');
  return openrouter;
}
```

URN-prefixed models hit the Civitai LLM client. All other model strings (`openai/*`, `anthropic/*`, `moonshotai/*`, `stepfun/*`, etc.) stay on OpenRouter.

## Files

| File | Purpose |
|------|---------|
| `src/server/services/ai/civitai-llm.ts` | Thin OpenAI-compatible client + defenses |
| `src/server/services/ai/openrouter.ts` | OpenRouter SDK wrapper; hosts `AI_MODELS` constants (including Civitai-hosted URNs) |
| `src/server/games/daily-challenge/generative-content.ts` | Dispatcher, per-function model defaults, five call sites |
| `src/components/Challenge/Playground/ModelSelector.tsx` | Mod-only model picker |
| `src/components/Challenge/Playground/playground.store.ts` | Zustand store; versioned `migrate` keeps persisted defaults current |

## Public API

```ts
import { civitaiLLM } from '~/server/services/ai/civitai-llm';

const result = await civitaiLLM!.getJsonCompletion<MyShape>({
  model: 'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar',
  messages: [
    { role: 'system', content: 'You are a JSON-producing assistant.' },
    { role: 'user', content: 'Return {"hello":"world"}.' },
  ],
  temperature: 1,
  maxTokens: 8192, // default
  retries: 3,
  debug: false, // opt-in per-call info logging
});
```

`SimpleMessage` is re-exported from `civitai-llm.ts` so callers don't need to import from both modules.

In practice, call sites use the dispatcher rather than importing `civitaiLLM` directly:

```ts
import { pickClient } from '...'; // file-local helper
const result = await pickClient(model).getJsonCompletion<MyShape>({ model, messages });
```

That keeps the routing rule centralized.

## Built-in Defenses

The Orchestrator's chat endpoint and the Qwen3 family have a few sharp edges. The client handles them so call sites stay clean.

### 1. Content-array flattening (`normalizeMessage`)

OpenAI and OpenRouter accept `content` as either a `string` or an array of `{ type: 'text' | 'image_url', ... }` parts. The Orchestrator's validator rejects arrays for text-only messages (`The JSON value could not be converted to System.String`). The client flattens text-only arrays to a joined string before sending. Messages containing an `image_url` part pass through unchanged so vision support can be exercised when it lands end-to-end.

### 2. Thinking-mode suppression (`suppressThinking`)

Qwen3 emits chain-of-thought reasoning by default. With creative prompts it can consume the entire `max_tokens` budget before producing any JSON, returning `finish_reason: length` with prose preamble.

Mitigation: an explicit "JSON only, no preamble" directive is appended to the last user message:

```
IMPORTANT: Respond with ONLY the raw JSON object. Do NOT include any
analysis, planning, thinking steps, markdown fences, or preamble before
or after the JSON. Begin your response with `{` and end with `}`.
```

The soft `/no_think` token and `chat_template_kwargs: { enable_thinking: false }` were also tried — `/no_think` was ignored by the current proxy build, and `chat_template_kwargs` triggered a 500. The instruction-based approach is the one that survived.

### 3. JSON extraction fallbacks (`extractJsonSlice`)

When parsing fails, the client tries three candidates in order:

1. Raw content (`JSON.parse(content)`).
2. Fenced block: ` ```json … ``` `.
3. **Slice**: substring from the first `{` to the last `}`.

This catches cases where the model wraps JSON in prose despite the instruction.

### 4. Trailing-slash normalization

`env.ORCHESTRATOR_ENDPOINT` may be set with a trailing slash. The constructor strips trailing slashes before composing `${endpoint}/v1/chat/completions`.

### 5. Retries

Same retry semantics as `openrouter.getJsonCompletion`: on "no content" or "all JSON candidates failed", recurse with `retries - 1` until exhausted. `debug` is forwarded through recursive calls.

## Defaults

`src/server/games/daily-challenge/generative-content.ts`:

```ts
const DEFAULT_CONTENT_MODEL: AIModel = AI_MODELS.GPT_4O_MINI;
const DEFAULT_REVIEW_MODEL: AIModel = AI_MODELS.GPT_5_NANO;
```

| Function | Default | Reason |
|----------|---------|--------|
| `generateCollectionDetails` | `GPT_4O_MINI` | Short text generation |
| `generateArticle` | `GPT_4O_MINI` | Persona / creative writing |
| `generateThemeElements` | `GPT_4O_MINI` | Keyword extraction |
| `generateReview` | `GPT_5_NANO` | Stricter image scoring |
| `generateWinners` | `GPT_4O_MINI` | Narrative + ranking |

Caller-supplied `input.model` overrides the default at every site. The mod-only Playground (`ModelSelector.tsx`) is the primary way to override interactively.

## Routing to a Civitai-hosted Model

To make a call site use a Civitai-hosted model:

1. Confirm the model is registered in `AI_MODELS` (`src/server/services/ai/openrouter.ts`). URN-shaped values route to this client automatically.
2. Set the call site's default (or pass `input.model`) to that constant.
3. Optionally surface the model in `ModelSelector.tsx` for mod testing.

No dispatcher change is needed — URN-prefix routing already directs all `urn:air:*` models to the Civitai LLM client.

If the Orchestrator gains support for `chat_template_kwargs` or its own JSON-mode flag, consider re-enabling them in `civitai-llm.ts` — they'd allow dropping the prompt-injection workaround:

```ts
const body = {
  model, messages: finalMessages, temperature, max_tokens: maxTokens, stream: false,
  response_format: { type: 'json_object' },
  chat_template_kwargs: { enable_thinking: false },
};
```

Both fields previously triggered a 500 on the current proxy build. Re-test before re-introducing.

## Env Vars

| Var | Used For |
|-----|----------|
| `ORCHESTRATOR_ENDPOINT` | Base URL. Trailing slashes are stripped. |
| `ORCHESTRATOR_ACCESS_TOKEN` | Bearer token. |

If either is missing, `civitaiLLM` exports as `undefined`. The dispatcher then throws `'Civitai LLM not connected'` if a URN model is requested, surfacing a clear setup error instead of an opaque network failure.

## Debugging

```ts
await civitaiLLM!.getJsonCompletion({ model, messages, debug: true });
```

When `debug: true`, the client emits two log lines per attempt:

```
[civitai-llm] REQUEST { model, maxTokens, retries, messageCount }
[civitai-llm] RESPONSE { finishReason, contentLength }
```

Errors are always logged (HTTP non-2xx and final JSON parse failure), regardless of `debug`.

For richer per-message dumps (full prompt content, image URLs, content tails), check the file's git history — earlier revisions had extensive logging that can be cherry-picked back when investigating a regression.

## Known Limits

- **Streaming**: not implemented. The endpoint supports SSE (`stream: true`); add a `streamChatCompletion` method when a consumer needs it.
- **Tool calls**: not implemented. Add `runAgentLoop` parity with `openrouter.ts` if/when the Orchestrator supports OpenAI-format tool calls through Qwen.
- **Vision**: image-bearing content arrays are forwarded unchanged, but end-to-end vision handling has not been validated against the current Orchestrator build. Validate by hand before routing image-bearing flows to `urn:air:*` models.

## See Also

- [Daily Challenge System](./daily-challenge.md) — primary consumer of these clients.
- `src/server/services/ai/openrouter.ts` — `AI_MODELS` lives here; reuse it from both clients.
