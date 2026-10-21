import {
  SANDBOX_SERVER_ID,
  isSandboxServiceUrl,
  openApp,
  type Sandbox,
  type SandboxClient,
} from '@civitai/app-assistant';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';

import type { Logger } from '../interfaces';
import {
  createMcpConnection,
  McpUnreachableError,
  type McpConnection,
  type McpTool,
} from './mcp-connection';

/** How long the sandbox has to start running once it was asked to (the page holds a message as long). */
export const WAKE_TIMEOUT_MS = 3 * 60_000;
/** How often a starting sandbox is looked at while it starts. */
export const WAKE_POLL_MS = 3_000;
/** A sandbox that has not listed its tools by then gives the reply none (the chat's `LIST_TIMEOUT_MS`). */
export const LIST_TIMEOUT_MS = 15_000;
/**
 * Without progress a call may go quiet this long; each progress notification starts the wait again.
 * The chat's `EXTRA_TOOL_TIMEOUT_MS`: a little over the ten minutes a command may take.
 */
export const SANDBOX_TOOL_TIMEOUT_MS = 610_000;
/** A reply is kept to its start and end, as the chat keeps an added server's: errors come last. */
export const RESULT_HEAD_CHARS = 2_000;
export const RESULT_TAIL_CHARS = 6_000;
/** What the assistant is told after a failed call, as the chat tells it of an added server's tool (`tools/extra`). */
const SERVER_TOOL_FAILED_NOTE =
  'This tool failed. Tell the user in plain words; do not call it again this turn unless they ask.';
const LOST_NOTE =
  'Check its effect (for example by listing or reading the files it would change) before running it again.';
/** What the assistant (and the user) reads when the app cannot be found or started again. */
export const SANDBOX_GONE =
  'Your app stopped and could not be started again. Tell the user to open it from the app switcher, then ask again.';

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
  fetch?: typeof fetch;
  wakeTimeoutMs?: number;
  wakePollMs?: number;
}

/**
 * The reply's sandbox: the app open in the page, found (and woken, when it is paused or starting) at
 * the reply's start, and its MCP connection. When a call cannot reach it (the sandbox was paused after
 * 30 idle minutes, or stopped at its 8-hour cap, while the reply only talked to the model), it is found
 * and woken again and the call is made there, once. `close()` closes the connection: a Stop or the
 * reply's end, and the only way a `run_command` still running in the sandbox is reached.
 */
export class AppSandbox {
  readonly #deps: AppSandboxDeps;
  #app: string | null = null;
  #active: Sandbox | null = null;
  #connection: McpConnection | null = null;
  #closed = false;
  /** The sandbox found again for the calls that failed together, so they wake it once. */
  #resolving: Promise<'woken' | 'running' | 'gone'> | null = null;

  constructor(deps: AppSandboxDeps) {
    this.#deps = deps;
  }

  /** The sandbox open now (possibly one `create_app` just opened), or `null`. */
  get active(): Sandbox | null {
    return this.#active;
  }

  /** Whether its tools can be used now: it runs, at an address of the sandbox service. */
  get connected(): boolean {
    return this.#connection !== null;
  }

  /**
   * Finds `app`'s sandbox among `apps` and, when it is not running, wakes it and waits for it to run.
   * Leaves no sandbox open when `app` is none of them or it would not run.
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
    // Kept, closed, so a later call refuses (it is not "unreachable", which would find the new app).
    if (sandbox.app !== this.#app) void this.#connection?.close();
    this.#app = sandbox.app;
    this.#active = sandbox;
  }

  /** Its tools, each named `sandbox__<tool>`; none when it does not run or would not list them in time. */
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
    const tools: ToolSet = {};
    for (const tool of listed) {
      const name = `${SANDBOX_SERVER_ID}__${tool.name}`;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
      // The tunnel only serves the live preview, which is page-only: not offered with nobody watching.
      if (PAGE_ONLY_TOOL.test(tool.name)) continue;
      tools[name] = dynamicTool({
        description: `[your app] ${tool.description ?? ''}`.trim(),
        inputSchema: jsonSchema(objectSchema(tool.inputSchema)),
        execute: (input, { abortSignal }) =>
          this.#call(tool.name, (input ?? {}) as Record<string, unknown>, abortSignal),
      });
    }
    return tools;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = null;
    await connection?.close();
  }

  async #call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let result: CallToolResult;
    try {
      result = await this.#callOnce(tool, args, signal);
    } catch (error) {
      if (signal?.aborted || this.#closed) throw error;
      if (replyLost(error))
        // The call may well have done its work; only its answer is missing.
        return {
          error: `No reply from your app; the ${tool} call may have finished.`,
          retryable: true,
          note: LOST_NOTE,
        };
      if (!refused(error)) throw error;
      // The sandbox may have paused or moved: found again (and woken, if it no longer runs).
      const found = await this.#resolveAgain();
      if (found === 'gone') throw new Error(SANDBOX_GONE);
      // Made again only when it cannot have run: the connection never opened, or the sandbox had to be
      // woken. An error status from a sandbox that still runs (a proxy's 502, a pod restart) may have
      // come after the call ran, so it is reported as maybe finished instead of run twice.
      if (!(error instanceof McpUnreachableError) && found !== 'woken')
        return {
          error: `Your app did not answer the ${tool} call; it may have finished.`,
          retryable: true,
          note: LOST_NOTE,
        };
      result = await this.#callOnce(tool, args, signal);
    }
    const text = keepEnds(resultText(result), RESULT_HEAD_CHARS, RESULT_TAIL_CHARS);
    return result.isError ? { error: text, note: SERVER_TOOL_FAILED_NOTE } : text;
  }

  #callOnce(tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const connection = this.#connection;
    if (!connection) return Promise.reject(new McpUnreachableError(null));
    return connection.callTool(tool, args, {
      ...(signal ? { signal } : {}),
      timeoutMs: SANDBOX_TOOL_TIMEOUT_MS,
    });
  }

  /**
   * Finds the reply's app again and connects to it: `woken` when it had stopped running and was
   * woken, `running` when it still ran, `gone` when it is deleted or would not run. Calls that fail
   * together share one search, so the sandbox is woken once.
   */
  #resolveAgain(): Promise<'woken' | 'running' | 'gone'> {
    this.#resolving ??= (async (): Promise<'woken' | 'running' | 'gone'> => {
      const app = this.#app;
      if (!app || this.#closed) return 'gone';
      const stale = this.#connection;
      this.#connection = null;
      await stale?.close();
      try {
        const listed = await this.#deps.client.list();
        const found = listed.find((sandbox) => sandbox.app === app);
        // Deleted meanwhile: a new, empty one is not made in its place behind the user's back.
        if (!found) return 'gone';
        const woken = found.state !== 'running';
        const running = woken ? await this.#wake(app) : found;
        if (!running || this.#closed) return 'gone';
        this.#active = running;
        this.#connect(running);
        if (!this.#connection) return 'gone';
        return woken ? 'woken' : 'running';
      } catch (error) {
        this.#deps.log.warn(
          { err: (error as Error)?.name, runId: this.#deps.runId },
          'finding the sandbox again failed'
        );
        return 'gone';
      }
    })().finally(() => {
      this.#resolving = null;
    });
    return this.#resolving;
  }

  /** Resumes `app`'s sandbox (pausing another only if the service runs one at a time) and waits for it to run. */
  async #wake(app: string): Promise<Sandbox | null> {
    const { client, signal } = this.#deps;
    try {
      let { sandbox } = await openApp(client, app);
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
        'waking the sandbox failed'
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

/** The sandbox's own tools the runner does not offer: the tunnel, which serves only the page's preview. */
const PAGE_ONLY_TOOL = /^tunnel_/;

/**
 * The connection could not be opened, or the MCP address answered the call with an error status (not
 * an answer of the wrong type, which it did accept).
 */
function refused(error: unknown): boolean {
  return (
    error instanceof McpUnreachableError ||
    (error instanceof StreamableHTTPError && (error.code ?? 0) >= 400)
  );
}

/** The reply never came: the call timed out without progress. */
function replyLost(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

/** As the server defines it; no parameter is the runner's to set. */
function objectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return { ...rest, type: 'object' };
}

/** The result's text, as the chat reads an MCP result (`mcpResultToText`), uncut. */
export function resultText(result: CallToolResult): string {
  return result.content
    .map((block) =>
      block.type === 'text' ? block.text : block.type === 'resource_link' ? `[${block.name}]` : ''
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** The first `head` and last `tail` characters, with how many were left out between them. */
export function keepEnds(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n…(${text.length - head - tail} characters omitted)…\n${text.slice(
    -tail
  )}`;
}

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
