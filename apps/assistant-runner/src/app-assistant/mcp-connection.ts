import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

/** A call on a connection the reply closed (a Stop, or the reply ended). */
export class McpClosedError extends Error {
  override name = 'McpClosedError';
  constructor() {
    super('The connection to your app was closed.');
  }
}

/**
 * The connection could not be opened (or was refused before a call reached the tool): the call did
 * not run, so the sandbox may be found again and the call made there.
 */
export class McpUnreachableError extends Error {
  override name = 'McpUnreachableError';
  constructor(readonly cause: unknown) {
    super('Your app could not be reached.');
  }
}

export interface McpConnection {
  readonly url: string;
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions
  ): Promise<CallToolResult>;
  /** Ends every request in flight (what reaches a `run_command` still running); every call after it is refused. */
  close(): Promise<void>;
}

/**
 * The runner's Streamable HTTP client for one MCP server, as the chat's `createMcpConnection` is the
 * browser's: a bearer token asked for on every request (`token`, minted inside the request), a session
 * opened on first use and opened again once when the server forgot it (404/400 after a restart), and
 * `close()` closing the transport, which aborts every request it has in flight.
 */
export function createMcpConnection({
  url,
  token,
  fetch: doFetch = fetch,
}: {
  url: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}): McpConnection {
  const endpoint = new URL(url);
  let pending: Promise<Client> | null = null;
  let transport: StreamableHTTPClientTransport | null = null;
  let closed = false;

  // Every request passes here: one check refuses them all once closed, and each gets a fresh token.
  const signedFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (closed) throw new McpClosedError();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${await token()}`);
    return doFetch(input, { ...init, headers });
  };

  const connect = (): Promise<Client> => {
    pending ??= (async () => {
      const client = new Client({ name: 'assistant-runner', version: '0.1.0' });
      transport = new StreamableHTTPClientTransport(endpoint, { fetch: signedFetch });
      try {
        await client.connect(transport);
      } catch (error) {
        if (closed) throw new McpClosedError();
        throw new McpUnreachableError(error);
      }
      return client;
    })().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };

  const reset = async () => {
    const stale = pending;
    pending = null;
    await stale?.then((client) => client.close()).catch(() => undefined);
  };

  /** Opens a new session once when the server says it has none (it restarted); a closed one is never reopened. */
  const withClient = async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
    try {
      return await fn(await connect());
    } catch (error) {
      if (closed) throw new McpClosedError();
      if (!(error instanceof StreamableHTTPError) || (error.code !== 404 && error.code !== 400))
        throw error;
      await reset();
      return fn(await connect());
    }
  };

  return {
    url: endpoint.toString(),
    listTools: () =>
      withClient(async (client) => {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(...(page.tools as McpTool[]));
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      }),
    callTool: (name, args, { signal, timeoutMs }) =>
      withClient(
        async (client) =>
          (await client.callTool({ name, arguments: args }, undefined, {
            signal,
            timeout: timeoutMs,
            // Asking for progress is what makes the server send it, and each one restarts the timeout.
            resetTimeoutOnProgress: true,
            onprogress: () => undefined,
          })) as CallToolResult
      ),
    close: async () => {
      closed = true;
      pending = null;
      const current = transport;
      transport = null;
      await current?.close().catch(() => undefined);
    },
  };
}
