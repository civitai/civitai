import {
  DEV_SERVER_COMMAND,
  DEV_SERVER_PORT,
  START_PREVIEW,
  STOP_PREVIEW,
  isAppBlockId,
  previewRefusal,
  type Sandbox,
} from '@civitai/app-assistant';
import type { ChatTool } from '@civitai/components-chat/core';

import type { Logger } from '../interfaces';
import { DevTunnelError, type DevTunnels } from './dev-tunnel';

/**
 * How often a live run stamps its tunnel's idle clock. civitai reaps a tunnel 30 minutes after its
 * last activity (`DEV_TUNNEL_IDLE_SECONDS`); every 5 minutes leaves five more chances inside that
 * window when a call fails (civitai's `unavailable` is retried at the next one), costs at most 24
 * calls in a 2-hour run, and, since every call re-judges the user's gates, a gate turned off stops
 * keeping the tunnel alive within about 5 minutes.
 */
export const PREVIEW_KEEPALIVE_MS = 5 * 60_000;

/** The most of a sandbox tool's own words the assistant is told when the tunnel would not open. */
const DETAIL_CHARS = 500;

/**
 * How long `startDevServer` waits for the dev server it started to listen; its last probe can run
 * up to `PROBE_TIMEOUT_MS` past it. Vite on a scaffolded App Block listens within seconds. The whole
 * Restart is one request whose grant lives about 2 minutes and must still open the tunnel after
 * this, behind up to `RESTART_WAIT_MS` of waiting for a starting app, so this is kept short.
 */
export const DEV_SERVER_WAIT_MS = 20_000;
const DEV_SERVER_POLL_MS = 1_000;
/** One probe's own bound: the sandbox kills it (and all it started) past this. */
const PROBE_TIMEOUT_MS = 10_000;
/**
 * Exits 0 when something listens on the dev server's port, on IPv4 or IPv6 (Vite may listen on `::1`
 * only), else 3. Each connect gives up after 1 s.
 */
const LISTEN_PROBE =
  `node -e 'const net=require("net");` +
  `const p=(h)=>new Promise((r)=>{const s=net.connect(${DEV_SERVER_PORT},h);` +
  `const d=(v)=>{s.destroy();r(v)};s.setTimeout(1000,()=>d(false));` +
  `s.once("connect",()=>d(true));s.once("error",()=>d(false))});` +
  `Promise.all([p("127.0.0.1"),p("::1")]).then((a)=>process.exit(a.includes(true)?0:3))'`;

export interface RunnerPreviewDeps {
  /** The reply's sandbox: the app open now, and the runner's own calls to its tools. */
  sandbox: {
    readonly active: Pick<Sandbox, 'name' | 'app' | 'state'> | null;
    call(
      tool: string,
      args: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<{ text: string; isError: boolean }>;
  };
  /** civitai's dev-tunnel endpoints, with this run's grant. */
  tunnels: DevTunnels;
  log: Logger;
  runId: string;
  keepaliveMs?: number;
  /** `startDevServer`'s wait for the dev server to listen (`DEV_SERVER_WAIT_MS`), and its step. */
  devServerWaitMs?: number;
  devServerPollMs?: number;
}

/** The tunnel this run opened: kept in this process's memory only, never in a result. */
interface OpenTunnel {
  sessionId: string;
  /** The sandbox it serves: another app opened by `create_app` is another preview. */
  app: string;
  blockId: string;
  host: string;
  /** What it was opened with: a start asking for other scopes or auth opens it again. */
  declaredScopes: string[];
  declaredAuth: 'block-token' | 'oauth' | undefined;
  /** What the start that opened it answered: a start of the same preview answers it again. */
  result: StartedPreview;
}

/** What a start answers (and the page reads `blockId` and `host` of): never the tunnel's id. */
export interface StartedPreview {
  shown: true;
  blockId: string;
  host: string;
  next_step: string;
}

/** How the automatic start after a dev server came up went: shown, or why not. */
export type AutoPreview = { shown: StartedPreview } | { error: string };

/**
 * The live preview on the server runner: `start_preview` and `stop_preview`, named and described for
 * the assistant as the page's are, but the runner does every tunnel step itself. civitai opens the
 * tunnel for the run grant's user; the sandbox only ever gets its own single-use key's host and sish's
 * host key, as in the browser; the assistant never gets the raw tunnel tools, so it cannot point the
 * sandbox at a host civitai did not open. What a result says (and so what the page and the saved
 * conversation see) is the block id and the host, never the tunnel's id.
 *
 * While the run lives the tunnel is kept from idling out (`PREVIEW_KEEPALIVE_MS`); `close()`, as the
 * run ends, stops that and leaves the tunnel to civitai's normal idle expiry, so the user can keep
 * looking at it for a while after the reply ends.
 */
export class RunnerPreview {
  readonly #deps: RunnerPreviewDeps;
  #open: OpenTunnel | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #keeping = false;
  #closed = false;
  /**
   * Starts and stops run one at a time: the chat runs a step's calls together, and two starts at
   * once would each make a key (the second stopping the first's tunnel) and fail one another.
   */
  #queue: Promise<unknown> = Promise.resolve();
  /** The apps (sandbox names) this run already opened the preview for by itself: once each. */
  readonly #autoTried = new Set<string>();

  constructor(deps: RunnerPreviewDeps) {
    this.#deps = deps;
  }

  /** Stops keeping the tunnel alive (the run ended); the tunnel itself stays until it idles out. */
  close(): void {
    this.#closed = true;
    this.#open = null;
    this.#stopKeeping();
  }

  tools(): Record<string, ChatTool> {
    return { [START_PREVIEW]: this.#startTool(), [STOP_PREVIEW]: this.#stopTool() };
  }

  #startTool(): ChatTool {
    return {
      description:
        'Reopen the live preview of the running dev server beside the chat. It opens by itself when sandbox__dev_server_start starts the dev server: call this only when the user asks to reopen it. ' +
        'Use sandbox__preview_check to see what the user sees.',
      activity: 'Starting the preview…',
      inputSchema: {
        properties: {
          block_id: {
            type: 'string',
            description:
              "The app's blockId from block.manifest.json: 3-40 characters, lowercase letters, digits and dashes, starting with a letter. Defaults to the app's own key.",
          },
          declared_scopes: {
            type: 'array',
            items: { type: 'string' },
            description:
              "The scopes in block.manifest.json. Without them the preview runs read-only; spending scopes also depend on the user's account.",
          },
          declared_auth: {
            type: 'string',
            enum: ['block-token', 'oauth'],
            description: "The manifest's auth, if it declares one.",
          },
        },
      },
      execute: (input, context) => this.#serial(() => this.#start(input, context.signal)),
    };
  }

  #stopTool(): ChatTool {
    return {
      description: 'Stop the live preview.',
      activity: 'Stopping the preview…',
      inputSchema: { properties: {} },
      execute: (_input, context) => this.#serial(() => this.#stop(context.signal)),
    };
  }

  /**
   * After `sandbox__dev_server_start` (or `_restart`) started the dev server: opens the preview for the open app,
   * once per app in this run, with no decision of the assistant's (it was seen building, checking
   * and reporting ready without ever opening it). The block id, scopes and auth come from the
   * project's `block.manifest.json` (the directory the start command `cd`s into, else the app's
   * own key), as the assistant would pass them. `null` when there is nothing to say: this run
   * already tried for this app, or a preview of it is already open. A refusal is reported, never
   * thrown: the dev server did start.
   */
  openAfterDevServer(input: unknown, signal?: AbortSignal): Promise<AutoPreview | null> {
    return this.#serial(async () => {
      const app = this.#deps.sandbox.active;
      if (this.#closed || !app || app.state !== 'running') return null;
      if (this.#autoTried.has(app.name)) return null;
      this.#autoTried.add(app.name);
      if (this.#open?.app === app.name) return null;
      try {
        const manifest = await this.#manifest(projectDirOf(input) ?? app.app, signal);
        return { shown: await this.#start(manifest, signal) };
      } catch (error) {
        return { error: (error as Error)?.message ?? 'The preview could not start.' };
      }
    });
  }

  /**
   * Opens the preview again outside any reply: the page's Restart preview (`PreviewRestarter`), after
   * a reload found none live. The same start as `start_preview`, for the same block, scopes and auth
   * `openAfterDevServer` reads (the manifest in the directory the running dev server was started
   * in, else the app's own key). Throws `DevServerNotRunningError` when the sandbox says its dev
   * server is not running, as there would be nothing to show.
   */
  reopen(signal?: AbortSignal): Promise<StartedPreview> {
    return this.#serial(async () => {
      const app = this.#deps.sandbox.active;
      if (this.#closed || !app || app.state !== 'running') throw new DevServerNotRunningError();
      const status = await this.#deps.sandbox.call('dev_server_status', {}, signal);
      const parsed = status.isError ? null : parseJson(status.text);
      if ((parsed as { running?: unknown } | null)?.running !== true)
        throw new DevServerNotRunningError();
      const manifest = await this.#manifest(projectDirOf(parsed) ?? app.app, signal);
      return this.#start(manifest, signal);
    });
  }

  /**
   * Starts the open app's dev server when it is not running (the page's Restart preview, as after
   * every resume: a resumed sandbox runs none), as the assistant is told to, with
   * `sandbox__dev_server_start` and `cd <project> && DEV_SERVER_COMMAND`, then waits, bounded, for it
   * to listen. Never a second one: one already running (or started meanwhile by another start, which
   * the sandbox refuses ours for) is only waited for. The project is the directory the sandbox last
   * ran it in, else the app key's own, else the only top-level directory, that holds a
   * `block.manifest.json`. Throws `DevServerStartError`, saying what failed, when it does not run.
   */
  startDevServer(signal?: AbortSignal): Promise<void> {
    return this.#serial(async () => {
      const app = this.#deps.sandbox.active;
      if (this.#closed || !app || app.state !== 'running') throw new DevServerNotRunningError();
      const status = await this.#devServerStatus(signal);
      if (status?.running !== true) {
        const dir = await this.#projectDir(app.app, status, signal);
        if (!dir) throw new DevServerStartError('no-project');
        const started = await this.#deps.sandbox.call(
          'dev_server_start',
          { command: `cd ${dir} && ${DEV_SERVER_COMMAND}` },
          signal
        );
        const answer = started.isError ? null : asStatus(parseJson(started.text));
        // Refused: another start may have won (the sandbox runs one at a time); else it failed.
        if (started.isError && (await this.#devServerStatus(signal))?.running !== true)
          throw new DevServerStartError('refused');
        if (answer && answer.running === false) throw new DevServerStartError('exited', answer);
      }
      await this.#listening(signal);
    });
  }

  async #devServerStatus(signal?: AbortSignal): Promise<DevServerStatus | null> {
    const status = await this.#deps.sandbox.call('dev_server_status', {}, signal);
    return status.isError ? null : asStatus(parseJson(status.text));
  }

  /** Where to start the dev server: see `startDevServer`; `null` when none is clear. */
  async #projectDir(
    appKey: string,
    status: DevServerStatus | null,
    signal?: AbortSignal
  ): Promise<string | null> {
    const remembered = projectDirOf(status);
    // Still a project: a directory renamed or removed since then is passed over.
    if (remembered && isProjectDir(remembered) && (await this.#hasManifest(remembered, signal)))
      return remembered;
    if (isProjectDir(appKey) && (await this.#hasManifest(appKey, signal))) return appKey;
    const listed = await this.#deps.sandbox.call(
      'run_command',
      {
        command:
          'for f in */block.manifest.json; do [ -f "$f" ] && printf "%s\\n" "${f%/block.manifest.json}"; done; exit 0',
        timeout_ms: PROBE_TIMEOUT_MS,
      },
      signal
    );
    if (listed.isError || exitCodeOf(listed.text) !== 0) return null;
    const dirs = outputOf(listed.text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return dirs.length === 1 && isProjectDir(dirs[0]!) ? dirs[0]! : null;
  }

  async #hasManifest(dir: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const read = await this.#deps.sandbox.call(
        'read_file',
        { path: `${dir}/block.manifest.json` },
        signal
      );
      return !read.isError && manifestOf(read.text) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Waits up to `devServerWaitMs` for something to listen on the dev server's port, looking at the
   * dev server between probes: one that stopped is not waited for.
   */
  async #listening(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.#deps.devServerWaitMs ?? DEV_SERVER_WAIT_MS);
    for (;;) {
      const probe = await this.#deps.sandbox.call(
        'run_command',
        { command: LISTEN_PROBE, timeout_ms: PROBE_TIMEOUT_MS },
        signal
      );
      if (!probe.isError && exitCodeOf(probe.text) === 0) return;
      const status = await this.#devServerStatus(signal);
      if (status && status.running === false) throw new DevServerStartError('exited', status);
      if (Date.now() >= deadline) throw new DevServerStartError('timeout');
      await sleep(this.#deps.devServerPollMs ?? DEV_SERVER_POLL_MS, signal);
    }
  }

  /** What the start needs from the project's manifest; `{}` (the app's own key) when unreadable. */
  async #manifest(dir: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let read: { text: string; isError: boolean };
    try {
      read = await this.#deps.sandbox.call(
        'read_file',
        { path: `${dir}/block.manifest.json` },
        signal
      );
    } catch {
      return {};
    }
    if (read.isError) return {};
    const manifest = manifestOf(read.text);
    if (!manifest) return {};
    return {
      ...(typeof manifest.blockId === 'string' ? { block_id: manifest.blockId } : {}),
      ...(Array.isArray(manifest.scopes) ? { declared_scopes: manifest.scopes } : {}),
      ...(typeof manifest.auth === 'string' ? { declared_auth: manifest.auth } : {}),
    };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #start(input: Record<string, unknown>, signal?: AbortSignal): Promise<StartedPreview> {
    const { sandbox, tunnels } = this.#deps;
    if (this.#closed) throw new Error('This reply has ended.');
    const app = sandbox.active;
    if (!app || app.state !== 'running')
      throw new Error(
        'Your app is not running, so there is nothing to preview. Its tools arrive with your next reply.'
      );
    const declaredScopes = Array.isArray(input.declared_scopes)
      ? input.declared_scopes
          // The bounds civitai's endpoint enforces (`devTunnelStartFields`).
          .filter((s): s is string => typeof s === 'string' && s.length >= 1 && s.length <= 64)
          .slice(0, 32)
      : undefined;
    const declaredAuth =
      input.declared_auth === 'oauth' || input.declared_auth === 'block-token'
        ? input.declared_auth
        : undefined;
    // Already open for this app in this run (by itself after the dev server started, or by an
    // earlier call) and asked for again as it is: the same answer, and nothing is opened twice.
    // Another block id, or other scopes or auth than it was opened with, is a new start.
    const open = this.#open;
    if (
      open &&
      open.app === app.name &&
      (typeof input.block_id !== 'string' || input.block_id === open.blockId) &&
      (declaredScopes === undefined || sameScopes(declaredScopes, open.declaredScopes)) &&
      (declaredAuth === undefined || declaredAuth === open.declaredAuth)
    )
      return open.result;
    const blockId = typeof input.block_id === 'string' ? input.block_id : app.app;
    if (!isAppBlockId(blockId))
      throw new Error(
        'Pass block_id: 3-40 characters, lowercase letters, digits and dashes, starting with a letter.'
      );

    // 1. A fresh single-use key, made in the sandbox: only its public half leaves it.
    const key = await sandbox.call('tunnel_key', {}, signal);
    const publicKey = key.isError ? null : publicKeyOf(key.text);
    if (!publicKey)
      throw new Error(`The preview could not start: ${detail(key.text)} Call start_preview again.`);

    // 2. civitai opens the tunnel for this run's user, judging every gate itself.
    let started;
    try {
      started = await tunnels.start(
        {
          blockId,
          sshPublicKey: publicKey,
          ...(declaredScopes ? { declaredScopes } : {}),
          ...(declaredAuth ? { declaredAuth } : {}),
        },
        signal
      );
    } catch (error) {
      // The refusal itself goes with it: the page's Restart preview answers by its status.
      throw new Error(refusalMessage(error), { cause: error });
    }
    const close = (sessionId: string) =>
      tunnels.stop(sessionId).catch((error) => this.#warn(error, 'closing a preview failed'));
    if (sandbox.active?.name !== app.name || this.#closed) {
      await close(started.sessionId);
      throw new Error(
        'Your app changed while the preview was starting. Start the preview again in the open app.'
      );
    }

    // 3. The sandbox dials the host civitai named, pinning the host key civitai gave.
    let connected: { text: string; isError: boolean };
    try {
      connected = await sandbox.call(
        'tunnel_connect',
        { host: started.host, ssh_host_public_key: started.sshHostPublicKey },
        signal
      );
    } catch (error) {
      connected = { text: (error as Error)?.message ?? 'no answer', isError: true };
    }
    if (connected.isError) {
      await close(started.sessionId);
      throw new Error(
        `The preview could not connect: ${detail(
          connected.text
        )} Make sure the dev server runs (sandbox__dev_server_status), then call start_preview again.`
      );
    }

    // A preview of another block this run opened goes; one of the same block civitai already replaced.
    const previous = this.#open;
    if (previous && previous.blockId !== blockId) await close(previous.sessionId);
    const result: StartedPreview = {
      shown: true,
      blockId,
      host: started.host,
      next_step:
        'The user sees the preview now. To see what they see, call sandbox__preview_check.',
    };
    this.#open = {
      sessionId: started.sessionId,
      app: app.name,
      blockId,
      host: started.host,
      declaredScopes: declaredScopes ?? [],
      declaredAuth,
      result,
    };
    this.#keepAlive();
    return result;
  }

  async #stop(signal?: AbortSignal) {
    const open = this.#open;
    this.#open = null;
    this.#stopKeeping();
    if (open)
      await this.#deps.tunnels
        .stop(open.sessionId, signal)
        .catch((error) => this.#warn(error, 'closing a preview failed'));
    // A preview an earlier reply started is not this run's to close at civitai (its id went with that
    // run): closing the sandbox's side ends it, and civitai's side idles out.
    let disconnected = false;
    if (this.#deps.sandbox.active?.state === 'running') {
      const result = await this.#deps.sandbox
        .call('tunnel_disconnect', {}, signal)
        .catch(() => ({ text: '', isError: true }));
      disconnected = !result.isError;
    }
    return { stopped: Boolean(open) || disconnected };
  }

  #keepAlive(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(
      () => void this.#tick(),
      this.#deps.keepaliveMs ?? PREVIEW_KEEPALIVE_MS
    );
    this.#timer.unref?.();
  }

  #stopKeeping(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #tick(): Promise<void> {
    const open = this.#open;
    if (!open || this.#closed || this.#keeping) return;
    this.#keeping = true;
    try {
      await this.#deps.tunnels.keepalive(open.sessionId);
    } catch (error) {
      // Gone (past its cap, closed elsewhere), refused, or the grant is no longer good: nothing left
      // to keep alive. `unavailable` is asked again at the next tick.
      if (!(error instanceof DevTunnelError) || error.code !== 'unavailable') {
        if (this.#open === open) {
          this.#open = null;
          this.#stopKeeping();
        }
      }
      this.#warn(error, 'keeping a preview alive failed');
    } finally {
      this.#keeping = false;
    }
  }

  #warn(error: unknown, message: string): void {
    const { status, code } = error instanceof DevTunnelError ? error : ({} as DevTunnelError);
    this.#deps.log.warn(
      { runId: this.#deps.runId, err: (error as Error)?.name, status, code },
      message
    );
  }
}

/** The dev server is not running (or the sandbox would not say), so a preview would show nothing. */
export class DevServerNotRunningError extends Error {
  override name = 'DevServerNotRunningError';
  constructor() {
    super('The dev server is not running.');
  }
}

/**
 * Starting the dev server failed: `no-project` (which project to start was not clear), `refused` (the
 * sandbox would not start it), `exited` (it stopped as soon as it started; `exitCode` is its code),
 * or `timeout` (it never listened in time).
 */
export class DevServerStartError extends Error {
  override name = 'DevServerStartError';
  readonly exitCode: number | null;
  constructor(
    readonly reason: 'no-project' | 'refused' | 'exited' | 'timeout',
    status?: DevServerStatus
  ) {
    super(`The dev server did not start (${reason}).`);
    const code = status?.lastExit?.code;
    this.exitCode = typeof code === 'number' ? code : null;
  }
}

/** What `sandbox__dev_server_status` (and a start) answers, as far as it is read here. */
interface DevServerStatus {
  running?: unknown;
  command?: unknown;
  lastExit?: { code?: unknown } | null;
}

function asStatus(value: unknown): DevServerStatus | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as DevServerStatus)
    : null;
}

/**
 * A project directory safe to put in a shell command unquoted: one top-level name (as `projectDirOf`
 * reads it), not starting with a dash or a dot.
 */
function isProjectDir(dir: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(dir);
}

/** `sandbox__run_command`'s exit code (its first line, `exit_code: N`), else `null`. */
function exitCodeOf(text: string): number | null {
  const match = /^exit_code: (-?\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** `sandbox__run_command`'s output: what follows its header's `---` line. */
function outputOf(text: string): string {
  const at = text.indexOf('\n---\n');
  return at < 0 ? '' : text.slice(at + 5);
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The project directory a `sandbox__dev_server_start` command runs in (`cd <dir> && …`, as the
 * instructions give it), else `null`.
 */
export function projectDirOf(input: unknown): string | null {
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return null;
  const dir = /^\s*cd\s+([A-Za-z0-9._-]+)\s*(?:&&|;)/.exec(command)?.[1];
  return dir && dir !== '.' && dir !== '..' ? dir : null;
}

/**
 * A `block.manifest.json` as `sandbox__read_file` answers it: `{ path, size, …, content }`, the
 * file's text in `content`. Anything else is no manifest.
 */
export function manifestOf(text: string): Record<string, unknown> | null {
  try {
    const content = (JSON.parse(text) as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') return null;
    const value: unknown = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The same scopes, in any order. */
function sameScopes(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/** `sandbox__tunnel_key`'s answer (`{ publicKey }`): one OpenSSH public key line, else `null`. */
export function publicKeyOf(text: string): string | null {
  let value: unknown;
  try {
    value = (JSON.parse(text) as { publicKey?: unknown } | null)?.publicKey;
  } catch {
    return null;
  }
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key && !/[\r\n]/.test(key) && key.length <= 1024 ? key : null;
}

/** What the assistant is told when civitai would not open the tunnel. */
function refusalMessage(error: unknown): string {
  if (!(error instanceof DevTunnelError))
    return 'The preview could not start. Tell the user it failed and try again later.';
  const known = previewRefusal(error.code);
  if (known) return known;
  if (error.code === 'invalid_grant')
    return 'This reply can no longer act for the user. Tell them to send their message again.';
  if (error.code === 'not_configured')
    return 'The live preview is not set up here. Tell the user, and keep building without it.';
  if (error.code === 'refused')
    return `The preview was refused for this account: ${error.message} Tell the user, and keep building without it.`;
  if (error.code === 'unavailable')
    return 'The preview could not start just now. Call start_preview again in a moment; if it fails again, tell the user.';
  return 'The preview could not start. Tell the user it failed and try again later.';
}

function detail(text: string): string {
  const trimmed = text.trim() || 'no answer.';
  return trimmed.length > DETAIL_CHARS ? `${trimmed.slice(0, DETAIL_CHARS)}…` : trimmed;
}
