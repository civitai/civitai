import { PREVIEW_NOT_ENABLED, REMOTE_PREVIEW } from '@civitai/app-assistant';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CivitaiDevTunnels,
  DEV_TUNNEL_PATH,
  DevTunnelError,
  type DevTunnels,
  type DevTunnelStartInput,
} from '../app-assistant/dev-tunnel';
import { PREVIEW_KEEPALIVE_MS, publicKeyOf } from '../app-assistant/preview';
import {
  AUTO_PREVIEW_SHOWN,
  AppAssistantTools,
  autoPreviewFailed,
} from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { FAKE_TUNNEL_PUBLIC_KEY, FakeSandboxService } from '../test-support/fake-sandbox';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** The tunnel's id civitai answers with: distinct from every other string here, so a leak shows. */
const SESSION = 'bki_TEST_ONLY_session_7f3e9a';
const HOST = 'dev-0123456789abcdef.civit.ai';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlySishHostKey';
const KEEPALIVE_MS = 1_000;
/** What a run asks civitai to keep alive for the app `my-app` with no manifest: its own key. */
const MY_APP = { blockId: 'my-app' };

/** civitai's dev-tunnel endpoints as one run sees them, recording what it was asked. */
class FakeTunnels implements DevTunnels {
  readonly started: DevTunnelStartInput[] = [];
  readonly kept: { blockId: string }[] = [];
  readonly stopped: string[] = [];
  startError: unknown = null;
  keepaliveError: unknown = null;
  sessions = [SESSION];

  async start(input: DevTunnelStartInput) {
    this.started.push(input);
    if (this.startError) throw this.startError;
    const sessionId = this.sessions[Math.min(this.started.length, this.sessions.length) - 1]!;
    return { sessionId, host: HOST, sshHostPublicKey: HOST_KEY };
  }

  async keepalive(target: { blockId: string }) {
    this.kept.push(target);
    if (this.keepaliveError) throw this.keepaliveError;
  }

  async stop(sessionId: string) {
    this.stopped.push(sessionId);
  }
}

let fake: FakeSandboxService;
let tunnels: FakeTunnels;
let opened: OpenTools[];

beforeEach(async () => {
  fake = new FakeSandboxService();
  await fake.start();
  tunnels = new FakeTunnels();
  opened = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.map((tools) => tools.close()));
  await fake.stop();
});

async function open() {
  const reported: ChatToolResult[] = [];
  const tools = await new AppAssistantTools({
    sandboxUrl: fake.url,
    tokens: () => async (purpose) => `test-token-${purpose}`,
    devTunnels: () => tunnels,
    log: quiet,
    wakePollMs: 5,
    wakeTimeoutMs: 5_000,
    previewKeepaliveMs: KEEPALIVE_MS,
  }).open({
    userId: 'u-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    page: { app: 'my-app' },
    signal: new AbortController().signal,
    report: (result) => reported.push(result),
  });
  opened.push(tools);
  return { tools, reported };
}

let callId = 0;
function call(tools: ToolSet, name: string, input: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`no tool ${name}`);
  return Promise.resolve(
    tool.execute(input as never, { toolCallId: `p-${++callId}`, messages: [] } as never)
  ) as Promise<Record<string, unknown>>;
}

const tunnelCalls = () => fake.calls.filter((c) => c.tool.startsWith('tunnel_')).map((c) => c.tool);

describe('start_preview on the runner', () => {
  it('is offered with stop_preview, and the raw tunnel tools are not', async () => {
    fake.add('my-app');
    const { tools } = await open();
    const names = Object.keys(tools.tools);
    expect(names).toEqual(expect.arrayContaining(['start_preview', 'stop_preview']));
    expect(names.filter((name) => /tunnel/.test(name))).toEqual([]);
    // Control: the sandbox does list them; the runner keeps them to itself.
    expect(names).toContain('sandbox__dev_server_start');
    expect(tools.instructions).toContain(REMOTE_PREVIEW);
  });

  it('takes a key from the sandbox, has civitai open the tunnel, then connects the sandbox to it', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    const result = await call(tools.tools, 'start_preview', {
      declared_scopes: ['models:read'],
      declared_auth: 'block-token',
    });

    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect']);
    expect(tunnels.started).toEqual([
      {
        blockId: 'my-app',
        sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY,
        declaredScopes: ['models:read'],
        declaredAuth: 'block-token',
      },
    ]);
    // The sandbox dials exactly the host civitai named, pinning the host key civitai gave.
    expect(fake.calls.find((c) => c.tool === 'tunnel_connect')!.args).toEqual({
      host: HOST,
      ssh_host_public_key: HOST_KEY,
    });
    expect(result).toEqual({
      shown: true,
      blockId: 'my-app',
      host: HOST,
      next_step: expect.stringContaining('sandbox__preview_check'),
    });
    // What the page is told (journaled as `tool-reported`): the block and the host, for the frame.
    const shown = reported.find((r) => r.name === 'start_preview')!;
    expect(shown).toMatchObject({ isError: false, output: { blockId: 'my-app', host: HOST } });
  });

  it('never puts the tunnel’s id in what the assistant, the journal or the page sees', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    const result = await call(tools.tools, 'start_preview');
    // Control: civitai did hand the runner that id.
    expect(tunnels.started).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SESSION);
    expect(reported.length).toBeGreaterThan(0);
    expect(JSON.stringify(reported)).not.toContain(SESSION);
    // ...and the runner still holds it: stop_preview closes that tunnel.
    await call(tools.tools, 'stop_preview');
    expect(tunnels.stopped).toEqual([SESSION]);
  });

  it.each([
    [403, 'FORBIDDEN', PREVIEW_NOT_ENABLED],
    [404, 'NOT_FOUND', 'That block_id belongs to another app'],
    [429, 'TOO_MANY_REQUESTS', 'Too many previews were started in the last hour'],
    [403, 'refused', 'The preview was refused for this account'],
    [503, 'unavailable', 'The preview could not start just now'],
  ])(
    'a civitai refusal (%i %s) is a tool error saying why, and nothing is connected',
    async (status, code, words) => {
      fake.add('my-app');
      const { tools, reported } = await open();
      tunnels.startError = new DevTunnelError('no', status, code);
      const result = await call(tools.tools, 'start_preview');
      expect(String(result.error)).toContain(words);
      expect(tunnelCalls()).toEqual(['tunnel_key']);
      expect(reported.find((r) => r.name === 'start_preview')).toMatchObject({ isError: true });
    }
  );

  it('a dead grant says to send the message again; an unconfigured runner says there is no preview', async () => {
    fake.add('my-app');
    const { tools } = await open();
    // civitai's own words for it, which are not for the assistant.
    tunnels.startError = new DevTunnelError('Not a current run grant', 401, 'invalid_grant');
    expect(String((await call(tools.tools, 'start_preview')).error)).toBe(
      'This reply can no longer act for the user. Tell them to send their message again.'
    );
    tunnels.startError = new DevTunnelError('x', 503, 'not_configured');
    expect(String((await call(tools.tools, 'start_preview')).error)).toMatch(
      /^The live preview is not set up here/
    );
  });

  it('logs no tunnel id when keeping alive or closing fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const logged: unknown[] = [];
    const log = {
      info: (o: object, m?: string) => void logged.push(o, m),
      warn: (o: object, m?: string) => void logged.push(o, m),
      error: (o: object, m?: string) => void logged.push(o, m),
    };
    const tools = await new AppAssistantTools({
      sandboxUrl: fake.url,
      tokens: () => async (purpose) => `test-token-${purpose}`,
      devTunnels: () => tunnels,
      log,
      previewKeepaliveMs: KEEPALIVE_MS,
    }).open({
      userId: 'u-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      page: { app: 'my-app' },
      signal: new AbortController().signal,
    });
    opened.push(tools);
    await call(tools.tools, 'start_preview');
    tunnels.keepaliveError = new DevTunnelError('later', 503, 'unavailable');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    // Control: the failure was logged.
    expect(logged).toContain('keeping a preview alive failed');
    expect(JSON.stringify(logged)).not.toContain(SESSION);
  });

  it('closes the tunnel civitai opened when the sandbox cannot reach it', async () => {
    fake.add('my-app');
    fake.tools.set('tunnel_connect', () => {
      throw new Error('ssh exited: host key mismatch');
    });
    const { tools } = await open();
    const result = await call(tools.tools, 'start_preview');
    expect(String(result.error)).toMatch(/^The preview could not connect: error: ssh exited/);
    expect(tunnels.stopped).toEqual([SESSION]);
  });

  it('runs two starts of one step one after the other: the second answers the first’s preview', async () => {
    fake.add('my-app');
    const { tools } = await open();
    const results = await Promise.all([
      call(tools.tools, 'start_preview'),
      call(tools.tools, 'start_preview'),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ shown: true });
    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect']);
    expect(tunnels.started).toHaveLength(1);
  });

  it('refuses a block id that is not one, before anything is asked', async () => {
    fake.add('my-app');
    const { tools } = await open();
    const result = await call(tools.tools, 'start_preview', { block_id: 'Not A Block' });
    expect(String(result.error)).toMatch(/^Pass block_id/);
    expect(tunnelCalls()).toEqual([]);
    expect(tunnels.started).toEqual([]);
  });
});

describe('keeping the preview alive', () => {
  it('stamps it on a cadence while the run lives, and stops when the run ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const { tools } = await open();
    await call(tools.tools, 'start_preview');
    expect(tunnels.kept).toEqual([]);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
    // The control: alive while the run lives, named by its block (the run's user's tunnel of it).
    expect(tunnels.kept).toEqual([MY_APP, MY_APP, MY_APP]);

    // The run ends: the runner closes its tools.
    await tools.close();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 10);
    expect(tunnels.kept).toHaveLength(3);
    // Ending the run does not close the tunnel: civitai's idle expiry does that later.
    expect(tunnels.stopped).toEqual([]);
  });

  it('asks again after `unavailable` and after NOT_FOUND (one may open later), and stops once refused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const { tools } = await open();
    await call(tools.tools, 'start_preview');
    tunnels.keepaliveError = new DevTunnelError('later', 503, 'unavailable');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    expect(tunnels.kept).toHaveLength(2);
    tunnels.keepaliveError = new DevTunnelError('gone', 404, 'NOT_FOUND');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    expect(tunnels.kept).toHaveLength(4);
    // The run's own tunnel went: a start of the same preview opens a new one, not the old answer.
    await call(tools.tools, 'start_preview');
    expect(tunnels.started).toHaveLength(2);
    tunnels.keepaliveError = new DevTunnelError('no', 403, 'FORBIDDEN');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 5);
    expect(tunnels.kept).toHaveLength(5);
  });

  // A preview opened outside the run (the page's Restart preview, or an earlier reply) has no id
  // here, and a hidden tab sends its tunnel nothing: the run must keep it up all the same.
  it('keeps alive the app’s preview this run did not open, by the block its manifest names', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    fake.tools.set('dev_server_status', () =>
      JSON.stringify({ running: true, command: 'cd tip-calc && npm run dev' })
    );
    fake.tools.set('read_file', (args) =>
      args.path === 'tip-calc/block.manifest.json'
        ? JSON.stringify({
            path: args.path,
            content: JSON.stringify({ blockId: 'tip-calc-block' }),
          })
        : 'export {}'
    );
    const { tools } = await open();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    // Nothing was opened by this run, and its user's tunnel of that block was kept all the same.
    expect(tunnels.started).toEqual([]);
    expect(tunnels.kept).toEqual([{ blockId: 'tip-calc-block' }, { blockId: 'tip-calc-block' }]);
    await tools.close();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 5);
    expect(tunnels.kept).toHaveLength(2);
  });

  it('with no manifest, keeps the app’s own key’s preview alive', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    await open();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(tunnels.kept).toEqual([MY_APP]);
  });

  it('never keeps another app’s preview alive: once the run opens another app, only that one’s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const { tools } = await open();
    await call(tools.tools, 'start_preview');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    // Control: the first app's preview was kept while it was the open one.
    expect(tunnels.kept).toEqual([MY_APP]);
    expect(await call(tools.tools, 'create_app', { name: 'Tip calculator' })).toMatchObject({
      app: 'tip-calculator',
    });
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    expect(tunnels.kept).toEqual([
      MY_APP,
      { blockId: 'tip-calculator' },
      { blockId: 'tip-calculator' },
    ]);
  });

  it('keeps nothing alive after stop_preview, until the next start', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const { tools } = await open();
    await call(tools.tools, 'stop_preview');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
    expect(tunnels.kept).toEqual([]);
    await call(tools.tools, 'start_preview');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(tunnels.kept).toEqual([MY_APP]);
  });

  it('is every 5 minutes, well inside civitai’s 30-minute idle window', () => {
    expect(PREVIEW_KEEPALIVE_MS).toBe(5 * 60_000);
  });
});

describe('stop_preview on the runner', () => {
  it('closes the run’s tunnel at civitai and in the sandbox, and stops keeping it alive', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const { tools } = await open();
    await call(tools.tools, 'start_preview');
    expect(await call(tools.tools, 'stop_preview')).toEqual({ stopped: true });
    expect(tunnels.stopped).toEqual([SESSION]);
    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect', 'tunnel_disconnect']);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 5);
    expect(tunnels.kept).toEqual([]);
  });

  it('closes the sandbox’s side of a preview an earlier reply started', async () => {
    fake.add('my-app');
    const { tools } = await open();
    expect(await call(tools.tools, 'stop_preview')).toEqual({ stopped: true });
    expect(tunnelCalls()).toEqual(['tunnel_disconnect']);
    expect(tunnels.stopped).toEqual([]);
  });

  it('a second start of another block closes the first one', async () => {
    fake.add('my-app');
    tunnels.sessions = [SESSION, 'bki_TEST_ONLY_second'];
    const { tools } = await open();
    await call(tools.tools, 'start_preview');
    await call(tools.tools, 'start_preview', { block_id: 'other-block' });
    expect(tunnels.stopped).toEqual([SESSION]);
  });
});

describe('publicKeyOf', () => {
  it('reads the one key line sandbox__tunnel_key answers with, and nothing else', () => {
    expect(publicKeyOf(JSON.stringify({ publicKey: ` ${FAKE_TUNNEL_PUBLIC_KEY} ` }))).toBe(
      FAKE_TUNNEL_PUBLIC_KEY
    );
    for (const text of [
      'not json',
      JSON.stringify({}),
      JSON.stringify({ publicKey: 42 }),
      JSON.stringify({ publicKey: 'a\nb' }),
      JSON.stringify({ publicKey: '' }),
    ])
      expect(publicKeyOf(text)).toBeNull();
  });
});

describe('CivitaiDevTunnels', () => {
  const SECRET = 'test-only-runner-secret-0123456789abcdef';
  const GRANT = 'test-only-grant';
  function client(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const sent: { url: string; init: RequestInit }[] = [];
    const tunnels = new CivitaiDevTunnels({
      civitaiUrl: 'https://civitai.example/',
      secret: SECRET,
      log: quiet,
      fetch: async (input, init) => {
        sent.push({ url: String(input), init: init! });
        return answer(String(input), init!);
      },
    });
    return { sent, tunnels };
  }

  it('posts each call with the runner’s secret and the run’s grant, read per call', async () => {
    let grants = 0;
    const { sent, tunnels } = client(() =>
      Response.json({ sessionId: SESSION, host: HOST, sshHostPublicKey: HOST_KEY })
    );
    const run = tunnels.forRun(async () => {
      grants++;
      return GRANT;
    });
    expect(await run.start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY })).toEqual({
      sessionId: SESSION,
      host: HOST,
      sshHostPublicKey: HOST_KEY,
    });
    await run.keepalive({ blockId: 'my-app' });
    await run.stop(SESSION);
    expect(grants).toBe(3);
    expect(sent.map((s) => s.url)).toEqual(
      ['start', 'keepalive', 'stop'].map((a) => `https://civitai.example/${DEV_TUNNEL_PATH}/${a}`)
    );
    for (const { init } of sent)
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(sent.map((s) => JSON.parse(String(s.init.body)))).toEqual([
      { grant: GRANT, blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY },
      { grant: GRANT, blockId: 'my-app' },
      { grant: GRANT, sessionId: SESSION },
    ]);
  });

  it('a refusal keeps civitai’s status and code', async () => {
    const { tunnels } = client(() =>
      Response.json({ error: 'No such dev tunnel', code: 'NOT_FOUND' }, { status: 404 })
    );
    const error = await tunnels
      .forRun(async () => GRANT)
      .keepalive({ blockId: 'my-app' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DevTunnelError);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('a run with no live grant asks civitai nothing', async () => {
    const { sent, tunnels } = client(() => Response.json({}));
    await expect(
      tunnels.forRun(async () => null).keepalive({ blockId: 'my-app' })
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(sent).toEqual([]);
  });

  it('civitai out of reach, or answering a start oddly, is `unavailable`', async () => {
    const down = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.tunnels.forRun(async () => GRANT).stop(SESSION)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
    const odd = client(() => Response.json({ sessionId: SESSION }));
    await expect(
      odd.tunnels.forRun(async () => GRANT).start({ blockId: 'my-app', sshPublicKey: 'k' })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('the preview opens by itself once the dev server starts', () => {
  const DEV_COMMAND =
    'cd my-app && CIVITAI_DEV_TUNNEL_HMR=1 npm run dev -- --host 0.0.0.0 --port 5173';
  const RUNNING = JSON.stringify({ running: true, pid: 42, command: DEV_COMMAND });
  beforeEach(() => {
    fake.tools.set('dev_server_start', () => RUNNING);
  });
  const startDevServer = (tools: ToolSet, command = DEV_COMMAND) =>
    call(tools, 'sandbox__dev_server_start', { command }) as unknown as Promise<unknown>;
  const shownReports = (reported: ChatToolResult[]) =>
    reported.filter((r) => r.name === 'start_preview' && !r.isError);

  it('opens it exactly once, tells the page, and tells the assistant', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    const result = await startDevServer(tools.tools);

    expect(tunnels.started).toHaveLength(1);
    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect']);
    // The page sees it as it sees a start_preview call: the block and the host, never the tunnel id.
    expect(shownReports(reported)).toEqual([
      {
        name: 'start_preview',
        input: {},
        output: { shown: true, blockId: 'my-app', host: HOST, next_step: expect.any(String) },
        isError: false,
      },
    ]);
    expect(JSON.stringify(reported)).not.toContain(SESSION);
    // The assistant reads the dev server's own answer, then that the user now sees the preview.
    expect(result).toBe(`${RUNNING}\n\n${AUTO_PREVIEW_SHOWN}`);
    expect(String(result)).not.toContain(SESSION);
  });

  it('takes the block id, scopes and auth from the project’s manifest', async () => {
    fake.add('my-app');
    // As sandbox-mcp's read_file answers: an envelope with the file's text in `content`.
    fake.tools.set('read_file', (args) =>
      args.path === 'tip-calc/block.manifest.json'
        ? JSON.stringify({
            path: args.path,
            size: 90,
            truncated: false,
            content: JSON.stringify({
              blockId: 'tip-calc',
              scopes: ['models:read:self'],
              auth: 'block-token',
            }),
          })
        : 'export {}'
    );
    const { tools } = await open();
    await startDevServer(tools.tools, DEV_COMMAND.replace('my-app', 'tip-calc'));
    expect(tunnels.started).toEqual([
      {
        blockId: 'tip-calc',
        sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY,
        declaredScopes: ['models:read:self'],
        declaredAuth: 'block-token',
      },
    ]);
  });

  it('a manifest answered as bare text (not read_file’s envelope) is not read: the app’s own key', async () => {
    fake.add('my-app');
    fake.tools.set('read_file', () =>
      JSON.stringify({ blockId: 'other-block', scopes: ['models:read:self'] })
    );
    const { tools } = await open();
    await startDevServer(tools.tools);
    expect(tunnels.started).toEqual([{ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY }]);
  });

  it('a restart opens it too (a later reply finds the dev server still running), once', async () => {
    fake.add('my-app');
    fake.tools.set('dev_server_restart', () => RUNNING);
    const { tools, reported } = await open();
    const result = await call(tools.tools, 'sandbox__dev_server_restart', {});
    expect(result).toBe(`${RUNNING}\n\n${AUTO_PREVIEW_SHOWN}`);
    await startDevServer(tools.tools);
    expect(tunnels.started).toHaveLength(1);
    expect(shownReports(reported)).toHaveLength(1);
  });

  it('a restart with no command reads the manifest where its status says the server runs', async () => {
    fake.add('my-app');
    const restarted = JSON.stringify({
      running: true,
      command: 'cd tip-calc && CIVITAI_DEV_TUNNEL_HMR=1 npm run dev -- --host 0.0.0.0 --port 5173',
    });
    fake.tools.set('dev_server_restart', () => restarted);
    fake.tools.set('read_file', (args) =>
      args.path === 'tip-calc/block.manifest.json'
        ? JSON.stringify({
            path: args.path,
            content: JSON.stringify({ blockId: 'tip-calc', scopes: ['models:read:self'] }),
          })
        : 'export {}'
    );
    const { tools } = await open();
    await call(tools.tools, 'sandbox__dev_server_restart', {});
    expect(tunnels.started).toEqual([
      {
        blockId: 'tip-calc',
        sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY,
        declaredScopes: ['models:read:self'],
      },
    ]);
  });

  it('a start_preview asking for other scopes than it opened with opens it again with them', async () => {
    fake.add('my-app');
    const { tools } = await open();
    await startDevServer(tools.tools);
    await call(tools.tools, 'start_preview', { declared_scopes: ['ai:write:budgeted'] });
    expect(tunnels.started).toHaveLength(2);
    expect(tunnels.started[1]).toMatchObject({ declaredScopes: ['ai:write:budgeted'] });
    // …and asking again for those same scopes opens nothing new.
    await call(tools.tools, 'start_preview', { declared_scopes: ['ai:write:budgeted'] });
    expect(tunnels.started).toHaveLength(2);
  });

  it('opens nothing again on a second dev server start in the same run', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    await startDevServer(tools.tools);
    expect(await startDevServer(tools.tools)).toBe(RUNNING);
    expect(tunnels.started).toHaveLength(1);
    expect(shownReports(reported)).toHaveLength(1);
  });

  it('a refusal never fails the dev server start, is said once, and is not tried again this run', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    tunnels.startError = new DevTunnelError('no', 429, 'TOO_MANY_REQUESTS');
    const result = await startDevServer(tools.tools);
    expect(typeof result).toBe('string');
    expect(result).toBe(
      `${RUNNING}\n\n${autoPreviewFailed(
        'Too many previews were started in the last hour. Tell the user to wait a few minutes.'
      )}`
    );
    expect(reported.find((r) => r.name === 'sandbox__dev_server_start')).toMatchObject({
      isError: false,
    });
    expect(shownReports(reported)).toEqual([]);
    expect(tunnelCalls()).toEqual(['tunnel_key']);
    // Once per run: a second start of the dev server does not ask civitai again.
    tunnels.startError = null;
    expect(await startDevServer(tools.tools)).toBe(RUNNING);
    expect(tunnels.started).toHaveLength(1);
  });

  it('a start_preview after it opens nothing: it answers the same preview', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    await startDevServer(tools.tools);
    const again = await call(tools.tools, 'start_preview');
    expect(again).toEqual(shownReports(reported)[0]!.output);
    expect(tunnels.started).toHaveLength(1);
    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect']);
  });

  it('a preview the assistant opened first is not opened again, nor announced again', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    await call(tools.tools, 'start_preview');
    expect(await startDevServer(tools.tools)).toBe(RUNNING);
    expect(tunnels.started).toHaveLength(1);
    expect(shownReports(reported)).toHaveLength(1);
  });

  it('opens nothing when the dev server did not start', async () => {
    fake.add('my-app');
    const { tools } = await open();
    fake.tools.set('dev_server_start', () => JSON.stringify({ running: false, lastExit: 1 }));
    await startDevServer(tools.tools);
    fake.tools.set('dev_server_start', () => {
      throw new Error('a dev server is already running');
    });
    await startDevServer(tools.tools);
    expect(tunnels.started).toEqual([]);
    expect(tunnelCalls()).toEqual([]);
  });

  it('keeps the opened preview alive while the run lives, and stops at its end', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const { tools } = await open();
    await startDevServer(tools.tools);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    expect(tunnels.kept).toEqual([MY_APP, MY_APP]);
    await tools.close();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 5);
    expect(tunnels.kept).toHaveLength(2);
  });

  it('opens nothing by itself where the preview is not set up', async () => {
    fake.add('my-app');
    const tools = await new AppAssistantTools({
      sandboxUrl: fake.url,
      tokens: () => async (purpose) => `test-token-${purpose}`,
      log: quiet,
    }).open({
      userId: 'u-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      page: { app: 'my-app' },
      signal: new AbortController().signal,
    });
    opened.push(tools);
    expect(await startDevServer(tools.tools)).toBe(RUNNING);
    expect(tunnelCalls()).toEqual([]);
  });
});
