import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/** A sandbox as the fake service keeps it; `mcpUrl` is set from the server's address. */
export interface FakeSandboxRecord {
  name: string;
  app: string;
  state: 'starting' | 'running' | 'suspended';
  mcpUrl?: string;
  createdAt: string;
  lastActivityAt: string | null;
  expiresAt: string | null;
}

/** What a fake tool does with a call. */
export type FakeToolBody = (
  args: Record<string, unknown>,
  signal: AbortSignal,
  /** The sandbox (its name) the call was made in; a body that wraps another may leave it out. */
  sandbox?: string
) => Promise<string> | string;

/** The public half of the single-use key the fake sandbox's `tunnel_key` makes (TEST-ONLY, not a real key). */
export const FAKE_TUNNEL_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyNotARealKey sandbox-dev-tunnel';

/** The tools a hosted sandbox lists (as App Assistant's prompt names them). */
const TOOLS: { name: string; description: string }[] = [
  'read_file',
  'list_dir',
  'write_file',
  'edit_file',
  'delete_path',
  'run_command',
  'preview_check',
  'dev_server_start',
  'dev_server_restart',
  'dev_server_stop',
  'dev_server_status',
  'dev_server_logs',
  'tunnel_key',
  'tunnel_connect',
  'tunnel_status',
  'tunnel_disconnect',
].map((name) => ({ name, description: `The sandbox's ${name}.` }));

/**
 * The hosted sandbox service and each sandbox's MCP server, in one local HTTP server, for tests. No
 * real sandbox and no real token: it records the `Authorization` it was sent and answers as the
 * service does (`/v1/sandboxes`, `/mcp/<name>`).
 */
export class FakeSandboxService {
  readonly sandboxes: FakeSandboxRecord[] = [];
  /** Every request: method, path and the bearer it carried. */
  readonly requests: { method: string; path: string; authorization: string | undefined }[] = [];
  /** Each MCP tool call that reached a tool: the sandbox, the tool and its arguments. */
  readonly calls: { sandbox: string; tool: string; args: Record<string, unknown> }[] = [];
  /** MCP tool calls whose connection the client closed before the answer went. */
  readonly abandoned: string[] = [];
  /** The next N `tools/call` requests are answered 503, as a paused sandbox's address is. */
  failCalls = 0;
  /**
   * MCP `initialize` is accepted and never answered (until the client hangs up), as a sandbox that
   * listens but is wedged: the connect every tool call waits on never completes.
   */
  hangInitialize = false;
  /** How many looks at a starting sandbox it takes to run. */
  startsAfter = 1;
  /** Apps deleted just before their next open: the open then makes a new, empty one (201). */
  readonly deleteBeforeOpen = new Set<string>();
  /** How many apps the user may keep: a create past it is refused 409, as the service's cap is. */
  keepLimit = Infinity;
  readonly tools = new Map<string, FakeToolBody>();
  /** The host each sandbox's tunnel runs to (by sandbox name), as `tunnel_status` reports it. */
  readonly tunnelHosts = new Map<string, string>();
  /** Tools this sandbox does not list, as an older sandbox image without them. */
  readonly hiddenTools = new Set<string>();
  #server: HttpServer | undefined;
  #base = '';
  #looks = new Map<string, number>();

  constructor() {
    this.tools.set('read_file', () => 'export {}');
    this.tools.set('list_dir', () => 'src/');
    this.tools.set('write_file', (args) => `wrote ${String(args.content ?? '').length} bytes`);
    this.tools.set('preview_check', () => 'render: ok\npage_errors: 0');
    this.tools.set('dev_server_logs', () => 'ready');
    // As sandbox-mcp answers them: JSON text.
    this.tools.set('tunnel_key', () =>
      JSON.stringify({ publicKey: FAKE_TUNNEL_PUBLIC_KEY, stoppedTunnel: false })
    );
    this.tools.set('tunnel_connect', (args, _signal, sandbox) => {
      this.tunnelHosts.set(String(sandbox), String(args.host));
      return JSON.stringify({ running: true, host: args.host, localPort: 5173 });
    });
    this.tools.set('tunnel_disconnect', (_args, _signal, sandbox) => {
      this.tunnelHosts.delete(String(sandbox));
      return JSON.stringify({ stopped: true });
    });
    this.tools.set('tunnel_status', (_args, _signal, sandbox) => {
      const host = this.tunnelHosts.get(String(sandbox));
      return JSON.stringify(host ? { running: true, host } : { running: false, host: null });
    });
    this.tools.set('run_command', async (args, signal) => {
      if (args.command === 'hang')
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      return `exit_code: 0\ntimed_out: false\n---\nran ${String(args.command)}`;
    });
  }

  get url(): string {
    return this.#base;
  }

  /** Adds a sandbox for `app`, as one the user made earlier. */
  add(app: string, state: FakeSandboxRecord['state'] = 'running'): FakeSandboxRecord {
    const record: FakeSandboxRecord = {
      name: `sb-${app}-${this.sandboxes.length + 1}`,
      app,
      state,
      createdAt: new Date().toISOString(),
      lastActivityAt: null,
      expiresAt: null,
    };
    this.sandboxes.push(record);
    return record;
  }

  /** Deletes `app`'s sandbox, as the user can from another tab. */
  remove(app: string): void {
    const index = this.sandboxes.findIndex((s) => s.app === app);
    if (index >= 0) this.sandboxes.splice(index, 1);
  }

  /** The user opens `app` elsewhere: it runs, and every other app is paused (one runs at a time). */
  userOpens(app: string): FakeSandboxRecord {
    for (const sandbox of this.sandboxes) if (sandbox.app !== app) sandbox.state = 'suspended';
    const found = this.sandboxes.find((s) => s.app === app) ?? this.add(app);
    found.state = 'running';
    return found;
  }

  callsTo(tool: string): number {
    return this.calls.filter((call) => call.tool === tool).length;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    const address = this.#server.address();
    this.#base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  #view(record: FakeSandboxRecord) {
    return { ...record, mcpUrl: record.mcpUrl ?? `${this.#base}/mcp/${record.name}` };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.#base);
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname, authorization: req.headers.authorization });
    const body = method === 'POST' ? await readBody(req) : undefined;
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };

    if (url.pathname === '/v1/sandboxes' && method === 'GET')
      return json(200, { sandboxes: this.sandboxes.map((s) => this.#view(s)) });
    if (url.pathname === '/v1/sandboxes' && method === 'POST') {
      const app = String((body as { app?: unknown } | undefined)?.app ?? '');
      if (this.deleteBeforeOpen.delete(app)) this.remove(app);
      const found = this.sandboxes.find((s) => s.app === app);
      if (found) {
        if (found.state === 'suspended') found.state = 'starting';
        return json(200, this.#view(found));
      }
      if (this.sandboxes.length >= this.keepLimit)
        return json(409, { error: `sandbox limit (${this.keepLimit}) reached; delete one first` });
      return json(201, this.#view(this.add(app, 'starting')));
    }
    const item = /^\/v1\/sandboxes\/([a-z0-9-]+)(\/suspend)?$/.exec(url.pathname);
    if (item) {
      const record = this.sandboxes.find((s) => s.name === item[1]);
      if (!record) return json(404, { error: 'not found' });
      if (item[2]) record.state = 'suspended';
      else if (record.state === 'starting') {
        const looks = (this.#looks.get(record.name) ?? 0) + 1;
        this.#looks.set(record.name, looks);
        if (looks >= this.startsAfter) record.state = 'running';
      }
      return json(200, this.#view(record));
    }
    const mcp = /^\/mcp\/([a-z0-9-]+)$/.exec(url.pathname);
    if (mcp) {
      const record = this.sandboxes.find((s) => s.name === mcp[1]);
      if (!record || record.state !== 'running') return json(503, { error: 'not running' });
      const message = body as { method?: string; id?: unknown } | undefined;
      if (message?.method === 'initialize' && this.hangInitialize) {
        await new Promise<void>((resolve) => res.on('close', () => resolve()));
        return;
      }
      if (message?.method === 'tools/call' && this.failCalls > 0) {
        this.failCalls--;
        return json(503, { error: 'not running' });
      }
      const closed = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          if (message?.method === 'tools/call') this.abandoned.push(String(message.id));
          closed.abort();
        }
      });
      const server = this.#mcpServer(record.name, closed.signal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    json(404, { error: 'not found' });
  }

  #mcpServer(sandbox: string, closed: AbortSignal): Server {
    const server = new Server(
      { name: 'fake-sandbox', version: '0.0.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.filter((tool) => !this.hiddenTools.has(tool.name)).map((tool) => ({
        ...tool,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      })),
    }));
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        this.calls.push({ sandbox, tool: request.params.name, args });
        const body = this.tools.get(request.params.name);
        if (!body) return { content: [{ type: 'text', text: 'no such tool' }], isError: true };
        const signal = AbortSignal.any([closed, extra.signal]);
        // A body that throws fails as sandbox-mcp's tools fail: an error result, never a thrown call.
        try {
          return { content: [{ type: 'text', text: await body(args, signal, sandbox) }] };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `error: ${(error as Error)?.message ?? error}` }],
            isError: true,
          };
        }
      }
    );
    return server;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}
