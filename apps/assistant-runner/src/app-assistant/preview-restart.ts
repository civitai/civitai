import {
  SandboxApiError,
  createSandboxClient,
  isAppBlockId,
  previewGrantConversation,
  type Sandbox,
  type SandboxClient,
} from '@civitai/app-assistant';

import type { Logger } from '../interfaces';
import { MintRefusedError, type TokenSource } from '../minter';
import { DevTunnelError, type DevTunnels } from './dev-tunnel';
import { DevServerNotRunningError, RunnerPreview } from './preview';
import { AppSandbox } from './sandbox';

/** How many restarts one user may ask for in `RESTART_WINDOW_MS`, on one runner process. */
export const RESTART_LIMIT = 10;
export const RESTART_WINDOW_MS = 10 * 60_000;
/** How long a restart waits for an app the page just started to run; it never starts one itself. */
export const RESTART_WAIT_MS = 60_000;
const RESTART_POLL_MS = 3_000;
/** The id the restart's own calls are logged under: there is no run. */
const LOG_ID = 'preview-restart';

export type RestartErrorCode =
  | 'refused'
  | 'not-found'
  | 'not-running'
  | 'rate-limited'
  | 'failed'
  | 'unavailable';

/** What a restart answers the page: the block and host shown, never the tunnel's id. */
export type RestartOutcome =
  | { ok: true; blockId: string; host: string }
  | { ok: false; error: RestartErrorCode; message: string };

/** What the HTTP layer asks for (`POST apps/:app/preview`): one restart, for a verified viewer. */
export interface PreviewRestarts {
  /**
   * The conversation a preview grant for `app` must name (`preview:<app>`), or `null` when `app` is
   * not an app key. Asked of the restarter, not imported by the HTTP layer: `app.ts` takes nothing
   * at run time from `@civitai/app-assistant`, which the test runner's child processes (`tsx`, the
   * package read as CommonJS) cannot import names from.
   */
  grantConversation(app: string): string | null;
  /** `grant` is the request's own preview grant, already verified for this user and app. */
  restart(userId: string, app: string, grant: string): Promise<RestartOutcome>;
}

/** The page's words for each refusal: about the user's app, never the assistant's. */
export const RESTART_MESSAGES = {
  refused: 'Live preview is not available on this account.',
  'not-found': 'That app was not found among yours.',
  'app-not-running': 'Your app is not running. Start it, then restart the preview.',
  'dev-server-not-running':
    'Your app’s dev server is not running. Ask the assistant to start it, and the preview opens by itself.',
  'rate-limited':
    'Too many previews were started in the last hour. Wait a few minutes, then try again.',
  'runner-rate-limited':
    'You restarted the preview many times just now. Wait a few minutes, then try again.',
  failed:
    'The preview could not connect to your app. Make sure its dev server runs, then try again.',
  unavailable: 'The preview could not start just now. Try again in a moment.',
} as const;

/** `PreviewRestarts.grantConversation`: App Assistant makes every app key a valid block id (`newAppKey`). */
export function restartGrantConversation(app: string): string | null {
  return isAppBlockId(app) ? previewGrantConversation(app) : null;
}

export interface PreviewRestarterOptions {
  sandboxUrl: string;
  /**
   * Tokens and civitai's dev-tunnel endpoints with the request's own grant, held for that request
   * only (`RunCredentials.forGrant`, `CivitaiDevTunnels.forRun`).
   */
  forGrant(grant: string): { tokens: TokenSource; tunnels: DevTunnels };
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
}

/**
 * The page's Restart preview on the server runner: after a reload found no live preview, the user
 * asks for it again, with no reply, no model call and no Buzz. The same steps as `start_preview`
 * (`RunnerPreview.reopen`: a key in the sandbox, civitai opens the tunnel for the grant's user and
 * judges every gate, the sandbox dials it), then nothing more: no keep-alive, as no run is live, so
 * the tunnel idles out by civitai's own rules.
 *
 * Two clicks for one app share one restart (one tunnel); each user has `RESTART_LIMIT` restarts in
 * `RESTART_WINDOW_MS` here, on top of civitai's own hourly cap on unsubmitted apps.
 */
export class PreviewRestarter implements PreviewRestarts {
  readonly #options: PreviewRestarterOptions;
  readonly #inflight = new Map<string, Promise<RestartOutcome>>();
  readonly #recent = new Map<string, number[]>();

  constructor(options: PreviewRestarterOptions) {
    this.#options = options;
  }

  /**
   * Not tied to the request that asked: a second click shares this restart, so one caller going
   * away must not stop it for the other. Its civitai calls and sandbox tool calls have their own
   * timeouts; looking up the app at the sandbox service has none beyond the HTTP client's.
   */
  restart(userId: string, app: string, grant: string): Promise<RestartOutcome> {
    const key = `${userId}\n${app}`;
    const joined = this.#inflight.get(key);
    if (joined) return joined;
    if (!this.#allow(userId))
      return Promise.resolve({
        ok: false,
        error: 'rate-limited',
        message: RESTART_MESSAGES['runner-rate-limited'],
      });
    const run = this.#restart(app, grant).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, run);
    return run;
  }

  grantConversation(app: string): string | null {
    return restartGrantConversation(app);
  }

  #allow(userId: string): boolean {
    const now = this.#options.now?.() ?? Date.now();
    const kept = (this.#recent.get(userId) ?? []).filter((at) => now - at < RESTART_WINDOW_MS);
    if (kept.length >= RESTART_LIMIT) {
      this.#recent.set(userId, kept);
      return false;
    }
    kept.push(now);
    this.#recent.set(userId, kept);
    // Users with nothing left in the window are forgotten, so the map stays as small as the window.
    if (this.#recent.size > 1_000)
      for (const [user, times] of this.#recent)
        if (times.every((at) => now - at >= RESTART_WINDOW_MS)) this.#recent.delete(user);
    return true;
  }

  async #restart(app: string, grant: string): Promise<RestartOutcome> {
    const { sandboxUrl, log } = this.#options;
    const { tokens, tunnels } = this.#options.forGrant(grant);
    const stop = new AbortController();
    const sandboxToken = (fresh = false) => tokens('sandbox', { fresh });
    const client = createSandboxClient({
      baseUrl: sandboxUrl,
      getToken: ({ refresh } = {}) => sandboxToken(refresh),
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    });
    const sandbox = new AppSandbox({
      client,
      baseUrl: sandboxUrl,
      token: () => sandboxToken(),
      signal: stop.signal,
      log,
      runId: LOG_ID,
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    });
    const preview = new RunnerPreview({ sandbox, tunnels, log, runId: LOG_ID });
    try {
      const found = await this.#running(client, app);
      if ('error' in found) return found.error;
      // Running: `open` only connects to it, and never wakes or pauses anything.
      await sandbox.open(app, [found.sandbox]);
      const shown = await preview.reopen();
      return { ok: true, blockId: shown.blockId, host: shown.host };
    } catch (error) {
      return this.#refusal(error);
    } finally {
      // The run-less restart keeps nothing alive: the tunnel stays until civitai's idle expiry.
      preview.close();
      stop.abort();
      await sandbox.close().catch(() => undefined);
    }
  }

  /** The user's sandbox for `app` once it runs: one the page just started is waited for, never one that is paused. */
  async #running(
    client: SandboxClient,
    app: string
  ): Promise<{ sandbox: Sandbox } | { error: RestartOutcome }> {
    const notRunning = {
      error: {
        ok: false,
        error: 'not-running',
        message: RESTART_MESSAGES['app-not-running'],
      } as const,
    };
    let sandbox = (await client.list()).find((s) => s.app === app);
    if (!sandbox)
      return { error: { ok: false, error: 'not-found', message: RESTART_MESSAGES['not-found'] } };
    const deadline = Date.now() + (this.#options.waitMs ?? RESTART_WAIT_MS);
    while (sandbox.state === 'starting' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollMs ?? RESTART_POLL_MS));
      sandbox = await client.get(sandbox.name);
    }
    return sandbox.state === 'running' ? { sandbox } : notRunning;
  }

  #refusal(error: unknown): RestartOutcome {
    const fail = (code: RestartErrorCode, message: string): RestartOutcome => ({
      ok: false,
      error: code,
      message,
    });
    if (error instanceof DevServerNotRunningError)
      return fail('not-running', RESTART_MESSAGES['dev-server-not-running']);
    // civitai refused the user (a gate, their consent) at the sandbox token's mint. A grant that ran
    // out (it lives about 2 minutes) is not a refusal: the next click brings a fresh one.
    if (error instanceof MintRefusedError)
      return error.code === 'refused' || error.code === 'consent_required'
        ? fail('refused', RESTART_MESSAGES.refused)
        : fail('unavailable', RESTART_MESSAGES.unavailable);
    // The sandbox service would not list or look at the user's apps just now.
    if (error instanceof SandboxApiError) return fail('unavailable', RESTART_MESSAGES.unavailable);
    // civitai would not open the tunnel: its status says why (`start`'s documented answers).
    const tunnel = (error as { cause?: unknown } | null)?.cause;
    if (tunnel instanceof DevTunnelError) {
      if (tunnel.status === 429) return fail('rate-limited', RESTART_MESSAGES['rate-limited']);
      if (tunnel.status === 404) return fail('not-found', RESTART_MESSAGES['not-found']);
      if (tunnel.status === 403) return fail('refused', RESTART_MESSAGES.refused);
      return fail('unavailable', RESTART_MESSAGES.unavailable);
    }
    this.#options.log.warn(
      { runId: LOG_ID, err: (error as Error)?.name },
      'restarting a preview failed'
    );
    return fail('failed', RESTART_MESSAGES.failed);
  }
}
