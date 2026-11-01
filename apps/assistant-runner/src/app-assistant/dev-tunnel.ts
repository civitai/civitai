import type { Logger } from '../core/interfaces';

/** civitai's endpoints the runner opens, keeps and closes a run's dev tunnel at, relative to `CIVITAI_URL`. */
export const DEV_TUNNEL_PATH = 'api/internal/app-assistant/dev-tunnel';
/** How long a keep-alive or a stop waits for civitai. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * How long a start waits. civitai answers a start only once the tunnel's route has been applied,
 * which it waits up to 180 s for (`renderDevTunnelRoute`), and it keeps the tunnel it opened even
 * when the caller has gone. A start the runner gives up on sooner is one civitai still opens: the
 * sandbox never connects to it, yet civitai lists it as live, so the page shows a preview that can
 * only fail to load. Most starts answer in seconds; this covers civitai's own bound with margin.
 */
const START_TIMEOUT_MS = 200_000;

/** What civitai's `start` answers: the tunnel's id (the runner's alone), its host and sish's host key. */
export interface StartedTunnel {
  sessionId: string;
  host: string;
  sshHostPublicKey: string;
}

export interface DevTunnelStartInput {
  blockId: string;
  /** The sandbox's own single-use public key (`sandbox__tunnel_key`): never a civitai credential. */
  sshPublicKey: string;
  declaredScopes?: string[];
  declaredAuth?: 'block-token' | 'oauth';
}

/**
 * civitai would not do it: `status` and `code` as its endpoint answered them (`FORBIDDEN`,
 * `NOT_FOUND`, `TOO_MANY_REQUESTS`, `BAD_REQUEST`, `refused`, `invalid_grant`, `unavailable`).
 * `unavailable` (503) is worth asking again; the rest are not.
 */
export class DevTunnelError extends Error {
  override name = 'DevTunnelError';
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** One run's dev-tunnel calls to civitai. */
export interface DevTunnels {
  start(input: DevTunnelStartInput, signal?: AbortSignal): Promise<StartedTunnel>;
  /**
   * Stamps the idle clock (never the 8 h cap) of the run's user's tunnel at `host`, whoever opened
   * it (this run, the page's Restart preview, an earlier reply): the host the app's sandbox is
   * connected to. civitai answers 404 `NOT_FOUND` when no tunnel of that user's is there.
   */
  keepalive(target: { host: string }, signal?: AbortSignal): Promise<void>;
  /** Idempotent: a tunnel already gone is no error. */
  stop(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export interface CivitaiDevTunnelsOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every call. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
}

/**
 * civitai's dev-tunnel endpoints for the runner (civitai's
 * `src/pages/api/internal/app-assistant/dev-tunnel/`). civitai opens the tunnel for the user its run
 * grant names, re-judging every gate on every call; the runner holds nothing that opens one by
 * itself. Each call reads the run's grant (`grant`, from the runner's grants table) inside its own
 * fetch, as a mint does: neither the grant nor the secret is kept, returned or logged.
 */
export class CivitaiDevTunnels {
  readonly #options: CivitaiDevTunnelsOptions;

  constructor(options: CivitaiDevTunnelsOptions) {
    this.#options = options;
  }

  forRun(grant: () => Promise<string | null>): DevTunnels {
    const post = (
      action: string,
      body: Record<string, unknown>,
      signal?: AbortSignal,
      timeoutMs = REQUEST_TIMEOUT_MS
    ) => this.#post(action, grant, body, signal, timeoutMs);
    return {
      start: async (input, signal) => {
        const answer = await post('start', { ...input }, signal, START_TIMEOUT_MS);
        const { sessionId, host, sshHostPublicKey } = (answer ?? {}) as Record<string, unknown>;
        if (
          typeof sessionId !== 'string' ||
          !sessionId ||
          typeof host !== 'string' ||
          !host ||
          typeof sshHostPublicKey !== 'string' ||
          !sshHostPublicKey
        )
          throw new DevTunnelError('Civitai answered the preview start oddly.', 503, 'unavailable');
        return { sessionId, host, sshHostPublicKey };
      },
      keepalive: async ({ host }, signal) => {
        await post('keepalive', { host }, signal);
      },
      stop: async (sessionId, signal) => {
        await post('stop', { sessionId }, signal);
      },
    };
  }

  async #post(
    action: string,
    grant: () => Promise<string | null>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    const { civitaiUrl, secret, log } = this.#options;
    const token = await grant();
    if (!token)
      throw new DevTunnelError(
        'This reply can no longer act for you. Send your message again.',
        401,
        'invalid_grant'
      );
    const doFetch = this.#options.fetch ?? fetch;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${DEV_TUNNEL_PATH}/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant: token, ...body }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ action, err: (error as Error)?.name }, 'a dev-tunnel call to civitai failed');
      throw new DevTunnelError('Civitai could not be reached just now.', 503, 'unavailable');
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
    else log.warn({ action, status: response.status, code }, 'civitai refused a dev-tunnel call');
    throw new DevTunnelError(
      typeof answer?.error === 'string' && answer.error ? answer.error : 'Civitai refused it.',
      response.status,
      code ?? (response.status >= 500 ? 'unavailable' : undefined)
    );
  }
}
