import {
  SANDBOX_SERVER_ID,
  isSandboxServiceUrl,
  openApp,
  type Sandbox,
  type SandboxClient,
} from '@civitai/app-assistant';
import {
  createMcpConnection,
  extraToolSet,
  McpConnectionClosedError,
  mcpResultToText,
  namespacedToolName,
  type ChatMcpServer,
  type McpConnection,
  type McpTool,
} from '@civitai/components-chat/core';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolSet } from 'ai';

import type { Logger } from '../core/interfaces';

/** How long the sandbox has to start running once it was asked to (the page holds a message as long). */
export const WAKE_TIMEOUT_MS = 3 * 60_000;
/** How often a starting sandbox is looked at while it starts. */
export const WAKE_POLL_MS = 3_000;
/** A sandbox that has not listed its tools by then gives the reply none (the chat's `LIST_TIMEOUT_MS`). */
export const LIST_TIMEOUT_MS = 15_000;
/** What the assistant is told about a call it should check before making again (the chat's `LOST_NOTE`). */
const LOST_NOTE =
  'Check its effect (for example by listing or reading the files it would change) before running it again.';
/** The sandbox server as the page names it, so its tools read the same: `sandbox__<tool>`, "[your app] …". */
const SANDBOX_SERVER = { id: SANDBOX_SERVER_ID, label: 'your app' } as const;
/** What the assistant (and the user) reads when the app is gone. */
export const SANDBOX_GONE =
  'Your app is gone: it was deleted while the assistant worked. Tell the user to open or create it from the app switcher, then ask again.';
/** How a reply ends when the user opened another app, which paused this one: Continue picks it up. */
export const PAUSED_BY_OTHER_APP =
  'Paused: you opened another app. Continue here to start this one again and pick up where it left off.';
/** How a reply ends when its app paused by itself (30 idle minutes, or its 8-hour cap). */
export const PAUSED_IDLE =
  'Paused: your app went to sleep while the assistant worked. Continue to start it again and pick up where it left off.';

/** The app the page named is gone (deleted, or made again empty): the reply ends with this. */
export class AppGoneError extends Error {
  override name = 'AppGoneError';
  constructor() {
    super(SANDBOX_GONE);
  }
}

export interface AppSandboxDeps {
  client: SandboxClient;
  /** The sandbox service's base URL: an MCP address on another origin never gets the user's token. */
  baseUrl: string;
  /** A `sandbox` token for the MCP server, minted per request. */
  token: () => Promise<string>;
  /** Aborted when the run stops or ends. */
  signal: AbortSignal;
  log: Logger;
  runId: string;
  /** Ends the reply now, as interrupted (Continue carries on from its saved steps), with these words. */
  endReply?(message: string): void;
  fetch?: typeof fetch;
  wakeTimeoutMs?: number;
  wakePollMs?: number;
}

/**
 * The reply's sandbox: the app open in the page, found (and woken, when it is paused or starting) as
 * the reply starts, and its MCP connection. That is the only wake. A call refused later (its sandbox
 * paused: the user opened another app, or it slept after 30 idle minutes or its 8-hour cap) is never
 * made again and never wakes it, which would pause the app the user is on: the reply ends as
 * interrupted with words saying why, and Continue picks it up. `close()` closes the connection: a
 * Stop or the reply's end, and the only way a `run_command` still running in the sandbox is reached.
 */
export class AppSandbox {
  readonly #deps: AppSandboxDeps;
  #app: string | null = null;
  #active: Sandbox | null = null;
  #connection: McpConnection | null = null;
  #closed = false;
  /** The one look at the user's apps after a refused call, shared by the calls refused together. */
  #checking: Promise<'gone' | 'paused' | 'running' | 'starting'> | null = null;

  constructor(deps: AppSandboxDeps) {
    this.#deps = deps;
  }

  /** The sandbox open now (possibly one `create_app` just opened), or `null`. */
  get active(): Sandbox | null {
    return this.#active;
  }

  /**
   * Finds `app`'s sandbox among `apps` and, when it is not running, wakes it and waits for it to run
   * (what the page does before it sends a message). Opens nothing when `app` is none of them. Throws
   * `AppGoneError` when waking it made a new, empty app instead (it was deleted meanwhile).
   */
  async open(app: string | null, apps: Sandbox[]): Promise<void> {
    this.#app = app;
    const found = app ? apps.find((sandbox) => sandbox.app === app) ?? null : null;
    this.#active = found;
    if (!found) return;
    const running = found.state === 'running' ? found : await this.#wake(found.app);
    this.#active = running ?? found;
    if (running) this.#connect(running);
  }

  /**
   * A sandbox `create_app` opened: it becomes the reply's open app; its tools come with the next reply.
   * The connection to the app open before is closed, as the page drops it: a call still made to it
   * fails rather than being sent on to the new app.
   */
  opened(sandbox: Sandbox): void {
    if (sandbox.app !== this.#app) void this.#connection?.close();
    this.#app = sandbox.app;
    this.#active = sandbox;
  }

  /**
   * Its tools, each named `sandbox__<tool>` and given the chat's own treatment of an added server's
   * tools (`extraToolSet`: the reply's first and last characters, 610 s without progress, a lost
   * reply reported as maybe finished); none when it does not run or would not list them in time.
   */
  async tools(): Promise<ToolSet> {
    const connection = this.#connection;
    if (!connection) return {};
    let listed: McpTool[];
    try {
      listed = await withTimeout(connection.listTools(), LIST_TIMEOUT_MS);
    } catch (error) {
      this.#deps.log.warn(
        { err: (error as Error)?.name, runId: this.#deps.runId },
        'the sandbox did not list its tools; the reply goes without them'
      );
      return {};
    }
    const server: ChatMcpServer = {
      ...SANDBOX_SERVER,
      url: connection.url,
      token: this.#deps.token,
    };
    const named = listed
      // The tunnel is the runner's to drive, inside `start_preview` and `stop_preview` (`preview.ts`):
      // the assistant never gets it, so it cannot point the sandbox at a host civitai did not open.
      .filter((tool) => !RUNNER_ONLY_TOOL.test(tool.name))
      .map((tool) => ({ name: namespacedToolName(SANDBOX_SERVER_ID, tool.name), tool }))
      .filter(({ name }) => /^[A-Za-z0-9_-]{1,64}$/.test(name));
    const tools = extraToolSet([{ server, connection, tools: named }], { taken: {} });
    for (const [name, tool] of Object.entries(tools)) {
      const execute = tool.execute!;
      tools[name] = {
        ...tool,
        execute: async (input: unknown, options: { abortSignal?: AbortSignal }) => {
          try {
            return await (execute as (input: unknown, options: unknown) => Promise<unknown>)(
              input,
              options
            );
          } catch (error) {
            return this.#refused(name, error, options.abortSignal);
          }
        },
      } as typeof tool;
    }
    return tools;
  }

  /**
   * Calls one of the sandbox's own tools for the runner itself (the tunnel's, for the preview), never
   * for the assistant: its text, and whether the tool said it failed. Throws when the app has no
   * connection (it is not running, or `create_app` opened another one meanwhile) or the call fails.
   */
  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    /** `timeoutMs`: how long to wait for its answer (`RUNNER_CALL_TIMEOUT_MS` unless set). */
    options: { timeoutMs?: number } = {}
  ): Promise<{ text: string; isError: boolean }> {
    const connection = this.#connection;
    if (!connection || this.#closed) throw new Error('Your app is not running.');
    const result = await connection.callTool(tool, args, {
      ...(signal ? { signal } : {}),
      timeoutMs: options.timeoutMs ?? RUNNER_CALL_TIMEOUT_MS,
    });
    return { text: mcpResultToText(result, Infinity), isError: result.isError === true };
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = null;
    await connection?.close();
  }

  /**
   * A call that failed outright (not a lost reply, which the chat's wrapper already reports as maybe
   * finished): one look at the user's apps decides. It is never made again here.
   */
  async #refused(tool: string, error: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted || this.#closed || error instanceof McpConnectionClosedError) throw error;
    const state = await this.#check();
    if (state === 'gone') throw new AppGoneError();
    if (state === 'paused')
      return {
        error: `Your app was paused, so the ${tool} call may not have finished.`,
        retryable: true,
        note: LOST_NOTE,
      };
    if (state === 'starting')
      return {
        error: `Your app is starting again, so the ${tool} call may have finished or may not have run.`,
        retryable: true,
        note: LOST_NOTE,
      };
    // Still running: an error status (a proxy's 502, a pod restart) may have come after it ran.
    if (error instanceof StreamableHTTPError && (error.code ?? 0) >= 400)
      return {
        error: `Your app did not answer the ${tool} call; it may have finished.`,
        retryable: true,
        note: LOST_NOTE,
      };
    throw error;
  }

  /**
   * After a refused call, one look at the user's apps (shared by the calls refused together): the app
   * is gone, still running (the refusal was a proxy's or a restart's), or paused. A paused app ends the
   * reply as interrupted, saying whether the user opened another app; it is never woken from here.
   */
  #check(): Promise<'gone' | 'paused' | 'running' | 'starting'> {
    this.#checking ??= (async (): Promise<'gone' | 'paused' | 'running' | 'starting'> => {
      const app = this.#app;
      if (!app) return 'gone';
      let listed: Sandbox[];
      try {
        listed = await this.#deps.client.list();
      } catch (error) {
        this.#deps.log.warn(
          { err: (error as Error)?.name, runId: this.#deps.runId },
          'looking at the user’s apps after a refused call failed'
        );
        return 'running';
      }
      const found = listed.find((sandbox) => sandbox.app === app);
      if (!found) return 'gone';
      // Starting (a pod restart, or the user opening it again): neither asleep nor paused for another
      // app, and the call may have run before the restart; reported as maybe finished, as a running
      // app's error status is, and the reply goes on.
      if (found.state !== 'suspended') return found.state === 'starting' ? 'starting' : 'running';
      this.#active = found;
      const other = listed.some((sandbox) => sandbox.app !== app && sandbox.state !== 'suspended');
      this.#deps.endReply?.(other ? PAUSED_BY_OTHER_APP : PAUSED_IDLE);
      return 'paused';
    })().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  /**
   * Resumes `app`'s sandbox (pausing another only if the service runs one at a time) and waits for it
   * to run; `null` when it would not run in time. Only as the reply starts.
   */
  async #wake(app: string): Promise<Sandbox | null> {
    const { client, signal } = this.#deps;
    let opened: { sandbox: Sandbox; created: boolean };
    try {
      opened = await openApp(client, app);
    } catch (error) {
      this.#deps.log.warn(
        { err: (error as Error)?.name, runId: this.#deps.runId },
        'waking the sandbox failed'
      );
      return null;
    }
    // Deleted after the page listed it: the service made a new, empty one. Nothing runs on it.
    if (opened.created) throw new AppGoneError();
    let { sandbox } = opened;
    try {
      const deadline = Date.now() + (this.#deps.wakeTimeoutMs ?? WAKE_TIMEOUT_MS);
      while (sandbox.state !== 'running') {
        if (signal.aborted || this.#closed || Date.now() >= deadline) return null;
        await sleep(this.#deps.wakePollMs ?? WAKE_POLL_MS, signal);
        sandbox = await client.get(sandbox.name);
      }
      return sandbox;
    } catch (error) {
      this.#deps.log.warn(
        { err: (error as Error)?.name, runId: this.#deps.runId },
        'waiting for the sandbox to start failed'
      );
      return null;
    }
  }

  #connect(sandbox: Sandbox): void {
    if (this.#closed) return;
    // The user's token goes only to the configured sandbox service, whatever address a response names.
    if (!isSandboxServiceUrl(sandbox.mcpUrl, this.#deps.baseUrl)) {
      this.#deps.log.warn(
        { runId: this.#deps.runId },
        'the sandbox named an MCP address outside the sandbox service; its tools are left out'
      );
      return;
    }
    this.#connection = createMcpConnection({
      url: sandbox.mcpUrl,
      token: this.#deps.token,
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
    });
  }
}

/** The sandbox's own tools the runner keeps to itself: the tunnel, which only `start_preview` drives. */
const RUNNER_ONLY_TOOL = /^tunnel_/;
/** A tunnel call waits up to 20 s for sish (`tunnel_connect`); this bounds one the runner makes. */
export const RUNNER_CALL_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
