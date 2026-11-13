import { WakeSeedError, type SleepingApp, type WakeSeed } from '@civitai/app-assistant';

import type { Logger } from '../core/interfaces';

/** civitai's endpoints the runner reads sleeping apps at, relative to `CIVITAI_URL`. */
export const SLEEPING_APPS_PATH = 'api/internal/app-assistant/sleeping-apps';
export const WAKE_SEED_PATH = 'api/internal/app-assistant/wake-seed';
/** A reply's start waits this long at most for the list; past it the reply goes on without. */
const LIST_TIMEOUT_MS = 5_000;
const WAKE_SEED_TIMEOUT_MS = 15_000;

export interface CivitaiSleepingAppsOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every call. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
}

/** One run's view of the user's sleeping apps (app hibernate). */
export interface RunSleepingApps {
  /**
   * The user's sleeping apps, or `null` when the `app-hibernate` flag is off for them (civitai's
   * 404 `disabled`) or the list could not be read: the reply then offers no hibernate tools at all,
   * exactly as before the feature.
   */
  list(): Promise<SleepingApp[] | null>;
  /** The seed (with its one-time wake ticket) to wake one; throws a {@link WakeSeedError}. */
  wakeSeed(app: string): Promise<WakeSeed>;
}

/**
 * civitai's sleeping-app endpoints for the runner (civitai's
 * `src/server/services/app-assistant/runner-sleeping-apps.ts`), FOR the user the run grant names.
 * The wake ticket is minted by civitai on that grant: the user's own request. As every runner
 * client of civitai's, each call reads the run's grant inside its own fetch; neither the grant,
 * the secret nor a ticket is kept beyond the call, returned to the assistant or logged.
 */
export class CivitaiSleepingApps {
  readonly #options: CivitaiSleepingAppsOptions;

  constructor(options: CivitaiSleepingAppsOptions) {
    this.#options = options;
  }

  forRun(grant: () => Promise<string | null>, signal?: AbortSignal): RunSleepingApps {
    return {
      list: () => this.#list(grant, signal),
      wakeSeed: (app) => this.#wakeSeed(app, grant, signal),
    };
  }

  async #post(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ status: number; answer: Record<string, unknown> | null }> {
    const { civitaiUrl, secret } = this.#options;
    const doFetch = this.#options.fetch ?? fetch;
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, answer };
  }

  async #list(
    grant: () => Promise<string | null>,
    signal?: AbortSignal
  ): Promise<SleepingApp[] | null> {
    const { log } = this.#options;
    const token = await grant().catch(() => null);
    if (!token) return null;
    try {
      const { status, answer } = await this.#post(
        SLEEPING_APPS_PATH,
        { grant: token },
        LIST_TIMEOUT_MS,
        signal
      );
      if (status === 200 && Array.isArray(answer?.apps))
        return (answer.apps as unknown[]).filter(isSleepingApp);
      // The flag is off for the user: the everyday answer, not worth a line.
      if (status === 404 && answer?.code === 'disabled') return null;
      log.warn(
        { status, code: typeof answer?.code === 'string' ? answer.code : undefined },
        'civitai refused the sleeping-apps list'
      );
      return null;
    } catch (error) {
      log.warn({ err: (error as Error)?.name }, 'a sleeping-apps call to civitai failed');
      return null;
    }
  }

  async #wakeSeed(
    app: string,
    grant: () => Promise<string | null>,
    signal?: AbortSignal
  ): Promise<WakeSeed> {
    const { log } = this.#options;
    const token = await grant().catch(() => null);
    if (!token) throw new WakeSeedError('The run has ended', 'unavailable');
    let status: number;
    let answer: Record<string, unknown> | null;
    try {
      ({ status, answer } = await this.#post(
        WAKE_SEED_PATH,
        { grant: token, app },
        WAKE_SEED_TIMEOUT_MS,
        signal
      ));
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ err: (error as Error)?.name }, 'a wake-seed call to civitai failed');
      throw new WakeSeedError('civitai did not answer', 'unavailable');
    }
    if (status === 200 && isWakeSeed(answer)) return answer;
    const code = typeof answer?.code === 'string' ? answer.code : undefined;
    if (status === 404 && code === 'NOT_FOUND')
      throw new WakeSeedError('No sleeping app by that name', 'not_found');
    if (status === 409 && code === 'changed')
      throw new WakeSeedError('The app was changing', 'changed');
    log.warn({ status, code }, 'civitai refused a wake seed');
    throw new WakeSeedError('civitai refused the wake', 'unavailable');
  }
}

function isSleepingApp(value: unknown): value is SleepingApp {
  const v = value as Partial<SleepingApp> | null;
  return (
    typeof v?.app === 'string' &&
    typeof v.bytes === 'number' &&
    typeof v.hibernatedAt === 'string' &&
    (v.lastActivityAt === null || typeof v.lastActivityAt === 'string')
  );
}

function isWakeSeed(value: unknown): value is WakeSeed {
  const v = value as Partial<WakeSeed> | null;
  return (
    typeof v?.url === 'string' &&
    typeof v.sha256 === 'string' &&
    typeof v.bytes === 'number' &&
    typeof v.ticket === 'string'
  );
}
