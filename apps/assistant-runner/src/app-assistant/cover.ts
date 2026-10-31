import {
  COVER_LISTING_UNREADABLE,
  COVER_NOT_GENERATED,
  coverErrorMessage,
  coverNotAttached,
  createCoverArt,
  generateCover,
  isAppBlockId,
  type CoverArtDeps,
  type CoverListing,
  type CoverOrchestration,
  type CoverWorkflowResult,
} from '@civitai/app-assistant';
import type { ChatTool } from '@civitai/components-chat/core';

import type { Logger } from '../core/interfaces';
import type { TokenSource } from '../minter';
import { FINAL_STATUSES, OrchestrationError, type OrchestrationClient } from '../orchestration';

/** civitai's endpoints the runner reads and attaches a cover at, relative to `CIVITAI_URL`. */
export const COVER_PATH = 'api/internal/app-assistant/cover';
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * An attach fetches, decodes and scans the image before `setCover`, so it gets longer; past it (or on
 * any other unknown outcome) the user is told it MAY not have attached (`coverMaybeNotAttached`).
 */
const ATTACH_TIMEOUT_MS = 90_000;

/**
 * The attach's outcome is unknown (civitai did not answer in time, or could not be reached): the
 * cover may be on the listing already, so the user checks before making another.
 */
export const coverMaybeNotAttached = (url: string) =>
  `The cover was generated but may not have been put on your listing: Civitai did not confirm it. ` +
  `Check your listing's Media tab before trying again. The image is at ${url}.`;

/** One run's listing calls to civitai, as the user its grant names. */
export interface CoverListings {
  /** The user's own listing for `app`; null when they have none. Throws a message for the user. */
  listing(app: string, signal?: AbortSignal): Promise<CoverListing | null>;
  /** Puts the image at `url` on the user's listing `listingId` for `app`; throws civitai's refusal. */
  attach(
    input: { app: string; listingId: string; url: string },
    signal?: AbortSignal
  ): Promise<{ scanPending: boolean }>;
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
 * civitai's cover endpoints for the runner (civitai's `src/pages/api/internal/app-assistant/cover/`),
 * which call the listing editor's own procedures as the user a run grant names, re-judging the user
 * on every call. Each call reads the run's grant inside its own fetch, as `CivitaiDevTunnels` does:
 * neither the grant nor the secret is kept, returned or logged.
 */
export class CivitaiCovers {
  readonly #options: CivitaiCoversOptions;

  constructor(options: CivitaiCoversOptions) {
    this.#options = options;
  }

  forRun(grant: () => Promise<string | null>): CoverListings {
    return {
      listing: async (app, signal) => {
        const answer = (await this.#post('listing', grant, { app }, signal)) as {
          listing?: unknown;
        } | null;
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
      attach: async (input, signal) => {
        const answer = (await this.#post('attach', grant, input, signal)) as {
          scanPending?: unknown;
        } | null;
        return { scanPending: answer?.scanPending === true };
      },
    };
  }

  async #post(
    action: 'listing' | 'attach',
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
    const timeout = AbortSignal.timeout(
      action === 'attach' ? ATTACH_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    );
    let response: Response;
    try {
      response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${COVER_PATH}/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant: token, ...body }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ action, err: (error as Error)?.name }, 'a cover call to civitai failed');
      throw new CoverRefusedError('Civitai could not be reached just now.', 503, 'unavailable');
    }
    const answer = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    if (response.ok) return answer;
    const code = typeof answer?.code === 'string' ? answer.code : undefined;
    // A 401 with no code is civitai refusing the runner itself (its secret): a deployment fault.
    if (response.status === 401 && !code)
      log.error({ action, status: response.status }, 'civitai refused the runner secret');
    else log.warn({ action, status: response.status, code }, 'civitai refused a cover call');
    throw new CoverRefusedError(
      typeof answer?.error === 'string' && answer.error ? answer.error : 'Civitai refused it.',
      response.status,
      code ?? (response.status >= 500 ? 'unavailable' : undefined)
    );
  }
}

/** How long one held read of the cover's workflow waits for it to end, in seconds. */
const HELD_READ_SECONDS = 20;
/** The longest a cover may take before the runner gives up on it (and cancels it). */
export const COVER_MAX_WAIT_MS = 10 * 60_000;
/** Waits before each retry of a read that failed transiently; past the last, the wait gives up. */
export const COVER_READ_BACKOFF_MS = [250, 1_000, 4_000] as const;

/** A read worth asking again: orchestration busy or failing (429, 5xx), or no answer at all. */
function transient(error: unknown): boolean {
  if (error instanceof OrchestrationError) return error.status === 429 || error.status >= 500;
  // A network failure, or the request's own timeout: no answer, so worth another try.
  return true;
}

/**
 * `generate_app_cover`'s orchestration on the runner: the runner's own client, on the run's `chat`
 * token, the one the page's chat token is (the user's, with `ai:write:budgeted` under the App
 * Assistant's daily Buzz cap). A refusal says what orchestration said (not enough Buzz, the cap), or
 * that the cover was not made; never orchestration's raw status line.
 *
 * Once submitted, the workflow is paid for as it runs: every way the wait can fail other than a Stop
 * (which `generateCover` cancels) cancels it here, best-effort, and says it was not made.
 */
export function runnerCoverOrchestration(
  client: Pick<OrchestrationClient, 'submitWorkflow' | 'getWorkflow' | 'cancelWorkflow'>,
  tokens: TokenSource,
  {
    maxWaitMs = COVER_MAX_WAIT_MS,
    pollMs = 1_000,
    backoffMs = COVER_READ_BACKOFF_MS,
  }: { maxWaitMs?: number; pollMs?: number; backoffMs?: readonly number[] } = {}
): CoverOrchestration {
  const giveUp = (id: string): never => {
    void client.cancelWorkflow(tokens, id).catch(() => undefined);
    throw new Error(COVER_NOT_GENERATED);
  };
  return {
    async submitWorkflow(template) {
      try {
        const workflow = await client.submitWorkflow(tokens, template);
        return { id: workflow.id ?? null, status: 'submitted' };
      } catch (error) {
        if (error instanceof OrchestrationError && error.detail) throw new Error(error.detail);
        if ((error as Error)?.name === 'AbortError') throw error;
        throw new Error(COVER_NOT_GENERATED);
      }
    },
    async waitForWorkflow(id, { signal } = {}) {
      const deadline = Date.now() + maxWaitMs;
      let failures = 0;
      for (;;) {
        signal?.throwIfAborted();
        let state: CoverWorkflowResult | null = null;
        try {
          const read = await client.getWorkflow(tokens, id, {
            waitSeconds: HELD_READ_SECONDS,
            ...(signal ? { signal } : {}),
          });
          state = { ...(read as CoverWorkflowResult), status: String(read.status ?? '') };
          failures = 0;
        } catch (error) {
          // A Stop: `generateCover` cancels the workflow and the Stop goes on as it is.
          if (signal?.aborted) throw error;
          if (!transient(error) || failures >= backoffMs.length) return giveUp(id);
          await sleep(backoffMs[failures++]!, signal);
          continue;
        }
        if (FINAL_STATUSES.includes(state.status)) return state;
        // Not billed on past here: the user is told it was not made.
        if (Date.now() >= deadline) return giveUp(id);
        await sleep(pollMs, signal);
      }
    },
    cancelWorkflow: (id) => client.cancelWorkflow(tokens, id),
  };
}

/**
 * The cover workflows this process has running, across every run, so a shutdown can cancel the ones
 * still going (`cancelAll`). A run still generating when the process stops is recovered by the next
 * one with that call closed as interrupted: its workflow would otherwise finish and bill a cover no
 * one ever sees.
 */
export class CoverWorkflows {
  readonly #live = new Map<string, () => Promise<unknown>>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  /** How many are running now. */
  get size(): number {
    return this.#live.size;
  }

  /** `orchestration`, with each workflow it submits counted as running until its wait ends. */
  track(orchestration: CoverOrchestration): CoverOrchestration {
    return {
      submitWorkflow: async (template) => {
        const submitted = await orchestration.submitWorkflow(template);
        const id = submitted.id;
        if (id) this.#live.set(id, () => orchestration.cancelWorkflow(id));
        return submitted;
      },
      waitForWorkflow: async (id, opts) => {
        try {
          return await orchestration.waitForWorkflow(id, opts);
        } finally {
          this.#live.delete(id);
        }
      },
      cancelWorkflow: (id) => orchestration.cancelWorkflow(id),
    };
  }

  /** Cancels every one still running, waiting at most `timeoutMs` for the cancels; how many it asked. */
  async cancelAll(timeoutMs: number): Promise<number> {
    const live = [...this.#live.entries()];
    this.#live.clear();
    if (live.length === 0) return 0;
    const cancels = Promise.allSettled(
      live.map(async ([id, cancel]) => {
        try {
          await cancel();
        } catch (error) {
          this.#log.warn(
            { workflowId: id, err: (error as Error)?.name },
            'cancelling a cover workflow at shutdown failed'
          );
        }
      })
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      cancels,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ]).finally(() => clearTimeout(timer));
    this.#log.info(
      { count: live.length },
      'cancelled the cover workflows still running at shutdown'
    );
    return live.length;
  }
}

export interface RunnerCoverDeps {
  /** The app open in the reply now (`AppSandbox.active`), or null. */
  currentApp(): string | null;
  listings: CoverListings;
  orchestration: CoverOrchestration;
  /** Aborted when the run stops: the listing calls stop waiting with it. */
  signal?: AbortSignal;
  newId?(): string;
  seed?(): number;
}

/**
 * `generate_app_cover` on the runner: the shared tool (`createCoverArt`, the page's own code), with
 * the listing read and attach going through civitai as the run's user, and the generation on the
 * user's chat token. The same order as the page: the listing first, so an app with no listing, or
 * one whose media cannot be edited, spends nothing.
 */
export function runnerCoverTools(deps: RunnerCoverDeps): Record<string, ChatTool> {
  const coverDeps: CoverArtDeps = {
    currentApp: () => {
      const app = deps.currentApp();
      return app && isAppBlockId(app) ? app : null;
    },
    listing: (app) => deps.listings.listing(app, deps.signal),
    generate: (workflow, signal) =>
      generateCover(deps.orchestration, workflow, signal ?? deps.signal),
    async attach(listingId, url, app) {
      try {
        return await deps.listings.attach({ app, listingId, url }, deps.signal);
      } catch (error) {
        // Already paid for: the user is told where the image is. Only civitai's own refusal says
        // for sure it is not on the listing; no answer (a timeout, a Stop, a 5xx) may have attached.
        if (error instanceof CoverRefusedError && error.status >= 400 && error.status < 500)
          throw new Error(coverNotAttached(coverErrorMessage(error), url));
        throw new Error(coverMaybeNotAttached(url));
      }
    },
    ...(deps.newId ? { newId: deps.newId } : {}),
    ...(deps.seed ? { seed: deps.seed } : {}),
  };
  return createCoverArt(coverDeps);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
