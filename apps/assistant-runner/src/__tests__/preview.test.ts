import { PREVIEW_NOT_ENABLED, REMOTE_PREVIEW } from '@civitai/app-assistant';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CivitaiDevTunnels,
  DEV_TUNNEL_PATH,
  DevTunnelError,
  OPEN_ATTEMPTS,
  PREVIEW_OPEN_PATH,
  type DevTunnels,
  type DevTunnelStartInput,
  type PreviewOpenAnswer,
  type PreviewOpenInput,
} from '../app-assistant/dev-tunnel';
import { PREVIEW_KEEPALIVE_MS, publicKeyOf } from '../app-assistant/preview';
import {
  AUTO_PREVIEW_SHOWN,
  AppAssistantTools,
  autoPreviewFailed,
} from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FAKE_TUNNEL_PUBLIC_KEY, FakeSandboxService } from '../test-support/fake-sandbox';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** The tunnel's id civitai answers with: distinct from every other string here, so a leak shows. */
const SESSION = 'bki_TEST_ONLY_session_7f3e9a';
const HOST = 'dev-0123456789abcdef.civit.ai';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlySishHostKey';
const KEEPALIVE_MS = 1_000;
/** What a run asks civitai to keep alive once the sandbox is connected to civitai's tunnel. */
const CONNECTED = { host: HOST };
/** Another host, as the page's Restart preview (no run) may have connected the sandbox to. */
const RESTARTED_HOST = 'dev-fedcba9876543210.civit.ai';

/** A direct preview session's host, as civitai mints one (TEST-ONLY: not a real label or zone). */
const directHost = (n: number) => `s${String(n).padStart(61, '0')}.preview.example`;

/**
 * civitai's dev-tunnel endpoints as one run sees them, recording what it was asked. Its
 * `preview/open` answers `tunnel` (direct preview off) unless `direct` is set; then it answers as
 * civitai's does: an open session for that preview id is reused as it is (its scopes kept), an id
 * never used gets a new session, and a used id whose session ended gets `fresh`.
 */
class FakeTunnels implements DevTunnels {
  readonly started: DevTunnelStartInput[] = [];
  readonly kept: ({ host: string } | { blockId: string })[] = [];
  readonly stopped: string[] = [];
  readonly opens: PreviewOpenInput[] = [];
  readonly blockStops: string[] = [];
  startError: unknown = null;
  keepaliveError: unknown = null;
  sessions = [SESSION];
  direct = false;
  /** civitai's direct sessions, by block id (one per user and block), and the ids ever used. */
  readonly directSessions = new Map<
    string,
    { previewId: string; sessionId: string; host: string; declaredScopes: string[] }
  >();
  readonly usedIds = new Set<string>();
  /** Every `preview/open` answers `fresh`, whatever the id: a broken civitai. */
  alwaysFresh = false;

  async start(input: DevTunnelStartInput) {
    this.started.push(input);
    if (this.startError) throw this.startError;
    const sessionId = this.sessions[Math.min(this.started.length, this.sessions.length) - 1]!;
    return { sessionId, host: HOST, sshHostPublicKey: HOST_KEY };
  }

  async open(input: PreviewOpenInput): Promise<PreviewOpenAnswer> {
    this.opens.push(input);
    if (!this.direct) return { mode: 'tunnel' };
    if (this.alwaysFresh) return { mode: 'direct', fresh: true };
    const open = this.directSessions.get(input.blockId);
    if (open?.previewId === input.previewId)
      return { mode: 'direct', sessionId: open.sessionId, host: open.host };
    if (this.usedIds.has(input.previewId)) return { mode: 'direct', fresh: true };
    this.usedIds.add(input.previewId);
    const n = this.opens.length;
    const written = {
      previewId: input.previewId,
      sessionId: `bki_TEST_ONLY_direct_${n}`,
      host: directHost(n),
      declaredScopes: input.declaredScopes ?? [],
    };
    this.directSessions.set(input.blockId, written);
    return { mode: 'direct', sessionId: written.sessionId, host: written.host };
  }

  /**
   * civitai's tunnel records by block id (the flag-off path): a by-block keepalive or stop is for
   * direct sessions only, so it never keeps or ends one of these.
   */
  readonly tunnelBlocks = new Set<string>();
  /** By-block keepalives civitai answered 404 (no direct session for the block), by block id. */
  readonly blockMisses: string[] = [];

  async keepalive(target: { host: string } | { blockId: string }) {
    if ('blockId' in target && !this.directSessions.has(target.blockId)) {
      this.blockMisses.push(target.blockId);
      throw new DevTunnelError('No such dev tunnel', 404, 'NOT_FOUND');
    }
    this.kept.push(target);
    if (this.keepaliveError) throw this.keepaliveError;
  }

  async stop(sessionId: string) {
    this.stopped.push(sessionId);
  }

  async stopBlock(blockId: string) {
    this.blockStops.push(blockId);
    return this.directSessions.delete(blockId);
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
    // A chat that chose the open app: its dev server starts are not refused.
    history: chosenApp('my-app'),
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

/** The tunnel steps taken (`tunnel_status` is only a read, made on every keep-alive tick). */
const tunnelCalls = () =>
  fake.calls
    .filter((c) => c.tool.startsWith('tunnel_') && c.tool !== 'tunnel_status')
    .map((c) => c.tool);
/** The sandbox the fake made for `app`. */
const sandboxOf = (app: string) => fake.sandboxes.find((s) => s.app === app)!.name;

/**
 * Runs `n` keep-alive ticks, each to the point where it has asked the sandbox (`tunnel_status`,
 * over real HTTP, which fake timers do not advance). A tick still in flight makes the next one
 * skip, so each is driven until its own ask is seen; a later tick's ask therefore also means every
 * earlier tick finished. What a tick then keeps is awaited with `vi.waitFor` by the caller.
 */
async function ticks(n = 1) {
  for (let i = 0; i < n; i++) {
    const before = fake.callsTo('tunnel_status');
    for (let tries = 0; fake.callsTo('tunnel_status') === before; tries++) {
      if (tries > 200) throw new Error('no keep-alive tick asked the sandbox');
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
      if (fake.callsTo('tunnel_status') === before) await new Promise((r) => setTimeout(r, 10));
    }
  }
}
/** Waits for exactly `expected` to have been kept (ticks finish over real HTTP). */
const keptToBe = (expected: unknown[]) => vi.waitFor(() => expect(tunnels.kept).toEqual(expected));

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
    await ticks(1);
    // Control: the failure was logged.
    await vi.waitFor(() => expect(logged).toContain('keeping a preview alive failed'));
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

    await ticks(3);
    // The control: alive while the run lives, named by the host the sandbox is connected to.
    await keptToBe([CONNECTED, CONNECTED, CONNECTED]);

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
    await ticks(2);
    await keptToBe([CONNECTED, CONNECTED]);
    tunnels.keepaliveError = new DevTunnelError('gone', 404, 'NOT_FOUND');
    await ticks(2);
    await keptToBe([CONNECTED, CONNECTED, CONNECTED, CONNECTED]);
    // The run's own tunnel went: a start of the same preview opens a new one, not the old answer.
    await call(tools.tools, 'start_preview');
    expect(tunnels.started).toHaveLength(2);
    tunnels.keepaliveError = new DevTunnelError('no', 403, 'FORBIDDEN');
    await ticks(1);
    await vi.waitFor(() => expect(tunnels.kept).toHaveLength(5));
    // Refused: no tick asks again.
    const asked = fake.callsTo('tunnel_status');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 5);
    expect(fake.callsTo('tunnel_status')).toBe(asked);
    expect(tunnels.kept).toHaveLength(5);
  });

  // A preview opened outside the run (the page's Restart preview, or an earlier reply) has no id
  // here, and a hidden tab sends its tunnel nothing: the run must keep it up all the same.
  it('keeps alive the preview the app’s sandbox is connected to though this run did not open it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    fake.tunnelHosts.set(sandboxOf('my-app'), RESTARTED_HOST);
    const { tools } = await open();
    await ticks(2);
    // Nothing was opened by this run, and the tunnel its sandbox serves was kept all the same.
    await keptToBe([{ host: RESTARTED_HOST }, { host: RESTARTED_HOST }]);
    expect(tunnels.started).toEqual([]);
    await tools.close();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 5);
    expect(tunnels.kept).toHaveLength(2);
  });

  it('keeps nothing alive while the app’s sandbox has no tunnel running (paused, disconnected)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    await open();
    await ticks(3);
    // Control: once the sandbox is connected, the next tick keeps it — and only it, so none of
    // the three before (each finished before it asked) kept anything.
    fake.tunnelHosts.set(sandboxOf('my-app'), RESTARTED_HOST);
    await ticks(1);
    await keptToBe([{ host: RESTARTED_HOST }]);
  });

  it('never keeps another app’s preview alive: once the run opens another app, only that one’s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    const { tools } = await open();
    await call(tools.tools, 'start_preview');
    // Control: the first app's preview is kept while it is the open one.
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
      expect(tunnels.kept).toContainEqual(CONNECTED);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const keptBefore = tunnels.kept.length;
    expect(await call(tools.tools, 'create_app', { name: 'Tip calculator' })).toMatchObject({
      app: 'tip-calculator',
    });
    // The first app's tunnel is no longer the open app's: it is left to idle out. (The new app's
    // sandbox answers this run nothing — its tools come with the next reply — so nothing is kept.)
    fake.tunnelHosts.set(sandboxOf('tip-calculator'), RESTARTED_HOST);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(tunnels.kept).toHaveLength(keptBefore);
    expect(tunnels.kept.every((kept) => 'host' in kept && kept.host === HOST)).toBe(true);
  });

  it('keeps nothing alive after stop_preview, until the next start', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fake.add('my-app');
    fake.tunnelHosts.set(sandboxOf('my-app'), RESTARTED_HOST);
    const { tools } = await open();
    await call(tools.tools, 'stop_preview');
    // Even were the sandbox's side still up (its disconnect failed): the user asked for it to go.
    fake.tunnelHosts.set(sandboxOf('my-app'), RESTARTED_HOST);
    const asked = fake.callsTo('tunnel_status');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
    expect(fake.callsTo('tunnel_status')).toBe(asked);
    expect(tunnels.kept).toEqual([]);
    await call(tools.tools, 'start_preview');
    await ticks(1);
    await keptToBe([CONNECTED]);
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
    await run.keepalive({ host: HOST });
    await run.stop(SESSION);
    expect(grants).toBe(3);
    expect(sent.map((s) => s.url)).toEqual(
      ['start', 'keepalive', 'stop'].map((a) => `https://civitai.example/${DEV_TUNNEL_PATH}/${a}`)
    );
    for (const { init } of sent)
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(sent.map((s) => JSON.parse(String(s.init.body)))).toEqual([
      {
        grant: GRANT,
        blockId: 'my-app',
        sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY,
        clientKey: expect.any(String),
      },
      { grant: GRANT, host: HOST },
      { grant: GRANT, sessionId: SESSION },
    ]);
  });

  it('a refusal keeps civitai’s status and code', async () => {
    const { tunnels } = client(() =>
      Response.json({ error: 'No such dev tunnel', code: 'NOT_FOUND' }, { status: 404 })
    );
    const error = await tunnels
      .forRun(async () => GRANT)
      .keepalive({ host: HOST })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DevTunnelError);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  describe('a start the runner gives up on is closed at civitai by its own key', () => {
    /** civitai holds every start until the call is aborted, and answers a stop. */
    function holding() {
      return client((url, init) =>
        url.endsWith('/start')
          ? new Promise<Response>((_, reject) => {
              const signal = init.signal as AbortSignal;
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            })
          : Response.json({ stopped: false })
      );
    }
    const bodies = (sent: { init: RequestInit }[]) =>
      sent.map((s) => JSON.parse(String(s.init.body)) as Record<string, unknown>);

    it('the caller cancels (a Stop, the reply ending): a stop by the start’s key, with its grant', async () => {
      const { sent, tunnels } = holding();
      // The reply's grant is deleted as it ends: the cleanup still carries the start's own.
      let grant: string | null = GRANT;
      const run = tunnels.forRun(async () => grant);
      const caller = new AbortController();
      const start = run
        .start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY }, caller.signal)
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      grant = null;
      caller.abort();
      // The caller's own abort, as before: the cleanup does not change what the caller hears.
      expect(await start).toBe(caller.signal.reason);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      const [started, stopped] = bodies(sent);
      expect(sent[1]!.url).toBe(`https://civitai.example/${DEV_TUNNEL_PATH}/stop`);
      expect(typeof started!.clientKey).toBe('string');
      expect(started!.clientKey).not.toBe('');
      expect(stopped).toEqual({ grant: GRANT, clientKey: started!.clientKey });
    });

    it('civitai failed the start (5xx, or out of reach): stopped by its key; a refusal is not', async () => {
      for (const [answer, stops] of [
        [() => Response.json({ error: 'later', code: 'unavailable' }, { status: 503 }), 1],
        [
          () => {
            throw new TypeError('fetch failed');
          },
          1,
        ],
        [() => Response.json({ error: 'No such app', code: 'NOT_FOUND' }, { status: 404 }), 0],
        [() => Response.json({ error: 'Too many', code: 'TOO_MANY_REQUESTS' }, { status: 429 }), 0],
      ] as const) {
        const { sent, tunnels } = client((url) =>
          url.endsWith('/start') ? answer() : Response.json({ stopped: false })
        );
        const run = tunnels.forRun(async () => GRANT);
        await run
          .start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY })
          .catch(() => undefined);
        // A call made after the start failed: a cleanup the start began is already on its way
        // ahead of it, so what reached civitai before this marker is all the start sent.
        await run.keepalive({ host: HOST });
        expect(
          sent.map((s) => s.url.split('/').pop()),
          String(answer)
        ).toEqual(stops ? ['start', 'stop', 'keepalive'] : ['start', 'keepalive']);
        const stopsSent = sent.filter((s) => s.url.endsWith('/stop'));
        if (stops)
          expect(JSON.parse(String(stopsSent[0]!.init.body))).toEqual({
            grant: GRANT,
            clientKey: JSON.parse(String(sent[0]!.init.body)).clientKey,
          });
      }
    });

    it('a start that succeeded is not stopped, and each start has its own key', async () => {
      const { sent, tunnels } = client(() =>
        Response.json({ sessionId: SESSION, host: HOST, sshHostPublicKey: HOST_KEY })
      );
      const run = tunnels.forRun(async () => GRANT);
      await run.start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY });
      await run.start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY });
      // The marker, as above: no stop went ahead of it.
      await run.keepalive({ host: HOST });
      expect(sent.map((s) => s.url.split('/').pop())).toEqual(['start', 'start', 'keepalive']);
      const [a, b] = bodies(sent);
      expect(a!.clientKey).not.toBe(b!.clientKey);
    });
  });

  it('a run with no live grant asks civitai nothing', async () => {
    const { sent, tunnels } = client(() => Response.json({}));
    await expect(tunnels.forRun(async () => null).keepalive({ host: HOST })).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(sent).toEqual([]);
  });

  describe('how long a call waits for civitai', () => {
    // `AbortSignal.timeout` runs on Node's own timers, which fake timers do not reach: each one
    // is swapped for an abort on the faked `setTimeout`, so the virtual clock drives the deadline.
    let deadlines: number[];
    beforeEach(() => {
      vi.useFakeTimers();
      deadlines = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        deadlines.push(ms);
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
        return controller.signal;
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    /** civitai answers each call after `ms`, or never; an aborted call fails as fetch does. */
    function answeringAfter(ms: number | null, answer: () => Response) {
      return client(
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            const signal = init.signal as AbortSignal;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            if (ms !== null) setTimeout(() => resolve(answer()), ms);
          })
      );
    }
    const started = () =>
      Response.json({ sessionId: SESSION, host: HOST, sshHostPublicKey: HOST_KEY });

    it('a start civitai answers 185 s in (its route takes up to 180 s) is still the start', async () => {
      // civitai's start waits for the tunnel's route to be applied (up to 180 s) before it answers,
      // and keeps the tunnel it opened. A runner that gives up sooner never connects the sandbox to
      // a tunnel civitai then lists as live: the page shows it, and it can only fail to load.
      const { tunnels } = answeringAfter(185_000, started);
      const start = tunnels
        .forRun(async () => GRANT)
        .start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
      await vi.advanceTimersByTimeAsync(185_000);
      expect(await start).toEqual({
        value: { sessionId: SESSION, host: HOST, sshHostPublicKey: HOST_KEY },
      });
      // The control: the call did run on a deadline this test drives.
      expect(deadlines).toHaveLength(1);
    });

    it('a start civitai never answers still fails, as `unavailable`', async () => {
      const { tunnels } = answeringAfter(null, started);
      const start = tunnels
        .forRun(async () => GRANT)
        .start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(await start).toMatchObject({ status: 503, code: 'unavailable' });
    });

    it('a start that timed out at 200 s (civitai answers by 185 s) is stopped by its key', async () => {
      const { sent, tunnels } = answeringAfter(null, started);
      const start = tunnels
        .forRun(async () => GRANT)
        .start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(199_000);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await start).toMatchObject({ status: 503, code: 'unavailable' });
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      expect(sent.map((s) => s.url.split('/').pop())).toEqual(['start', 'stop']);
      expect(JSON.parse(String(sent[1]!.init.body))).toEqual({
        grant: GRANT,
        clientKey: JSON.parse(String(sent[0]!.init.body)).clientKey,
      });
      // The stop waits on a stop's own 15 s, not on the start's 200 s.
      expect(deadlines).toEqual([200_000, 15_000]);
    });

    describe('the stop by key, when civitai says to ask again', () => {
      /** The start fails on civitai's side; each stop answers the next of `stops`, in turn. */
      function failingStart(stops: (() => Response)[]) {
        let next = 0;
        return client((url) =>
          url.endsWith('/start')
            ? Response.json({ error: 'later', code: 'unavailable' }, { status: 503 })
            : (stops[Math.min(next++, stops.length - 1)] ?? (() => Response.json({})))()
        );
      }
      const unavailable = () =>
        Response.json({ error: 'later', code: 'unavailable' }, { status: 503 });
      const stopped = () => Response.json({ stopped: true });
      async function startAndWait(tunnels: CivitaiDevTunnels) {
        await tunnels
          .forRun(async () => GRANT)
          .start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY })
          .catch(() => undefined);
        // Long past any retry the runner makes: what was sent by then is all it sends.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      }
      const stopsOf = (sent: { url: string; init: RequestInit }[]) =>
        sent.filter((s) => s.url.endsWith('/stop'));

      it('a stop civitai answers `unavailable` is asked again, with the same key, until it is done', async () => {
        const { sent, tunnels } = failingStart([unavailable, unavailable, stopped]);
        await startAndWait(tunnels);
        const stops = stopsOf(sent);
        expect(stops).toHaveLength(3);
        const key = JSON.parse(String(sent[0]!.init.body)).clientKey;
        for (const stop of stops)
          expect(JSON.parse(String(stop.init.body))).toEqual({ grant: GRANT, clientKey: key });
      });

      it('a stop civitai keeps answering `unavailable` is asked a bounded number of times', async () => {
        const { sent, tunnels } = failingStart([unavailable]);
        await startAndWait(tunnels);
        expect(stopsOf(sent)).toHaveLength(3);
      });

      it('asks again 5 s after a stop civitai answered `unavailable`, not sooner', async () => {
        const { sent, tunnels } = failingStart([unavailable, stopped]);
        await tunnels
          .forRun(async () => GRANT)
          .start({ blockId: 'my-app', sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY })
          .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopsOf(sent)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(stopsOf(sent)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(stopsOf(sent)).toHaveLength(2);
      });

      it('a stop that could not reach civitai at all is asked again too', async () => {
        const { sent, tunnels } = failingStart([
          () => {
            throw new TypeError('fetch failed');
          },
          stopped,
        ]);
        await startAndWait(tunnels);
        expect(stopsOf(sent)).toHaveLength(2);
      });

      it('a stop civitai refuses (4xx), or answers, is not asked again', async () => {
        for (const answer of [
          stopped,
          () => Response.json({ error: 'no', code: 'invalid_grant' }, { status: 401 }),
          () => Response.json({ error: 'bad' }, { status: 400 }),
        ]) {
          const { sent, tunnels } = failingStart([answer]);
          await startAndWait(tunnels);
          expect(stopsOf(sent), String(answer)).toHaveLength(1);
        }
      });
    });

    it('a keep-alive or stop civitai does not answer fails within 16 s', async () => {
      const { tunnels } = answeringAfter(null, () => Response.json({}));
      const run = tunnels.forRun(async () => GRANT);
      const keepalive = run.keepalive({ host: HOST }).catch((error: unknown) => error);
      const stop = run.stop(SESSION).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await keepalive).toMatchObject({ status: 503, code: 'unavailable' });
      expect(await stop).toMatchObject({ status: 503, code: 'unavailable' });
    });
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
    await ticks(2);
    await keptToBe([CONNECTED, CONNECTED]);
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
      history: chosenApp('my-app'),
      signal: new AbortController().signal,
    });
    opened.push(tools);
    expect(await startDevServer(tools.tools)).toBe(RUNNING);
    expect(tunnelCalls()).toEqual([]);
  });
});

describe('direct preview (civitai serves it with no tunnel)', () => {
  const OLD_ID = 'a'.repeat(32);
  const ID = 'b'.repeat(32);
  /** The app's sandbox, with the preview id the service reports for it. */
  function directApp(previewId = ID) {
    const record = fake.add('my-app');
    record.previewId = previewId;
    tunnels.direct = true;
    return record;
  }
  /** The project runs in `web/`, whose manifest names another block id than the app's key. */
  function manifestBlock(blockId: string, scopes?: string[]) {
    fake.tools.set('dev_server_status', () =>
      JSON.stringify({ running: true, pid: 41, command: 'cd web && npm run dev' })
    );
    fake.tools.set('read_file', (args) =>
      args.path === 'web/block.manifest.json'
        ? JSON.stringify({
            path: args.path,
            content: JSON.stringify({ blockId, ...(scopes ? { scopes } : {}) }),
          })
        : 'no such file'
    );
  }
  /** Runs keep-alive ticks until `n` more were kept (a direct tick asks the sandbox nothing). */
  async function keptMore(n: number) {
    const target = tunnels.kept.length + n;
    for (let tries = 0; tunnels.kept.length < target; tries++) {
      if (tries > 200) throw new Error('no keep-alive tick kept anything');
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
      if (tunnels.kept.length < target) await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('opens through preview/open with the sandbox’s preview id, and takes no tunnel step', async () => {
    directApp();
    const { tools, reported } = await open();
    const result = await call(tools.tools, 'start_preview', { declared_scopes: ['models:read'] });
    expect(tunnels.opens).toEqual([
      { blockId: 'my-app', previewId: ID, declaredScopes: ['models:read'] },
    ]);
    // No host: the session host is the preview's credential.
    expect(result).toEqual({
      shown: true,
      blockId: 'my-app',
      next_step: expect.stringContaining('sandbox__preview_check'),
    });
    expect(tunnelCalls()).toEqual([]);
    expect(tunnels.started).toEqual([]);
    // Control: civitai did hand the runner that host and session id.
    expect(tunnels.directSessions.get('my-app')?.host).toBe(directHost(1));
    // Neither reaches what the page, the journal or the saved conversation see.
    expect(reported.find((r) => r.name === 'start_preview')).toMatchObject({
      isError: false,
      output: { shown: true, blockId: 'my-app' },
    });
    expect(JSON.stringify(reported)).not.toContain(directHost(1));
    expect(JSON.stringify(reported)).not.toContain('bki_TEST_ONLY_direct_1');
  });

  it('civitai answering `tunnel` (the flag off) is the dev tunnel exactly as before', async () => {
    directApp();
    tunnels.direct = false;
    const { tools } = await open();
    const result = await call(tools.tools, 'start_preview');
    expect(tunnels.opens).toHaveLength(1);
    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect']);
    expect(tunnels.started).toHaveLength(1);
    expect(result).toMatchObject({ shown: true, host: HOST });
  });

  it('a resumed app whose old id is used opens a new session in exactly two preview/open calls', async () => {
    const record = directApp(OLD_ID);
    // The app's earlier session on that id ended (it paused, and was resumed).
    tunnels.usedIds.add(OLD_ID);
    const { tools } = await open();
    const result = await call(tools.tools, 'start_preview');
    expect(fake.rotations).toEqual([{ sandbox: record.name, previewId: record.previewId }]);
    const rotated = fake.rotations[0]!.previewId;
    expect(rotated).not.toBe(OLD_ID);
    expect(tunnels.opens.map((o) => o.previewId)).toEqual([OLD_ID, rotated]);
    expect(result).toEqual({ shown: true, blockId: 'my-app', next_step: expect.any(String) });
    expect(tunnels.directSessions.get('my-app')?.previewId).toBe(rotated);
    expect(tunnelCalls()).toEqual([]);
  });

  it('a second `fresh` is an error, not a loop: one rotation, two opens', async () => {
    directApp(OLD_ID);
    tunnels.alwaysFresh = true;
    const { tools, reported } = await open();
    const result = await call(tools.tools, 'start_preview');
    expect(String(result.error)).toMatch(/^The preview could not start just now/);
    expect(tunnels.opens).toHaveLength(2);
    expect(fake.rotations).toHaveLength(1);
    expect(tunnelCalls()).toEqual([]);
    expect(reported.find((r) => r.name === 'start_preview')).toMatchObject({ isError: true });
  });

  it('a later run’s stop_preview ends the earlier run’s session', async () => {
    directApp();
    const first = await open();
    await call(first.tools.tools, 'start_preview');
    expect(tunnels.directSessions.has('my-app')).toBe(true);
    await first.tools.close();

    // A later reply: it opened nothing, and no tunnel runs in the sandbox.
    const later = await open();
    expect(await call(later.tools.tools, 'stop_preview')).toEqual({ stopped: true });
    expect(tunnels.blockStops).toEqual(['my-app']);
    expect(tunnels.directSessions.has('my-app')).toBe(false);
  });

  // Invariant guard (green before this change too): with a tunnel running in the sandbox, a later
  // run's stop_preview stays the tunnel's own disconnect and asks civitai nothing by block.
  it('a later run’s stop_preview of a running tunnel only disconnects it, as before', async () => {
    fake.add('my-app');
    fake.tunnelHosts.set(sandboxOf('my-app'), RESTARTED_HOST);
    const { tools } = await open();
    expect(await call(tools.tools, 'stop_preview')).toEqual({ stopped: true });
    expect(tunnelCalls()).toEqual(['tunnel_disconnect']);
    expect(tunnels.blockStops).toEqual([]);
  });

  it('an app whose block id differs from its key is kept alive and stopped under the block id', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    directApp();
    manifestBlock('my-app-block');
    const command = 'cd web && npm run dev';
    fake.tools.set('dev_server_start', () => JSON.stringify({ running: true, command }));
    const { tools } = await open();
    // The preview opens by itself, for the block id the manifest names.
    await call(tools.tools, 'sandbox__dev_server_start', { command });
    expect(tunnels.opens.map((o) => o.blockId)).toEqual(['my-app-block']);

    await keptMore(2);
    expect(tunnels.kept).toEqual([{ blockId: 'my-app-block' }, { blockId: 'my-app-block' }]);
    // A direct preview has no tunnel to ask about.
    expect(fake.callsTo('tunnel_status')).toBe(0);

    expect(await call(tools.tools, 'stop_preview')).toEqual({ stopped: true });
    expect(tunnels.blockStops).toEqual(['my-app-block']);
    // Stopped: nothing is kept alive any more.
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
    expect(tunnels.kept).toHaveLength(2);
  });

  it('a later run keeps the app’s direct preview alive, by the block id it runs under', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    directApp();
    manifestBlock('my-app-block');
    const first = await open();
    await call(first.tools.tools, 'start_preview', { block_id: 'my-app-block' });
    await first.tools.close();
    // A later reply: it opens nothing, and no tunnel runs in the sandbox.
    await open();
    await keptMore(2);
    expect(tunnels.kept).toEqual([{ blockId: 'my-app-block' }, { blockId: 'my-app-block' }]);
    expect(tunnels.opens).toHaveLength(1);
  });

  // Invariant guard at the fake's level (civitai's own filter is what makes it true, pinned by
  // the request bodies in "CivitaiDevTunnels: direct preview calls"): flag off, a later run's
  // stop_preview with no tunnel running leaves civitai's tunnel record alone, and answers as before.
  it('flag off: a later run’s stop_preview with no tunnel running leaves the tunnel record alone', async () => {
    fake.add('my-app');
    tunnels.tunnelBlocks.add('my-app');
    const { tools } = await open();
    expect(await call(tools.tools, 'stop_preview')).toEqual({ stopped: true });
    expect(tunnelCalls()).toEqual(['tunnel_disconnect']);
    expect(tunnels.stopped).toEqual([]);
    expect(tunnels.tunnelBlocks.has('my-app')).toBe(true);
  });

  it('a later run stops it under the block id its manifest names, not the app’s key', async () => {
    directApp();
    manifestBlock('my-app-block');
    const first = await open();
    await call(first.tools.tools, 'start_preview', { block_id: 'my-app-block' });
    await first.tools.close();
    const later = await open();
    await call(later.tools.tools, 'stop_preview');
    expect(tunnels.blockStops).toEqual(['my-app-block']);
    expect(tunnels.directSessions.size).toBe(0);
  });

  it('a session it may not have opened is not taken to have the scopes it was asked for', async () => {
    directApp();
    // An earlier reply opened the app's preview with no scopes.
    const first = await open();
    await call(first.tools.tools, 'start_preview');
    await first.tools.close();

    // This reply asks for a scope: civitai answers the open session as it is (no scopes), so the
    // runner ends it and opens a new one, which civitai writes with the scope.
    const later = await open();
    await call(later.tools.tools, 'start_preview', { declared_scopes: ['ai:write:budgeted'] });
    expect(tunnels.opens.map((o) => o.declaredScopes)).toEqual([undefined, ['ai:write:budgeted']]);
    // The first ask (`reuse`) did not get the scope; it was ended, and opened again with it.
    await call(later.tools.tools, 'start_preview', { declared_scopes: ['ai:write:budgeted'] });
    expect(tunnels.blockStops).toEqual(['my-app']);
    expect(tunnels.directSessions.get('my-app')?.declaredScopes).toEqual(['ai:write:budgeted']);
    // Now known to have it: asked again, the same preview, and nothing more is asked of civitai.
    const opens = tunnels.opens.length;
    await call(later.tools.tools, 'start_preview', { declared_scopes: ['ai:write:budgeted'] });
    expect(tunnels.opens).toHaveLength(opens);
    expect(tunnels.blockStops).toEqual(['my-app']);
  });

  it('a keep-alive answered NOT_FOUND forgets the session, so the next start opens again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    directApp();
    const { tools } = await open();
    await call(tools.tools, 'start_preview');
    tunnels.keepaliveError = new DevTunnelError('gone', 404, 'NOT_FOUND');
    await keptMore(1);
    tunnels.keepaliveError = null;
    await vi.waitFor(async () => {
      await call(tools.tools, 'start_preview');
      expect(tunnels.opens).toHaveLength(2);
    });
  });
});

describe('CivitaiDevTunnels: direct preview calls', () => {
  const SECRET = 'test-only-runner-secret-0123456789abcdef';
  const GRANT = 'test-only-grant';
  const ID = 'c'.repeat(32);
  function client(answer: (url: string) => Response | Promise<Response>) {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const tunnels = new CivitaiDevTunnels({
      civitaiUrl: 'https://civitai.example',
      secret: SECRET,
      log: quiet,
      fetch: async (input, init) => {
        sent.push({ url: String(input), body: JSON.parse(String(init!.body)) });
        return answer(String(input));
      },
    });
    return { sent, run: tunnels.forRun(async () => GRANT) };
  }
  const busy = () => Response.json({ error: 'busy', code: 'unavailable' }, { status: 503 });

  it('opens at preview/open, keeps and stops by block id, with the run’s grant', async () => {
    const { sent, run } = client((url) =>
      url.endsWith('/open')
        ? Response.json({ mode: 'direct', sessionId: 'bki_x', host: directHost(7) })
        : Response.json({ stopped: true })
    );
    expect(await run.open({ blockId: 'my-app', previewId: ID })).toEqual({
      mode: 'direct',
      sessionId: 'bki_x',
      host: directHost(7),
    });
    await run.keepalive({ blockId: 'my-app' });
    expect(await run.stopBlock('my-app')).toBe(true);
    expect(sent).toEqual([
      {
        url: `https://civitai.example/${PREVIEW_OPEN_PATH}`,
        body: { grant: GRANT, blockId: 'my-app', previewId: ID },
      },
      // By block, always for a direct session only: civitai never keeps or ends a tunnel this way.
      {
        url: `https://civitai.example/${DEV_TUNNEL_PATH}/keepalive`,
        body: { grant: GRANT, blockId: 'my-app', transport: 'direct' },
      },
      {
        url: `https://civitai.example/${DEV_TUNNEL_PATH}/stop`,
        body: { grant: GRANT, blockId: 'my-app', transport: 'direct' },
      },
    ]);
  });

  it('reads `tunnel` and `fresh`; an odd answer is `unavailable`', async () => {
    for (const [body, expected] of [
      [{ mode: 'tunnel' }, { mode: 'tunnel' }],
      [
        { mode: 'direct', fresh: true },
        { mode: 'direct', fresh: true },
      ],
    ] as const) {
      const { run } = client(() => Response.json(body));
      expect(await run.open({ blockId: 'my-app', previewId: ID })).toEqual(expected);
    }
    const { run } = client(() => Response.json({ mode: 'direct' }));
    await expect(run.open({ blockId: 'my-app', previewId: ID })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  describe('a 503 (another open of the app holds its lock)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('is asked again, and the open that follows is answered', async () => {
      let n = 0;
      const { sent, run } = client(() =>
        ++n < 3
          ? busy()
          : Response.json({ mode: 'direct', sessionId: 'bki_y', host: directHost(8) })
      );
      const opened = run.open({ blockId: 'my-app', previewId: ID });
      await vi.runAllTimersAsync();
      expect(await opened).toMatchObject({ mode: 'direct', sessionId: 'bki_y' });
      expect(sent).toHaveLength(3);
    });

    it(`gives up after ${OPEN_ATTEMPTS} asks, as unavailable; a refusal is never asked again`, async () => {
      const { sent, run } = client(busy);
      const opened = run.open({ blockId: 'my-app', previewId: ID }).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      expect(await opened).toMatchObject({ status: 503, code: 'unavailable' });
      expect(sent).toHaveLength(OPEN_ATTEMPTS);
      expect(OPEN_ATTEMPTS).toBe(4);

      const refused = client(() =>
        Response.json({ error: 'Too many', code: 'TOO_MANY_REQUESTS' }, { status: 429 })
      );
      await expect(refused.run.open({ blockId: 'my-app', previewId: ID })).rejects.toMatchObject({
        status: 429,
      });
      expect(refused.sent).toHaveLength(1);
    });
  });

  it('a civitai without the endpoint (a bare 404) means the tunnel; its own 404 is a refusal', async () => {
    const bare = client(() => new Response('<html>404</html>', { status: 404 }));
    expect(await bare.run.open({ blockId: 'my-app', previewId: ID })).toEqual({ mode: 'tunnel' });
    const owned = client(() =>
      Response.json({ error: 'No such app', code: 'NOT_FOUND' }, { status: 404 })
    );
    await expect(owned.run.open({ blockId: 'my-app', previewId: ID })).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});
