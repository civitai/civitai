import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { FreeTier, freeTierFetch, PROVIDER } from '@civitai/components-chat/core';
import type { LanguageModel } from 'ai';

import type { ModelContext, ModelProvider } from './interfaces';
import { MintRefusedError, type TokenSource } from './minter';
import type { OrchestrationClient } from './orchestration';

export interface OrchestrationModelOptions {
  /** Orchestration's base URL; the model is its OpenAI-compatible `/v1/chat/completions`. */
  baseUrl: string;
  orchestration: OrchestrationClient;
  /** The token source for one run (minted from that run's grant). */
  tokens(runId: string): TokenSource;
  fetch?: typeof fetch;
}

/**
 * The reply's model: orchestration's chat completions, as the browser's App Assistant asks them
 * (`createAssistantModel` and `freeTierFetch` in `@civitai/components-chat` 0.21.0): the same
 * OpenAI-compatible provider under the same provider name (so `AgentCore`'s provider options reach
 * the request), the viewer's own `chat` token on every request, so orchestration bills the viewer
 * under the App Assistant's client and its daily Buzz cap, and the viewer's tier choice sent as
 * `X-Civitai-Tier: free` while their free allowance for the model lasts.
 */
export class OrchestrationModels implements ModelProvider {
  readonly #options: OrchestrationModelOptions;

  constructor(options: OrchestrationModelOptions) {
    this.#options = options;
  }

  languageModel(context: ModelContext): LanguageModel {
    const { baseUrl, orchestration } = this.#options;
    const tokens = this.#options.tokens(context.runId);
    const freeTier = new FreeTier(() => orchestration.getFreeTier(tokens));
    const send = mintingFetch(tokens, this.#options.fetch ?? fetch);
    const tier = context.tier;
    const wrapped = freeTierFetch(send, context.model, freeTier, () => ({
      useFree: tier !== 'paid',
      payWhenOut: tier !== 'free',
    }));
    const provider = createOpenAICompatible({
      name: PROVIDER,
      baseURL: `${baseUrl.replace(/\/+$/, '')}/v1`,
      fetch: wrapped,
    });
    return provider.chatModel(context.model);
  }
}

/**
 * A fetch that signs each request with a `chat` token minted inside it, never one passed in, and
 * asks once more with a fresh token after a 401. A mint civitai refuses becomes a 4xx answer the
 * AI SDK does not retry (as the chat's own free-tier refusals do), carrying why.
 */
export function mintingFetch(tokens: TokenSource, doFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const attempt = async (fresh: boolean) => {
      let token: string;
      try {
        token = await tokens('chat', { fresh });
      } catch (error) {
        if (!(error instanceof MintRefusedError)) throw error;
        const status = error.code === 'unavailable' ? 503 : error.status === 403 ? 403 : 400;
        return Response.json({ error: { message: error.message, code: error.code } }, { status });
      }
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return doFetch(input, { ...init, headers });
    };
    const first = await attempt(false);
    return first.status === 401 ? attempt(true) : first;
  };
}
