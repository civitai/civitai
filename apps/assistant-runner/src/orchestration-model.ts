import { createAssistantModel, FreeTier, freeTierFetch } from '@civitai/components-chat/core';
import type { LanguageModel } from 'ai';

import type { Logger, ModelCallLedger, ModelContext, ModelProvider } from './interfaces';
import { MintRefusedError, type TokenSource } from './minter';
import { ModelCalls } from './model-calls';
import type { OrchestrationClient } from './orchestration';

export interface OrchestrationModelOptions {
  /** Orchestration's base URL; the model is its OpenAI-compatible `/v1/chat/completions`. */
  baseUrl: string;
  orchestration: OrchestrationClient;
  /** The token source for one run (minted from that run's grant). */
  tokens(runId: string): TokenSource;
  fetch?: typeof fetch;
  /**
   * Where each request's orchestration workflow is kept, so a request asked again after a crash is
   * answered by it rather than sent (and paid for) twice (`ModelCalls`). Unset: every request is sent.
   */
  calls?: ModelCallLedger;
  log?: Logger;
  /** The least time between two status reads of a workflow still running (1 s). */
  pollIntervalMs?: number;
}

/**
 * The reply's model: orchestration's chat completions, built by the chat package's own
 * `createAssistantModel` and `freeTierFetch` (`@civitai/components-chat` 0.25.0), as the browser's
 * App Assistant builds it: the same OpenAI-compatible provider under the same provider name (so
 * `AgentCore`'s provider options reach the request), the same 401 retry, the viewer's own `chat`
 * token on every request (minted inside it), so orchestration bills the viewer under the App
 * Assistant's client and its daily Buzz cap, and `X-Civitai-Tier: free` while the viewer's free
 * allowance for the model lasts, as their tier allows. With `calls`, a request asked again (its step
 * recovered after a crash, or a retry of it) is answered by the orchestration workflow it was first
 * sent as when that can be reused, and a request cut off by the run cancels its workflow
 * (`ModelCalls`).
 */
export class OrchestrationModels implements ModelProvider {
  readonly #options: OrchestrationModelOptions;
  readonly #calls: ModelCalls | undefined;

  constructor(options: OrchestrationModelOptions) {
    this.#options = options;
    this.#calls = options.calls
      ? new ModelCalls({
          ledger: options.calls,
          orchestration: options.orchestration,
          ...(options.log ? { log: options.log } : {}),
          ...(options.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.pollIntervalMs }
            : {}),
        })
      : undefined;
  }

  languageModel(context: ModelContext): LanguageModel {
    const { baseUrl, orchestration } = this.#options;
    const tokens = this.#options.tokens(context.runId);
    const freeTier = new FreeTier(() => orchestration.getFreeTier(tokens));
    const tier = context.tier;
    const calls = this.#calls;
    // Inside the free-tier fetch, so each request it sends (a free one, then a paid one when the
    // free one is slow to start) is kept, and the free one it gives up on is cancelled.
    const send = (signed: typeof fetch) =>
      calls
        ? calls.fetch(
            refusalsAsAnswers(signed),
            {
              runId: context.runId,
              userId: context.userId,
              conversationId: context.conversationId,
              seq: context.seq ?? 0,
              ...(context.carriesOn ? { carriesOn: true } : {}),
            },
            tokens
          )
        : refusalsAsAnswers(signed);
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
          freeTierFetch(send(signed), context.model, freeTier, () => ({
            useFree: tier !== 'paid',
            payWhenOut: tier !== 'free',
          })),
      }
    );
  }

  settle(runId: string): Promise<void> {
    return this.#calls?.settle(runId) ?? Promise.resolve();
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
