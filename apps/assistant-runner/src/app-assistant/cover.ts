import {
  COVER_LISTING_UNREADABLE,
  COVER_NOT_SET_UP,
  GENERATE_APP_COVER,
  createCoverArt,
  priceCover,
  type AppCoverWorkflow,
  type CoverEstimator,
  type CoverListing,
} from '@civitai/app-assistant';
import type { ChatTool } from '@civitai/components-chat/core';

import type { Logger } from '../core/interfaces';
import type { TokenSource } from '../minter';
import type { OrchestrationClient } from '../orchestration';

/**
 * `generate_app_cover` on the server runner. Like the page's, it only OFFERS a cover: it reads the
 * user's listing for the open app (through civitai, as the run's user) and prices the cover
 * (orchestration's what-if, on the run's `chat` token), and returns the offer. The page shows it as
 * a card, and only the user's press there makes the cover, as them: the runner never generates or
 * attaches one, so a run that ends, stops or is recovered can leave no cover spend behind.
 */

/** civitai's endpoint the runner reads the user's listing at, relative to `CIVITAI_URL`. */
export const COVER_PATH = 'api/internal/app-assistant/cover';
const REQUEST_TIMEOUT_MS = 30_000;

/** One run's listing read at civitai, as the user its grant names. */
export interface CoverListings {
  /** The user's own listing for `app`; null when they have none. Throws a message for the user. */
  listing(app: string, signal?: AbortSignal): Promise<CoverListing | null>;
}

/** civitai would not do it: `error` is written for the user. */
export class CoverRefusedError extends Error {
  override name = 'CoverRefusedError';
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export interface CivitaiCoversOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every call. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
}

/**
 * civitai's cover listing endpoint for the runner (civitai's
 * `src/pages/api/internal/app-assistant/cover/listing.ts`), which calls the listing editor's own
 * read as the user a run grant names, re-judging the user on every call. Each call reads the run's
 * grant inside its own fetch, as `CivitaiDevTunnels` does: neither the grant nor the secret is kept,
 * returned or logged.
 */
export class CivitaiCovers {
  readonly #options: CivitaiCoversOptions;

  constructor(options: CivitaiCoversOptions) {
    this.#options = options;
  }

  forRun(grant: () => Promise<string | null>): CoverListings {
    return {
      listing: async (app, signal) => {
        const answer = (await this.#post(grant, { app }, signal)) as { listing?: unknown } | null;
        const listing = answer?.listing as Partial<CoverListing> | null | undefined;
        if (listing === null) return null;
        if (
          !listing ||
          typeof listing.listingId !== 'string' ||
          typeof listing.status !== 'string' ||
          (listing.blockedReason !== null && typeof listing.blockedReason !== 'string')
        )
          throw new CoverRefusedError(COVER_LISTING_UNREADABLE, 503, 'unavailable');
        return {
          listingId: listing.listingId,
          status: listing.status,
          blockedReason: listing.blockedReason ?? null,
        };
      },
    };
  }

  async #post(
    grant: () => Promise<string | null>,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const { civitaiUrl, secret, log } = this.#options;
    const token = await grant();
    if (!token)
      throw new CoverRefusedError(
        'This reply can no longer act for you. Send your message again.',
        401,
        'invalid_grant'
      );
    const doFetch = this.#options.fetch ?? fetch;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${COVER_PATH}/listing`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant: token, ...body }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ err: (error as Error)?.name }, 'a cover listing read at civitai failed');
      throw new CoverRefusedError(COVER_LISTING_UNREADABLE, 503, 'unavailable');
    }
    const answer = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    if (response.ok) return answer;
    const code = typeof answer?.code === 'string' ? answer.code : undefined;
    // A 401 with no code is civitai refusing the runner itself (its secret): a deployment fault.
    if (response.status === 401 && !code)
      log.error({ status: response.status }, 'civitai refused the runner secret');
    else log.warn({ status: response.status, code }, 'civitai refused a cover listing read');
    throw new CoverRefusedError(
      typeof answer?.error === 'string' && answer.error ? answer.error : 'Civitai refused it.',
      response.status,
      code ?? (response.status >= 500 ? 'unavailable' : undefined)
    );
  }
}

/**
 * The cover's what-if on the runner: the runner's own client, on the run's `chat` token (the user's,
 * as the page's chat token is), so the quote is the user's own. Submits nothing.
 */
export function runnerCoverEstimator(
  client: Pick<OrchestrationClient, 'estimateWorkflow'>,
  tokens: TokenSource
): CoverEstimator {
  // A refusal reaches the tool, which offers nothing and says the price could not be checked.
  return { estimateWorkflow: (template) => client.estimateWorkflow(tokens, template) };
}

export interface RunnerCoverDeps {
  /** The app open in the reply now (`AppSandbox.active`), or null. */
  currentApp(): string | null;
  listings: CoverListings;
  estimator: CoverEstimator;
  /** Ids the offers are named by: per run, so an offer from elsewhere never matches. */
  nextId(): string;
  /** Aborted when the run stops: the listing read stops waiting with it. */
  signal?: AbortSignal;
  seed?(): number;
}

/** `generate_app_cover` on the runner: the shared tool (`createCoverArt`, the page's own code). */
export function runnerCoverTools(deps: RunnerCoverDeps): Record<string, ChatTool> {
  return createCoverArt({
    currentApp: deps.currentApp,
    listing: (app, signal) => deps.listings.listing(app, signal ?? deps.signal),
    price: (workflow: AppCoverWorkflow) => priceCover(deps.estimator, workflow),
    nextId: deps.nextId,
    ...(deps.seed ? { seed: deps.seed } : {}),
  });
}

/** `generate_app_cover` where covers are not set up: it says so, and offers nothing. */
export function unconfiguredCoverTools(): Record<string, ChatTool> {
  const tool = createCoverArt({
    currentApp: () => null,
    listing: async () => null,
    price: async () => 0,
    nextId: () => '',
  })[GENERATE_APP_COVER]!;
  return {
    [GENERATE_APP_COVER]: {
      ...tool,
      execute: () => Promise.reject(new Error(COVER_NOT_SET_UP)),
    },
  };
}
