import {
  FEEDBACK_UNAVAILABLE,
  type AppFeedbackSource,
  type ReviewFeedback,
  type UserFeedbackPage,
} from '@civitai/app-assistant';

import type { Logger } from '../core/interfaces';

/** civitai's endpoints the runner reads an app's feedback at, relative to `CIVITAI_URL`. */
export const APP_FEEDBACK_PATH = 'api/internal/app-assistant/app-feedback';
const REQUEST_TIMEOUT_MS = 15_000;

/** What the assistant reads when the run's grant is gone (the run ended, or it expired). */
export const FEEDBACK_GRANT_GONE = 'This reply can no longer act for you. Send your message again.';

export interface CivitaiAppFeedbackOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every call. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
}

/**
 * civitai's app-feedback endpoints for the runner (civitai's
 * `src/pages/api/internal/app-assistant/app-feedback/`): the open app's moderator review and its
 * users' feedback, read by civitai AS the user the run grant names, with the same author reads My
 * apps uses. civitai looks the app up among that user's own listings (owned, or an editor seat), so
 * a key naming anyone else's app answers 404, as an app with no listing does: both read as `null`.
 * Read only: the runner holds nothing that changes feedback. Each call reads the run's grant inside
 * its own fetch, as a mint does: neither the grant nor the secret is kept, returned or logged.
 */
export class CivitaiAppFeedback {
  readonly #options: CivitaiAppFeedbackOptions;

  constructor(options: CivitaiAppFeedbackOptions) {
    this.#options = options;
  }

  forRun(grant: () => Promise<string | null>, signal?: AbortSignal): AppFeedbackSource {
    return {
      review: async (app) => {
        const answer = (await this.#post(
          'review',
          grant,
          { app },
          signal
        )) as ReviewFeedback | null;
        if (
          answer &&
          (!Array.isArray(answer.submissions) || !Array.isArray(answer.listing?.problems))
        )
          throw new Error(FEEDBACK_UNAVAILABLE);
        return answer;
      },
      userFeedback: async (app, query) => {
        const answer = (await this.#post(
          'user',
          grant,
          { app, ...query },
          signal
        )) as UserFeedbackPage | null;
        if (answer && (!Array.isArray(answer.items) || typeof answer.appListingId !== 'string'))
          throw new Error(FEEDBACK_UNAVAILABLE);
        return answer;
      },
    };
  }

  /** civitai's answer; `null` on its `NOT_FOUND` (no listing of this user's under that key). */
  async #post(
    action: 'review' | 'user',
    grant: () => Promise<string | null>,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const { civitaiUrl, secret, log } = this.#options;
    const token = await grant();
    if (!token) throw new Error(FEEDBACK_GRANT_GONE);
    const doFetch = this.#options.fetch ?? fetch;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${APP_FEEDBACK_PATH}/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant: token, ...body }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ action, err: (error as Error)?.name }, 'an app-feedback call to civitai failed');
      throw new Error(FEEDBACK_UNAVAILABLE);
    }
    const answer = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    // civitai's own 404 names its code; any other (a civitai without this endpoint yet) is not an answer.
    if (response.status === 404 && answer?.code === 'NOT_FOUND') return null;
    if (response.ok && answer !== null && typeof answer === 'object') return answer;
    const code = typeof answer?.code === 'string' ? answer.code : undefined;
    if (response.status === 401 && !code)
      log.error({ action, status: response.status }, 'civitai refused the runner secret');
    else
      log.warn({ action, status: response.status, code }, 'civitai refused an app-feedback call');
    // A refusal for who the user is (403) says why, in civitai's words; anything else is retryable.
    if (response.status === 403 && typeof answer?.error === 'string' && answer.error)
      throw new Error(answer.error);
    if (response.status === 401 && code === 'invalid_grant') throw new Error(FEEDBACK_GRANT_GONE);
    throw new Error(FEEDBACK_UNAVAILABLE);
  }
}
