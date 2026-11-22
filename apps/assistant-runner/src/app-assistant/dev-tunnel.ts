import { randomUUID } from 'node:crypto';

import type { Logger } from '../core/interfaces';

/** civitai's endpoints the runner opens, keeps and closes a run's dev tunnel at, relative to `CIVITAI_URL`. */
export const DEV_TUNNEL_PATH = 'api/internal/app-assistant/dev-tunnel';
/** civitai's endpoint the runner asks first how to open a preview (`preview/open`), relative to `CIVITAI_URL`. */
export const PREVIEW_OPEN_PATH = 'api/internal/app-assistant/preview/open';
/**
 * How many times `open` asks while civitai answers `unavailable`: it does so while another open of
 * the same app holds its lock (the page's Restart preview and a run's start at once), and for a
 * moment's failure. `OPEN_RETRY_MS` apart: about 3 s of waiting between asks, on top of each ask's
 * own `REQUEST_TIMEOUT_MS` (15 s), so at most about 63 s in all.
 */
export const OPEN_ATTEMPTS = 4;
const OPEN_RETRY_MS = 1_000;
/** How long a keep-alive or a stop waits for civitai. */
export const REQUEST_TIMEOUT_MS = 15_000;
/**
 * The longest civitai's start endpoint takes to answer. Mirrors
 * `RUNNER_DEV_TUNNEL_START_DEADLINE_MS` in civitai's `dev-tunnel.service.ts` (the runner imports
 * nothing of civitai's); keep them equal.
 */
export const CIVITAI_START_DEADLINE_MS = 185_000;
/**
 * How long a start waits: civitai's start deadline (`CIVITAI_START_DEADLINE_MS`) plus 15 s of
 * margin. Any shorter, and the runner gives up on a start civitai still answers in time.
 */
export const START_TIMEOUT_MS = CIVITAI_START_DEADLINE_MS + 15_000;
/** How many times an abandoned start's stop by key is asked, and how far apart. */
const STOP_BY_KEY_ATTEMPTS = 3;
const STOP_BY_KEY_RETRY_MS = 5_000;

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

export interface PreviewOpenInput {
  blockId: string;
  /** The app's sandbox's current preview id (32 lowercase hex). */
  previewId: string;
  declaredScopes?: string[];
  declaredAuth?: 'block-token' | 'oauth';
}

/**
 * What civitai's `preview/open` answers:
 * - `tunnel`: direct preview is off for this user (or not deployed): open a dev tunnel as before;
 * - `direct` with a session: the preview's session, written now or one already open for that
 *   preview id. A session already open keeps the scopes and auth it was opened with, whatever
 *   this open declared. civitai answers only `{ mode, sessionId }`: never the session host, which
 *   is the preview's credential;
 * - `fresh`: that preview id's session has ended, and nothing was opened: rotate the id and ask
 *   once more.
 */
export type PreviewOpenAnswer =
  | { mode: 'tunnel' }
  | { mode: 'direct'; fresh: true }
  | { mode: 'direct'; sessionId: string };

/** One run's dev-tunnel calls to civitai. */
export interface DevTunnels {
  start(input: DevTunnelStartInput, signal?: AbortSignal): Promise<StartedTunnel>;
  /**
   * Asks civitai how to open the preview, and opens it when it is a direct one (no tunnel): see
   * `PreviewOpenAnswer`. civitai judges the same gates as `start`.
   */
  open(input: PreviewOpenInput, signal?: AbortSignal): Promise<PreviewOpenAnswer>;
  /**
   * Stamps the idle clock (never the 8 h cap) of one of the run's user's previews, whoever opened
   * it (this run, the page's Restart preview, an earlier reply): the tunnel at `host`, the host the
   * app's sandbox is connected to, or the direct preview of the app `blockId` (which no sandbox-side
   * tunnel names). By block it is sent with `transport: "direct"`, so civitai keeps only a direct
   * session and never a tunnel the sandbox has let go. civitai answers 404 `NOT_FOUND` when the
   * user has none there. A civitai without the by-block route (it refuses that body with a codeless
   * 400 or 404) is answered as none too: 404, code `no_route`.
   */
  keepalive(target: { host: string } | { blockId: string }, signal?: AbortSignal): Promise<void>;
  /** Idempotent: a tunnel already gone is no error. */
  stop(sessionId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Ends the run's user's direct preview of the app `blockId`, whichever run opened it. Sent with
   * `transport: "direct"`: a tunnel of that app is left alone, as if there were none. Whether one
   * was open to end: `false` too from a civitai without the by-block route.
   */
  stopBlock(blockId: string, signal?: AbortSignal): Promise<boolean>;
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
        // Read once and kept for the cleanup below: an ended reply's grant may already be gone
        // here, and civitai still takes it to close a tunnel.
        const token = await grant();
        const held = async () => token;
        const clientKey = randomUUID();
        try {
          const answer = await this.#post(
            'start',
            held,
            { ...input, clientKey },
            signal,
            START_TIMEOUT_MS
          );
          const { sessionId, host, sshHostPublicKey } = (answer ?? {}) as Record<string, unknown>;
          if (
            typeof sessionId !== 'string' ||
            !sessionId ||
            typeof host !== 'string' ||
            !host ||
            typeof sshHostPublicKey !== 'string' ||
            !sshHostPublicKey
          )
            throw new DevTunnelError(
              'Civitai answered the preview start oddly.',
              503,
              'unavailable'
            );
          return { sessionId, host, sshHostPublicKey };
        } catch (error) {
          // Given up on, or failed on civitai's side: civitai may have opened it, so it is closed
          // by this start's key. A refusal (4xx) opened nothing. Not awaited, so a Stop is not
          // held up by it.
          if (token && (!(error instanceof DevTunnelError) || error.status >= 500))
            void this.#stopByKey(held, clientKey);
          throw error;
        }
      },
      open: (input, signal) => this.#open(grant, input, signal),
      keepalive: async (target, signal) => {
        if ('host' in target) {
          await post('keepalive', { host: target.host }, signal);
          return;
        }
        try {
          await post('keepalive', { blockId: target.blockId, transport: 'direct' }, signal);
        } catch (error) {
          if (isNoRoute(error))
            throw new DevTunnelError('Civitai keeps no preview by block here.', 404, 'no_route');
          throw error;
        }
      },
      stop: async (sessionId, signal) => {
        await post('stop', { sessionId }, signal);
      },
      stopBlock: async (blockId, signal) => {
        let answer: { stopped?: unknown } | null;
        try {
          answer = (await post('stop', { blockId, transport: 'direct' }, signal)) as {
            stopped?: unknown;
          } | null;
        } catch (error) {
          // A civitai without the by-block route has no direct preview to end.
          if (isNoRoute(error)) return false;
          throw error;
        }
        return answer?.stopped === true;
      },
    };
  }

  /**
   * `preview/open`, asked again (up to `OPEN_ATTEMPTS` times) while civitai answers `unavailable`,
   * which it does while another open of the same app holds its lock: nothing was written then. A
   * civitai without the endpoint (a 404 with no code: an older deployment) means the dev tunnel.
   */
  async #open(
    grant: () => Promise<string | null>,
    input: PreviewOpenInput,
    signal?: AbortSignal
  ): Promise<PreviewOpenAnswer> {
    for (let attempt = 1; ; attempt++) {
      let answer: unknown;
      try {
        answer = await this.#post(
          PREVIEW_OPEN_PATH,
          grant,
          { ...input },
          signal,
          REQUEST_TIMEOUT_MS
        );
      } catch (error) {
        if (error instanceof DevTunnelError && error.status === 404 && error.code === undefined)
          return { mode: 'tunnel' };
        const again = error instanceof DevTunnelError && error.code === 'unavailable';
        if (!again || attempt >= OPEN_ATTEMPTS || signal?.aborted) throw error;
        await sleep(OPEN_RETRY_MS, signal);
        continue;
      }
      // Only `mode` and `sessionId` (or `fresh`): civitai never sends the session host (`PreviewOpenAnswer`).
      const { mode, fresh, sessionId } = (answer ?? {}) as Record<string, unknown>;
      if (mode === 'tunnel') return { mode: 'tunnel' };
      if (mode === 'direct' && fresh === true) return { mode: 'direct', fresh: true };
      if (mode === 'direct' && typeof sessionId === 'string' && sessionId)
        return { mode: 'direct', sessionId };
      throw new DevTunnelError('Civitai answered the preview open oddly.', 503, 'unavailable');
    }
  }

  /**
   * Closes an abandoned start by its key, in the background. civitai's `unavailable` (and a stop
   * that could not reach it) means "ask again", so it is asked up to `STOP_BY_KEY_ATTEMPTS` times,
   * `STOP_BY_KEY_RETRY_MS` apart; a refusal (4xx) is final. Never throws.
   */
  async #stopByKey(grant: () => Promise<string | null>, clientKey: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#post('stop', grant, { clientKey }, undefined, REQUEST_TIMEOUT_MS);
        return;
      } catch (error) {
        const again = error instanceof DevTunnelError && error.status >= 500;
        if (!again || attempt >= STOP_BY_KEY_ATTEMPTS) {
          this.#options.log.warn(
            { action: 'stop', err: (error as Error)?.name, attempts: attempt },
            'closing an abandoned dev-tunnel start failed'
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, STOP_BY_KEY_RETRY_MS));
      }
    }
  }

  /** `actionOrPath`: a dev-tunnel endpoint's name (`start`, `stop`, …), or another endpoint's path. */
  async #post(
    actionOrPath: string,
    grant: () => Promise<string | null>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    const { civitaiUrl, secret, log } = this.#options;
    const path = actionOrPath.includes('/') ? actionOrPath : `${DEV_TUNNEL_PATH}/${actionOrPath}`;
    const action = path.slice(path.lastIndexOf('/') + 1);
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
      response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${path}`, {
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

/**
 * civitai refused a by-block body as it does not know it (a deployment from before the by-block
 * keepalive and stop): a 400 or 404 with no code. The runner is
 * released apart from civitai, so this is answered as "no such preview", never as a refusal.
 */
function isNoRoute(error: unknown): boolean {
  return (
    error instanceof DevTunnelError &&
    (error.status === 400 || error.status === 404) &&
    error.code === undefined
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
