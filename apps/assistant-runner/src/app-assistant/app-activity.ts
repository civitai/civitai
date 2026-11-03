import {
  APP_ACTIVITY,
  APP_ACTIVITY_UNAVAILABLE,
  createAppActivityTool,
  isAppActivity,
  unconfiguredActivitySource,
  type AppActivity,
  type AppActivitySource,
} from '@civitai/app-assistant';
import type { ChatTool } from '@civitai/components-chat/core';

import type { Logger } from '../core/interfaces';
import { FEEDBACK_GRANT_GONE } from './app-feedback';

/** civitai's endpoint the runner reads an app's activity at, relative to `CIVITAI_URL`. */
export const APP_ACTIVITY_PATH = 'api/internal/app-assistant/app-activity';
const REQUEST_TIMEOUT_MS = 15_000;

/** The runner's page tools this file adds (`RUNNER_PAGE_TOOLS`). */
export const RUNNER_ACTIVITY_TOOLS = [APP_ACTIVITY] as const;

export interface CivitaiAppActivityOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every call. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
}

/**
 * civitai's app-activity endpoint for the runner (civitai's
 * `src/pages/api/internal/app-assistant/app-activity.ts`): what the open app did in the last 2 hours,
 * read by civitai AS the user the run grant names, with the read the page's preview strip uses.
 * civitai looks the app up as that user's own dev app, so a key naming anyone else's app answers
 * 404, as no app does: both read as `null`. Read only. As `CivitaiAppFeedback`, each call reads the
 * run's grant inside its own fetch: neither the grant nor the secret is kept, returned or logged.
 */
export class CivitaiAppActivity {
  readonly #options: CivitaiAppActivityOptions;

  constructor(options: CivitaiAppActivityOptions) {
    this.#options = options;
  }

  forRun(grant: () => Promise<string | null>, signal?: AbortSignal): AppActivitySource {
    return { read: (app) => this.#read(app, grant, signal) };
  }

  async #read(
    app: string,
    grant: () => Promise<string | null>,
    signal?: AbortSignal
  ): Promise<AppActivity | null> {
    const { civitaiUrl, secret, log } = this.#options;
    const token = await grant();
    if (!token) throw new Error(FEEDBACK_GRANT_GONE);
    const doFetch = this.#options.fetch ?? fetch;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${APP_ACTIVITY_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant: token, app }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ err: (error as Error)?.name }, 'an app-activity call to civitai failed');
      throw new Error(APP_ACTIVITY_UNAVAILABLE);
    }
    const answer = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    // civitai's own 404 names its code; any other (a civitai without this endpoint yet) is not an answer.
    if (response.status === 404 && answer?.code === 'NOT_FOUND') return null;
    if (response.ok && isAppActivity(answer)) return answer;
    const code = typeof answer?.code === 'string' ? answer.code : undefined;
    if (response.status === 401 && !code)
      log.error({ status: response.status }, 'civitai refused the runner secret');
    else log.warn({ status: response.status, code }, 'civitai refused an app-activity call');
    // A refusal for who the user is (403) says why, in civitai's words; anything else is retryable.
    if (response.status === 403 && typeof answer?.error === 'string' && answer.error)
      throw new Error(answer.error);
    if (response.status === 401 && code === 'invalid_grant') throw new Error(FEEDBACK_GRANT_GONE);
    throw new Error(APP_ACTIVITY_UNAVAILABLE);
  }
}

/** `app_activity` on the runner: the page's own tool, over civitai's endpoint for this run. */
export function runnerActivityTools({
  currentApp,
  source,
}: {
  /** The block id the open app's preview runs under (`RunnerPreview.previewBlockId`), or null. */
  currentApp: () => string | null | Promise<string | null>;
  /** Unset: the tool says activity cannot be read here. */
  source: AppActivitySource | undefined;
}): Record<string, ChatTool> {
  return {
    [APP_ACTIVITY]: createAppActivityTool({
      current: currentApp,
      source: source ?? unconfiguredActivitySource,
    }),
  };
}
