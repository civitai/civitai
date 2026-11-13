import type { Logger } from '../core/interfaces';

/** civitai's endpoint the runner asks for a source-repo save at, relative to `CIVITAI_URL`. */
export const SOURCE_SAVE_PATH = 'api/internal/app-assistant/source-save';
const REQUEST_TIMEOUT_MS = 60_000;

export interface CivitaiSourceSavesOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every call. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
}

/**
 * civitai's source-save endpoint for the runner (civitai's
 * `src/server/services/app-assistant/source-save-route.ts`): commit the open app, as its sandbox
 * holds it now, to the app's source repo FOR the user the run grant names. civitai reads the
 * files from the sandbox itself, as that user; the runner sends only the app's key. Each call
 * reads the run's grant inside its own fetch, as `CivitaiAppActivity`; neither the grant nor the
 * secret is kept, returned or logged.
 *
 * Never throws: a save that did not happen is carried by the next one (each commits the whole app).
 */
export class CivitaiSourceSaves {
  readonly #options: CivitaiSourceSavesOptions;

  constructor(options: CivitaiSourceSavesOptions) {
    this.#options = options;
  }

  forRun(grant: () => Promise<string | null>): (app: string) => Promise<void> {
    return (app) => this.#save(app, grant);
  }

  async #save(app: string, grant: () => Promise<string | null>): Promise<void> {
    const { civitaiUrl, secret, log } = this.#options;
    const token = await grant().catch(() => null);
    if (!token) return;
    const doFetch = this.#options.fetch ?? fetch;
    try {
      const response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${SOURCE_SAVE_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant: token, app }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const answer = (await response.json().catch(() => null)) as {
        saved?: unknown;
        branch?: unknown;
        conflict?: unknown;
        code?: unknown;
      } | null;
      if (!response.ok)
        log.warn(
          {
            status: response.status,
            code: typeof answer?.code === 'string' ? answer.code : undefined,
          },
          'civitai refused a source-repo save'
        );
      else if (answer?.conflict === true)
        log.info({ branch: answer.branch }, 'a source-repo save went to the assistant branch');
    } catch (error) {
      log.warn({ err: (error as Error)?.name }, 'a source-repo save call to civitai failed');
    }
  }
}
