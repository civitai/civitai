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

import type { Logger } from '../core/interfaces';
import { DevTunnelError, type DevTunnels, type PreviewOpenAnswer } from './dev-tunnel';
import { npmInstallRunningProbe, runNpmInstall } from './npm-install';

/**
 * How often a live run stamps its app's tunnel's idle clock. civitai reaps a tunnel 30 minutes
 * after its last activity (`DEV_TUNNEL_IDLE_SECONDS`); every 5 minutes leaves five more chances inside that
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
 * Restart is one request whose grant must still cover the tunnel's start after this
 * (`TUNNEL_START_BUDGET_MS`), behind up to `RESTART_WAIT_MS` of waiting for a starting app and, for
 * a project whose dependencies are not installed, its install (`NPM_INSTALL_TIMEOUT_MS`), so this
 * is kept short.
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
      signal?: AbortSignal,
      /** `timeoutMs`: how long to wait for its answer (`AppSandbox.call`'s own default unless set). */
      options?: { timeoutMs?: number }
    ): Promise<{ text: string; isError: boolean }>;
    /**
     * The open app's current preview id (`AppSandbox.previewId`), and a new one
     * (`AppSandbox.rotatePreviewId`). Without them, or without an id, every preview is a dev tunnel.
     */
    previewId?(): Promise<string | null>;
    rotatePreviewId?(): Promise<string>;
  };
  /** civitai's dev-tunnel endpoints, with this run's grant. */
  tunnels: DevTunnels;
  log: Logger;
  runId: string;
  keepaliveMs?: number;
  /** `startDevServer`'s wait for the dev server to listen (`DEV_SERVER_WAIT_MS`), and its step. */
  devServerWaitMs?: number;
  devServerPollMs?: number;
  /**
   * The last moment (epoch ms) a tunnel start may begin: past it, a start asks civitai nothing and
   * fails as a grant that ran out (`invalid_grant`). Set by the page's Restart preview, whose grant
   * must still be good for every call the start makes after it (`TUNNEL_START_BUDGET_MS`).
   */
  tunnelStartBy?: number;
}

/** The preview this run opened: kept in this process's memory only, never in a result. */
interface OpenPreview {
  /**
   * `tunnel`: a dev tunnel the sandbox dials. `direct`: civitai's preview session, served by the
   * sandbox service with no tunnel (civitai's `preview/open`), kept and closed by its block id.
   */
  transport: 'tunnel' | 'direct';
  sessionId: string;
  /** The sandbox it serves: another app opened by `create_app` is another preview. */
  app: string;
  blockId: string;
  /** A tunnel's host; `null` for a direct preview, whose session host the runner never keeps. */
  host: string | null;
  /** What it was opened with: a start asking for other scopes or auth opens it again. */
  declaredScopes: string[];
  declaredAuth: 'block-token' | 'oauth' | undefined;
  /**
   * Whether the preview certainly has those scopes and auth. A tunnel start always writes a new
   * session; a direct open may answer a session already open for the app's preview id (an earlier
   * reply's, the page's Restart preview's), which keeps the scopes it was opened with. So a direct
   * one is known only when the open wrote it: after a rotated preview id, or after this run ended
   * the session before it (`#openDirect` does so for every start that declares scopes or auth).
   */
  scopesKnown: boolean;
  /** What the start that opened it answered: a start of the same preview answers it again. */
  result: StartedPreview;
}

/**
 * What a start answers (and the page reads `blockId` and `host` of): never the tunnel's id. A
 * direct preview's answer has no `host`: its session host is itself the credential that loads the
 * preview, so it never reaches the assistant, the journal or the saved conversation; the page gets
 * the frame from civitai by `blockId`.
 */
export interface StartedPreview {
  shown: true;
  blockId: string;
  host?: string;
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
 * conversation see) is the block id (and a tunnel's host), never the tunnel's id.
 *
 * Direct preview (civitai's `app-assistant-direct-preview` flag): each start first asks civitai's
 * `preview/open` with the app's sandbox's preview id. When civitai answers with a session, the
 * sandbox service serves the preview itself and no tunnel step is taken; that preview is kept
 * alive and closed by its block id, and its answer carries no host. Otherwise (`tunnel`, the flag
 * off) it is the dev tunnel, as before.
 *
 * While the run lives (`keepWhileRunning`) the open app's preview is kept from idling out
 * (`PREVIEW_KEEPALIVE_MS`), whoever opened it: this run, an earlier one, or the page's Restart
 * preview (a tunnel as long as the app's sandbox is connected to it). `close()`, as the run
 * ends, stops that and leaves the tunnel to civitai's normal idle expiry, so the user can keep
 * looking at it for a while after the reply ends.
 */
export class RunnerPreview {
  readonly #deps: RunnerPreviewDeps;
  #open: OpenPreview | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #keeping = false;
  /** Set by `keepWhileRunning`: a run's preview (never a run-less restart's) is kept alive. */
  #keepCurrent = false;
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

  /**
   * For a run: from now until `close()`, keeps the open app's preview from idling out, whoever
   * opened it (`#keepTarget`): a tunnel by the host the app's sandbox is connected to
   * (`tunnel_status`), a direct preview by its block id. Never another app's (it is not that app's
   * sandbox), never another user's (civitai checks the owner), and never a tunnel the sandbox has
   * let go (paused, disconnected), which civitai then lets idle out. Paused by `stop_preview` (the
   * user asked for it to go) until the next start.
   */
  keepWhileRunning(): void {
    if (this.#closed) return;
    this.#keepCurrent = true;
    this.#keepAlive();
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

  /**
   * The block id the open app's preview runs under, which its calls and errors are kept by: the one
   * this run started for it, else the `blockId` in its project's manifest (what a start uses, and
   * what a preview an earlier run or the page's Restart preview opened ran under), else the app's
   * key (a start's own default). It can differ from the key: the assistant picks another blockId
   * when the key's is taken. `null` when no app is open.
   */
  async previewBlockId(signal?: AbortSignal): Promise<string | null> {
    const app = this.#deps.sandbox.active;
    if (!app) return null;
    const open = this.#open;
    if (open && open.app === app.name) return open.blockId;
    try {
      const dir = await this.#projectDir(app.app, await this.#devServerStatus(signal), signal);
      const blockId = dir ? (await this.#manifest(dir, signal)).block_id : undefined;
      if (typeof blockId === 'string' && isAppBlockId(blockId)) return blockId;
    } catch {
      // The sandbox did not answer: the app's own key.
    }
    return app.app;
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
   * `block.manifest.json`. A project whose dependencies are not installed (an app whose files were
   * seeded: woken from hibernation, remixed; or one whose last install was cut off) gets
   * `npm install` first, bounded by `NPM_INSTALL_TIMEOUT_MS`, as the assistant is told to before it
   * starts one; else `npm run dev` finds no `vite` and exits 127. Installed means npm's own record of
   * a finished install, `node_modules/.package-lock.json`, which npm (7 and later) writes last: a
   * `node_modules` alone may be what a killed install left. One that is installed is never installed
   * into, and none is installed while another npm install runs in the sandbox (the assistant's own,
   * in a reply): two in one directory break its tree. Throws `DevServerStartError`, saying what
   * failed, when it does not run (`installing`: another install runs, or the sandbox would not say
   * whether one does; `install-failed`: ours did not exit 0, or did not answer).
   */
  startDevServer(signal?: AbortSignal): Promise<void> {
    return this.#serial(async () => {
      const app = this.#deps.sandbox.active;
      if (this.#closed || !app || app.state !== 'running') throw new DevServerNotRunningError();
      const status = await this.#devServerStatus(signal);
      if (status?.running !== true) {
        const dir = await this.#projectDir(app.app, status, signal);
        if (!dir) throw new DevServerStartError('no-project');
        if (!(await this.#installed(dir, signal))) {
          if (await this.#installRunning(signal)) throw new DevServerStartError('installing');
          await this.#install(dir, signal);
        }
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

  /**
   * Whether the project's dependencies are installed: `node_modules/.package-lock.json` exists,
   * which npm writes last in a finished install. Only `test -f`'s own exit 0 says so: a check that
   * failed otherwise (a tool error, no answer) reads as not installed, so it installs (when no other
   * install runs). An install over installed dependencies is npm finding little to do; skipping one
   * that was needed is the dev server's exit 127. (An npm older than 7 writes no such file, so every
   * start would install; the sandbox's npm is newer.)
   */
  async #installed(dir: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const probe = await this.#deps.sandbox.call(
        'run_command',
        { command: `test -f ${dir}/node_modules/.package-lock.json`, timeout_ms: PROBE_TIMEOUT_MS },
        signal
      );
      return !probe.isError && exitCodeOf(probe.text) === 0;
    } catch {
      return false;
    }
  }

  /**
   * Whether an npm install runs anywhere in the sandbox now (`npmInstallRunningProbe`). Only its own
   * `idle` says none does: a check that failed (a tool error, no answer, another output) reads as one
   * running, so nothing is installed. A second install beside a running one breaks the project's
   * tree, which is worse than asking the user to try again.
   */
  async #installRunning(signal?: AbortSignal): Promise<boolean> {
    try {
      const probe = await this.#deps.sandbox.call(
        'run_command',
        { command: npmInstallRunningProbe(), timeout_ms: PROBE_TIMEOUT_MS },
        signal
      );
      return !(
        !probe.isError &&
        exitCodeOf(probe.text) === 0 &&
        outputOf(probe.text).trim() === 'idle'
      );
    } catch {
      return true;
    }
  }

  /**
   * `cd <dir> && npm install` (`runNpmInstall`: bounded in the sandbox by `NPM_INSTALL_TIMEOUT_MS`,
   * which kills it past that, and waited for that long plus `CALL_SLACK_MS`). Throws
   * `install-failed` unless it exited 0. It runs inside the start's turn of `#serial`, so a
   * `start_preview` meanwhile waits.
   *
   * Known trade-off: the page's request may time out upstream while a first install still runs. The runner goes on all the same: the install finishes (or is killed at
   * its bound), and the next click finds the dependencies installed and installs nothing (or, while
   * that install still runs, is told it is still installing).
   */
  async #install(dir: string, signal?: AbortSignal): Promise<void> {
    let installed: { text: string; isError: boolean };
    try {
      installed = await runNpmInstall(this.#deps.sandbox, dir, signal);
    } catch {
      throw new DevServerStartError('install-failed');
    }
    if (installed.isError || exitCodeOf(installed.text) !== 0)
      throw new DevServerStartError('install-failed');
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
    // Another block id, or other scopes or auth than it was opened with (or than a direct preview
    // may have, `scopesKnown`), is a new start.
    const open = this.#open;
    if (
      open &&
      open.app === app.name &&
      (typeof input.block_id !== 'string' || input.block_id === open.blockId) &&
      (declaredScopes === undefined ||
        (open.scopesKnown && sameScopes(declaredScopes, open.declaredScopes))) &&
      (declaredAuth === undefined || (open.scopesKnown && declaredAuth === open.declaredAuth))
    )
      return open.result;
    const blockId = typeof input.block_id === 'string' ? input.block_id : app.app;
    if (!isAppBlockId(blockId))
      throw new Error(
        'Pass block_id: 3-40 characters, lowercase letters, digits and dashes, starting with a letter.'
      );

    // 0. A direct preview, when civitai opens one for this user: no tunnel at all.
    const direct = await this.#openDirect(app.name, blockId, declaredScopes, declaredAuth, signal);
    if (direct) return direct;

    // 1. A fresh single-use key, made in the sandbox: only its public half leaves it.
    const key = await sandbox.call('tunnel_key', {}, signal);
    const publicKey = key.isError ? null : publicKeyOf(key.text);
    if (!publicKey)
      throw new Error(`The preview could not start: ${detail(key.text)} Call start_preview again.`);

    // Too late for a start this grant can still see through (the connect, or the close): civitai is
    // asked nothing, so nothing is opened. (The key made above is the sandbox's alone, single-use.)
    if (this.#deps.tunnelStartBy !== undefined && Date.now() > this.#deps.tunnelStartBy) {
      const expired = new DevTunnelError(
        'This preview grant runs out before the preview could open.',
        401,
        'invalid_grant'
      );
      throw new Error(refusalMessage(expired), { cause: expired });
    }

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
    if (previous && previous.blockId !== blockId) await this.#closeOpen(previous);
    const result = shownResult(blockId, started.host);
    this.#open = {
      transport: 'tunnel',
      sessionId: started.sessionId,
      app: app.name,
      blockId,
      host: started.host,
      declaredScopes: declaredScopes ?? [],
      declaredAuth,
      scopesKnown: true,
      result,
    };
    if (this.#keepCurrent) this.#keepAlive();
    return result;
  }

  /**
   * The direct preview of `blockId` (served by the sandbox service, with no tunnel), when civitai's
   * `preview/open` opens one for this user; `null` when it says to open a dev tunnel, or when the
   * app's sandbox has no preview id to open it under.
   *
   * civitai answers a session already open for the app's preview id as it is (scopes included),
   * writes one for an id never used, and answers `fresh` for an id whose session has ended (a
   * resumed app, a stopped preview): then the id is rotated once and asked again, which civitai
   * always writes; a second `fresh` is an error, never a loop. So it takes at most two opens.
   */
  async #openDirect(
    appName: string,
    blockId: string,
    declaredScopes: string[] | undefined,
    declaredAuth: 'block-token' | 'oauth' | undefined,
    signal?: AbortSignal
  ): Promise<StartedPreview | null> {
    const { sandbox, tunnels } = this.#deps;
    if (!sandbox.previewId || !sandbox.rotatePreviewId) return null;
    const previous = this.#open;

    let previewId: string | null;
    try {
      previewId = await sandbox.previewId();
    } catch (error) {
      // The sandbox service would not say: the dev tunnel, as before direct previews.
      this.#warn(error, 'reading the preview id failed');
      return null;
    }
    if (!previewId) return null;

    // An open session keeps the scopes it was opened with, so a start that declares scopes or auth
    // ends the app's direct session first (`stopBlock` leaves tunnels alone). A failed stop only
    // matters if civitai then answers `direct`: with the flag off it must not fail a tunnel start.
    const sameBlock =
      previous?.transport === 'direct' && previous.app === appName && previous.blockId === blockId;
    const declares = (declaredScopes?.length ?? 0) > 0 || declaredAuth !== undefined;
    let ended = false;
    let stopError: unknown;
    if (sameBlock || declares) {
      try {
        await tunnels.stopBlock(blockId, signal);
        if (sameBlock) this.#open = null;
        ended = true;
      } catch (error) {
        if (signal?.aborted) throw error;
        stopError = error;
        this.#warn(error, 'ending a direct preview before opening it failed');
      }
    }

    const ask = (id: string) =>
      tunnels.open(
        {
          blockId,
          previewId: id,
          ...(declaredScopes ? { declaredScopes } : {}),
          ...(declaredAuth ? { declaredAuth } : {}),
        },
        signal,
        // A start with a deadline (the page's Restart preview, `tunnelStartBy`) asks once: retries
        // could use up the time its tunnel fallback needs.
        this.#deps.tunnelStartBy !== undefined ? { once: true } : undefined
      );
    let answer: PreviewOpenAnswer | null;
    let rotated = false;
    try {
      answer = await this.#askOrFallBack(() => ask(previewId), signal);
      if (answer?.mode === 'direct' && 'fresh' in answer) {
        let next: string;
        try {
          next = await sandbox.rotatePreviewId();
        } catch (error) {
          this.#warn(error, 'rotating the preview id failed');
          throw new DevTunnelError('The preview id could not be renewed.', 503, 'unavailable');
        }
        rotated = true;
        answer = await this.#askOrFallBack(() => ask(next), signal);
        if (answer?.mode === 'direct' && 'fresh' in answer) {
          const twice = new DevTunnelError(
            'A new preview id was answered as used.',
            503,
            'unavailable'
          );
          this.#warn(twice, 'civitai answered a rotated preview id as used');
          throw twice;
        }
      }
    } catch (error) {
      throw new Error(refusalMessage(error), { cause: error });
    }
    if (!answer || answer.mode === 'tunnel' || 'fresh' in answer) {
      // The dev tunnel (the flag went off mid-run, or civitai could not be asked) while this run's
      // direct preview of the block is still open (its stop failed above): close it once more
      // before the tunnel replaces it here.
      if (sameBlock && stopError !== undefined && previous) await this.#closeOpen(previous, signal);
      return null;
    }
    // The stop failed and civitai answered a session it did not write after a fresh id: it may be
    // the old one, with the old scopes. Fail as the stop did, rather than show it as current.
    if (stopError !== undefined && !rotated)
      throw new Error(refusalMessage(stopError), { cause: stopError });
    if (sandbox.active?.name !== appName || this.#closed) {
      // As a tunnel start closes what it opened: the session is the old app's, which nothing shows.
      await tunnels
        .stopBlock(blockId, signal)
        .catch((error) => this.#warn(error, 'closing a preview failed'));
      throw new Error(
        'Your app changed while the preview was starting. Start the preview again in the open app.'
      );
    }

    if (previous && previous.blockId !== blockId) await this.#closeOpen(previous);
    // No host: the session host is the preview's credential (see `StartedPreview`).
    const result = shownResult(blockId);
    this.#open = {
      transport: 'direct',
      sessionId: answer.sessionId,
      app: appName,
      blockId,
      host: null,
      declaredScopes: declaredScopes ?? [],
      declaredAuth,
      scopesKnown: rotated || ended,
      result,
    };
    if (this.#keepCurrent) this.#keepAlive();
    return result;
  }

  /**
   * One `preview/open`, or `null` (the dev tunnel) when it failed without refusing: every start
   * asks it first, so with the flag off a civitai hiccup on it (out of reach, a 5xx, `unavailable`
   * after its retries, an odd answer) must not cost the tunnel start. A refusal from civitai's
   * gates (a 4xx with a code) is thrown: the tunnel start would refuse the same. So is an abort.
   */
  async #askOrFallBack(
    ask: () => Promise<PreviewOpenAnswer>,
    signal?: AbortSignal
  ): Promise<PreviewOpenAnswer | null> {
    try {
      return await ask();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DevTunnelError && error.status < 500 && error.code !== undefined)
        throw error;
      this.#warn(error, 'asking civitai how to open the preview failed; opening a tunnel');
      return null;
    }
  }

  /** Closes a preview this run opened: a tunnel by its id, a direct one by its block. */
  async #closeOpen(open: OpenPreview, signal?: AbortSignal): Promise<void> {
    const { tunnels } = this.#deps;
    await (open.transport === 'direct'
      ? tunnels.stopBlock(open.blockId, signal)
      : tunnels.stop(open.sessionId, signal)
    ).catch((error) => this.#warn(error, 'closing a preview failed'));
  }

  async #stop(signal?: AbortSignal) {
    const { sandbox, tunnels } = this.#deps;
    const open = this.#open;
    this.#open = null;
    this.#stopKeeping();
    // A direct preview has no sandbox side: civitai ends it by its block (and a session already
    // gone is stopped too).
    if (open?.transport === 'direct') {
      const asked = await tunnels.stopBlock(open.blockId, signal).then(
        () => true,
        (error) => {
          this.#warn(error, 'closing a preview failed');
          return false;
        }
      );
      return { stopped: asked };
    }
    if (open) await this.#closeOpen(open, signal);
    // A preview an earlier reply started has no id here: closing the sandbox's side ends a tunnel,
    // and civitai's side idles out.
    let disconnected = false;
    let tunnelStopped = false;
    if (sandbox.active?.state === 'running') {
      const result = await sandbox
        .call('tunnel_disconnect', {}, signal)
        .catch(() => ({ text: '', isError: true }));
      disconnected = !result.isError;
      tunnelStopped =
        !result.isError &&
        (parseJson(result.text) as { stopped?: unknown } | null)?.stopped === true;
    }
    // No tunnel ran in the sandbox: the preview an earlier reply (or the page's Restart preview)
    // opened may be a direct one, which only civitai can end: by the app's block, as it ran under
    // (which can differ from the app's key), whichever run opened it.
    let ended = false;
    if (!open && !tunnelStopped) {
      const blockId = await this.previewBlockId(signal);
      if (blockId)
        ended = await tunnels.stopBlock(blockId, signal).catch((error) => {
          this.#warn(error, 'closing a preview failed');
          return false;
        });
    }
    return { stopped: Boolean(open) || disconnected || ended };
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
    if (this.#closed || this.#keeping) return;
    this.#keeping = true;
    let target: { host: string } | { blockId: string } | null = null;
    try {
      target = await this.#keepTarget();
      // Ended, or stopped (`stop_preview`), while the sandbox was asked.
      if (!target || this.#closed || !this.#timer) return;
      await this.#deps.tunnels.keepalive(target);
    } catch (error) {
      if (error instanceof DevTunnelError && error.status === 404) {
        // civitai has no preview of the user's there (it went, at its cap or stopped): one may
        // open later (the page's Restart preview), so the next tick looks again. One this run
        // opened there is gone, so a start of the same preview opens a new one.
        const open = this.#open;
        if (
          open &&
          target &&
          ('host' in target
            ? open.transport === 'tunnel' && open.host === target.host
            : open.transport === 'direct' && open.blockId === target.blockId)
        )
          this.#open = null;
        return;
      }
      // Refused (a gate, the dev-tunnel flag) or the grant is no longer good: nothing to keep alive
      // for this run. `unavailable`, and a sandbox that would not answer, are asked again next tick.
      if (error instanceof DevTunnelError && error.code !== 'unavailable') this.#stopKeeping();
      this.#warn(error, 'keeping a preview alive failed');
    } finally {
      this.#keeping = false;
    }
  }

  /**
   * What a tick keeps alive, while the open app's sandbox runs (else `null`): this run's direct
   * preview of that app, by its block id (which can differ from the app's key); else the host the
   * sandbox has a tunnel running to (`tunnel_status`); else the app's direct preview by
   * `previewBlockId()`, whichever run opened it (an earlier reply's, the page's Restart preview's).
   * That last is asked for direct sessions only (`DevTunnels.keepalive`), so a tunnel the sandbox
   * has let go is never kept: civitai answers it as none, and it idles out as before.
   */
  async #keepTarget(): Promise<{ host: string } | { blockId: string } | null> {
    const app = this.#deps.sandbox.active;
    if (!app || app.state !== 'running') return null;
    const open = this.#open;
    if (open?.transport === 'direct' && open.app === app.name) return { blockId: open.blockId };
    const host = await this.#connectedHost(app.name);
    if (host) return { host };
    const blockId = await this.previewBlockId();
    // Another app opened meanwhile: its preview is looked at the next tick.
    return blockId && this.#deps.sandbox.active?.name === app.name ? { blockId } : null;
  }

  /** The host app `appName`'s sandbox has a tunnel running to (`tunnel_status`), else `null`. */
  async #connectedHost(appName: string): Promise<string | null> {
    const status = await this.#deps.sandbox.call('tunnel_status', {});
    // Another app opened meanwhile: its sandbox is asked at the next tick.
    if (status.isError || this.#deps.sandbox.active?.name !== appName) return null;
    const { running, host } = (parseJson(status.text) ?? {}) as {
      running?: unknown;
      host?: unknown;
    };
    return running === true && typeof host === 'string' && host ? host : null;
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
 * Starting the dev server failed: `no-project` (which project to start was not clear),
 * `installing` (its dependencies are not installed, and another npm install runs in the sandbox, or
 * the sandbox would not say; nothing was installed or started), `install-failed` (its dependencies
 * were not installed, and `npm install` did not exit 0 or did not answer; nothing was started),
 * `refused` (the sandbox would not start it), `exited` (it stopped as soon as it started; `exitCode`
 * is its code), or `timeout` (it never listened in time).
 */
export class DevServerStartError extends Error {
  override name = 'DevServerStartError';
  readonly exitCode: number | null;
  constructor(
    readonly reason:
      | 'no-project'
      | 'installing'
      | 'install-failed'
      | 'refused'
      | 'exited'
      | 'timeout',
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
export function exitCodeOf(text: string): number | null {
  const match = /^exit_code: (-?\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** `sandbox__run_command`'s output: what follows its header's `---` line. */
export function outputOf(text: string): string {
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

/** What a start answers once the preview of `blockId` is open (a tunnel's at `host`). */
function shownResult(blockId: string, host?: string): StartedPreview {
  return {
    shown: true,
    blockId,
    ...(host ? { host } : {}),
    next_step: 'The user sees the preview now. To see what they see, call sandbox__preview_check.',
  };
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
