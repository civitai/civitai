import { createAssistantModel, FreeTier, freeTierFetch } from '@civitai/components-chat/core';
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
 * The reply's model: orchestration's chat completions, built by the chat package's own
 * `createAssistantModel` and `freeTierFetch` (`@civitai/components-chat` 0.22.1), as the browser's
 * App Assistant builds it: the same OpenAI-compatible provider under the same provider name (so
 * `AgentCore`'s provider options reach the request), the same 401 retry, the viewer's own `chat`
 * token on every request (minted inside it), so orchestration bills the viewer under the App
 * Assistant's client and its daily Buzz cap, and `X-Civitai-Tier: free` while the viewer's free
 * allowance for the model lasts, as their tier allows.
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
    const tier = context.tier;
    return createAssistantModel(
      // A Stop stops waiting for a mint at once, rather than after its timeout.
      {
        getToken: ({ fresh } = {}) =>
          tokens('chat', { fresh, ...(context.signal ? { signal: context.signal } : {}) }),
      },
      {
        baseUrl,
        model: context.model,
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        wrap: (signed) =>
          freeTierFetch(refusalsAsAnswers(signed), context.model, freeTier, () => ({
            useFree: tier !== 'paid',
            payWhenOut: tier !== 'free',
          })),
      }
    );
  }
}

/**
 * A mint civitai refused becomes an answer the AI SDK reads as the request's own failure, with why:
 * a 4xx it does not retry (as the chat's own free-tier refusals are), or a 503 it may retry when
 * civitai could not be reached.
 */
export function refusalsAsAnswers(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await inner(input, init);
    } catch (error) {
      if (!(error instanceof MintRefusedError)) throw error;
      // Refused and consent_required end the reply for good, as invalid_grant does: never retried.
      const status =
        error.code === 'unavailable'
          ? 503
          : error.code === 'consent_required' || error.code === 'refused'
          ? 403
          : 400;
      return Response.json({ error: { message: error.message, code: error.code } }, { status });
    }
  };
}
