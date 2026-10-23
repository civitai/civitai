import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import {
  DevTunnelError,
  type DevTunnels,
  type DevTunnelStartInput,
} from '../app-assistant/dev-tunnel';
import {
  PreviewRestarter,
  RESTART_LIMIT,
  RESTART_MESSAGES,
  type PreviewRestarts,
  type RestartOutcome,
} from '../app-assistant/preview-restart';
import { MintRefusedError } from '../minter';
import type { RunService } from '../service';
import { FAKE_TUNNEL_PUBLIC_KEY, FakeSandboxService } from '../test-support/fake-sandbox';
import { signGrant, signViewer, testKeys } from '../test-support/keys';
import { createTokenVerifier, viewerAuthenticator } from '../tokens';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** The tunnel's id civitai answers with: distinct from every other string here, so a leak shows. */
const SESSION = 'bki_TEST_ONLY_restart_4c1d8e';
const HOST = 'dev-fedcba9876543210.civit.ai';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyRestartHostKey';
const APP = 'my-shop';
const MANIFEST_BLOCK = 'my-shop-block';

/** civitai's dev-tunnel endpoints, recording what they were asked. */
class FakeTunnels implements DevTunnels {
  readonly started: DevTunnelStartInput[] = [];
  readonly kept: string[] = [];
  readonly stopped: string[] = [];
  startError: unknown = null;
  /** Holds every start until released, so two restarts can overlap. */
  gate: Promise<void> | null = null;

  async start(input: DevTunnelStartInput) {
    this.started.push(input);
    if (this.gate) await this.gate;
    if (this.startError) throw this.startError;
    return { sessionId: SESSION, host: HOST, sshHostPublicKey: HOST_KEY };
  }

  async keepalive(sessionId: string) {
    this.kept.push(sessionId);
  }

  async stop(sessionId: string) {
    this.stopped.push(sessionId);
  }
}

let fake: FakeSandboxService;
let tunnels: FakeTunnels;
let grantsSeen: string[];
let tokenError: unknown;

beforeEach(async () => {
  fake = new FakeSandboxService();
  await fake.start();
  tunnels = new FakeTunnels();
  grantsSeen = [];
  tokenError = null;
  // The dev server runs in `web/`, whose manifest names another block id than the app's key.
  fake.tools.set('dev_server_status', () =>
    JSON.stringify({ running: true, pid: 41, command: 'cd web && npm run dev' })
  );
  fake.tools.set('read_file', (args) =>
    args.path === 'web/block.manifest.json'
      ? JSON.stringify({
          path: args.path,
          content: JSON.stringify({ blockId: MANIFEST_BLOCK, scopes: ['models:read'] }),
        })
      : 'no such file'
  );
});

afterEach(async () => {
  await fake.stop();
});

function restarter(options: { waitMs?: number; now?: () => number } = {}) {
  return new PreviewRestarter({
    sandboxUrl: fake.url,
    forGrant: (grant) => {
      grantsSeen.push(grant);
      return {
        tokens: async (purpose) => {
          if (tokenError) throw tokenError;
          return `test-token-${purpose}`;
        },
        tunnels,
      };
    },
    log: quiet,
    pollMs: 5,
    ...options,
  });
}

const tunnelCalls = () => fake.calls.filter((c) => c.tool.startsWith('tunnel_')).map((c) => c.tool);

describe('PreviewRestarter', () => {
  it('opens the running app’s preview for its manifest’s block, and answers only the block and host', async () => {
    fake.add(APP);
    const outcome = await restarter().restart('u-1', APP, 'test-preview-grant');

    expect(outcome).toEqual({ ok: true, blockId: MANIFEST_BLOCK, host: HOST });
    expect(JSON.stringify(outcome)).not.toContain(SESSION);
    // Control: civitai did hand the runner that id, for the block and scopes the manifest names.
    expect(tunnels.started).toEqual([
      {
        blockId: MANIFEST_BLOCK,
        sshPublicKey: FAKE_TUNNEL_PUBLIC_KEY,
        declaredScopes: ['models:read'],
      },
    ]);
    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect']);
    expect(fake.calls.find((c) => c.tool === 'tunnel_connect')!.args).toEqual({
      host: HOST,
      ssh_host_public_key: HOST_KEY,
    });
    // With the request's own grant, and nothing kept alive or closed: no run is live.
    expect(grantsSeen).toEqual(['test-preview-grant']);
    expect(tunnels.kept).toEqual([]);
    expect(tunnels.stopped).toEqual([]);
  });

  it('never wakes a paused app, which would pause the one that runs', async () => {
    fake.add(APP, 'suspended');
    const outcome = await restarter().restart('u-1', APP, 'g');
    expect(outcome).toEqual({
      ok: false,
      error: 'not-running',
      message: 'Your app is not running. Start it, then restart the preview.',
    });
    expect(fake.sandboxes[0]!.state).toBe('suspended');
    expect(fake.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(tunnels.started).toEqual([]);
  });

  it('waits for an app the page just started, then opens its preview', async () => {
    fake.add(APP, 'starting');
    fake.startsAfter = 2;
    const outcome = await restarter().restart('u-1', APP, 'g');
    expect(outcome).toEqual({ ok: true, blockId: MANIFEST_BLOCK, host: HOST });
    // Looked at, never opened: the page's start did that.
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/sandboxes')).toBe(
      false
    );
  });

  it('gives up on an app that does not run in time', async () => {
    fake.add(APP, 'starting');
    fake.startsAfter = 1_000;
    const outcome = await restarter({ waitMs: 30 }).restart('u-1', APP, 'g');
    expect(outcome).toMatchObject({ ok: false, error: 'not-running' });
    expect(tunnels.started).toEqual([]);
  });

  it('says so when the dev server is not running, and asks civitai for nothing', async () => {
    fake.add(APP);
    fake.tools.set('dev_server_status', () => JSON.stringify({ running: false, lastExit: 1 }));
    const outcome = await restarter().restart('u-1', APP, 'g');
    expect(outcome).toEqual({
      ok: false,
      error: 'not-running',
      message:
        'Your app’s dev server is not running. Ask the assistant to start it, and the preview opens by itself.',
    });
    expect(tunnels.started).toEqual([]);
    expect(tunnelCalls()).toEqual([]);
  });

  it('answers not-found for an app the user has no sandbox for', async () => {
    fake.add('another-app');
    expect(await restarter().restart('u-1', APP, 'g')).toEqual({
      ok: false,
      error: 'not-found',
      message: 'That app was not found among yours.',
    });
  });

  it.each<[number, string, RestartOutcome]>([
    [403, 'FORBIDDEN', { ok: false, error: 'refused', message: RESTART_MESSAGES.refused }],
    [403, 'refused', { ok: false, error: 'refused', message: RESTART_MESSAGES.refused }],
    [404, 'NOT_FOUND', { ok: false, error: 'not-found', message: RESTART_MESSAGES['not-found'] }],
    [
      429,
      'TOO_MANY_REQUESTS',
      {
        ok: false,
        error: 'rate-limited',
        message:
          'Too many previews were started in the last hour. Wait a few minutes, then try again.',
      },
    ],
    [
      503,
      'unavailable',
      { ok: false, error: 'unavailable', message: RESTART_MESSAGES.unavailable },
    ],
    [
      401,
      'invalid_grant',
      { ok: false, error: 'unavailable', message: RESTART_MESSAGES.unavailable },
    ],
  ])('surfaces civitai’s refusal %i %s, and connects nothing', async (status, code, expected) => {
    fake.add(APP);
    tunnels.startError = new DevTunnelError('civitai says no', status, code);
    expect(await restarter().restart('u-1', APP, 'g')).toEqual(expected);
    expect(tunnelCalls()).toEqual(['tunnel_key']);
  });

  it('answers refused when civitai refuses the user a sandbox token', async () => {
    fake.add(APP);
    tokenError = new MintRefusedError('refused', 'Banned.', 403);
    expect(await restarter().restart('u-1', APP, 'g')).toEqual({
      ok: false,
      error: 'refused',
      message: 'Live preview is not available on this account.',
    });
    expect(tunnels.started).toEqual([]);
  });

  it('answers failed, and closes civitai’s tunnel, when the sandbox cannot dial it', async () => {
    fake.add(APP);
    fake.tools.set('tunnel_connect', () => {
      throw new Error('ssh exited');
    });
    expect(await restarter().restart('u-1', APP, 'g')).toEqual({
      ok: false,
      error: 'failed',
      message:
        'The preview could not connect to your app. Make sure its dev server runs, then try again.',
    });
    expect(tunnels.stopped).toEqual([SESSION]);
  });

  it('two clicks at once make one tunnel, and both get its answer', async () => {
    fake.add(APP);
    let release!: () => void;
    tunnels.gate = new Promise<void>((resolve) => (release = resolve));
    const restarts = restarter();
    const first = restarts.restart('u-1', APP, 'g-1');
    const second = restarts.restart('u-1', APP, 'g-2');
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ ok: true, blockId: MANIFEST_BLOCK, host: HOST });
    expect(b).toEqual(a);
    expect(tunnels.started).toHaveLength(1);
    expect(tunnelCalls()).toEqual(['tunnel_key', 'tunnel_connect']);
    // Control: once it ended, the next click is a restart of its own.
    await restarts.restart('u-1', APP, 'g-3');
    expect(tunnels.started).toHaveLength(2);
  });

  it(`allows each user ${RESTART_LIMIT} restarts in the window, then refuses without asking anyone`, async () => {
    fake.add(APP);
    let now = 1_000_000;
    const restarts = restarter({ now: () => now });
    for (let i = 0; i < RESTART_LIMIT; i++)
      expect(await restarts.restart('u-1', APP, 'g')).toMatchObject({ ok: true });
    expect(await restarts.restart('u-1', APP, 'g')).toEqual({
      ok: false,
      error: 'rate-limited',
      message: 'You restarted the preview many times just now. Wait a few minutes, then try again.',
    });
    expect(tunnels.started).toHaveLength(RESTART_LIMIT);
    // Another user is not held to this one's count, and the window moves on.
    expect(await restarts.restart('u-2', APP, 'g')).toMatchObject({ ok: true });
    now += 10 * 60_000;
    expect(await restarts.restart('u-1', APP, 'g')).toMatchObject({ ok: true });
  });
});

// ── The route ─────────────────────────────────────────────────────────────────────────────────

// TEST-ONLY keys standing in for civitai's (see test-support/keys.ts).
const keys = testKeys();
const verifier = createTokenVerifier(keys.publicPem);
const previewGrant = (
  userId: string,
  app: string,
  extra: Record<string, unknown> = { use: 'preview' }
) =>
  signGrant(keys, { userId, conversationId: `preview:${app}`, idempotencyKey: 'pk-1' }, 120, extra);

/** The run API's own service is not what this route uses: any call to it fails the test. */
const noRuns = new Proxy({} as RunService, {
  get: (_target, name) =>
    name === 'ready'
      ? () => true
      : () => {
          throw new Error(`the run service was called (${String(name)})`);
        },
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(previews?: PreviewRestarts): Promise<string> {
  app = buildApp({
    service: noRuns,
    authenticator: viewerAuthenticator(verifier),
    grants: verifier,
    ...(previews ? { previews } : {}),
    basePath: '/api/assistant-runner',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

/** A restarter that records each call and answers `outcome`. */
function recording(outcome: RestartOutcome = { ok: true, blockId: APP, host: HOST }) {
  const calls: [string, string, string][] = [];
  const previews: PreviewRestarts = {
    restart: async (userId, appKey, grant) => {
      calls.push([userId, appKey, grant]);
      return outcome;
    },
  };
  return { calls, previews };
}

async function post(base: string, appKey: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/assistant-runner/apps/${appKey}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ v: 1 }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
}

describe('POST apps/:app/preview', () => {
  it('answers 401 without a viewer token, restarting nothing', async () => {
    const { calls, previews } = recording();
    const base = await serve(previews);
    const grant = await previewGrant('u1', APP);
    expect((await post(base, APP, { 'x-run-grant': grant })).status).toBe(401);
    expect(
      (await post(base, APP, { authorization: 'Bearer not-a-token', 'x-run-grant': grant })).status
    ).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 403 to a grant that is another user’s, another app’s, a run grant, or missing', async () => {
    const { calls, previews } = recording();
    const base = await serve(previews);
    const viewer = `Bearer ${await signViewer(keys, 'u1')}`;
    const cases = [
      await previewGrant('u2', APP),
      await previewGrant('u1', 'another-app'),
      await previewGrant('u1', APP, {}),
      await previewGrant('u1', APP, { use: 'run' }),
    ];
    for (const grant of cases)
      expect(await post(base, APP, { authorization: viewer, 'x-run-grant': grant })).toEqual({
        status: 403,
        body: {
          v: 1,
          error: 'refused',
          message: 'This restart needs a current preview grant for this app in x-run-grant.',
        },
      });
    expect((await post(base, APP, { authorization: viewer })).status).toBe(403);
    expect(calls).toEqual([]);
    // Control: the same viewer with their own preview grant for this app gets through.
    const own = await previewGrant('u1', APP);
    expect((await post(base, APP, { authorization: viewer, 'x-run-grant': own })).status).toBe(200);
    expect(calls).toEqual([['u1', APP, own]]);
  });

  it('refuses a preview grant for a reply start: it is good for nothing else', async () => {
    const base = await serve(recording().previews);
    const res = await fetch(`${base}/api/assistant-runner/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await signViewer(keys, 'u1')}`,
        'x-run-grant': await previewGrant('u1', APP),
      },
      body: JSON.stringify({
        v: 1,
        idempotencyKey: 'pk-1',
        conversationId: `preview:${APP}`,
        turn: { seq: 1, user: { content: 'hi', attachments: [] } },
        model: 'm',
        settings: {
          maxOutputTokens: 100,
          tier: 'auto',
          allowMature: false,
          autoRunLimit: 0,
          spokenReplies: false,
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it('answers 400 to a key that is not an app’s, and 503 when restarts are not set up', async () => {
    const viewer = `Bearer ${await signViewer(keys, 'u1')}`;
    const base = await serve();
    expect(
      (await post(base, 'Not_An_App', { authorization: viewer, 'x-run-grant': 'x' })).status
    ).toBe(400);
    expect(
      await post(base, APP, { authorization: viewer, 'x-run-grant': await previewGrant('u1', APP) })
    ).toEqual({
      status: 503,
      body: { v: 1, error: 'unavailable', message: 'The live preview is not set up here.' },
    });
  });

  it.each<[RestartOutcome & { ok: false }, number]>([
    [{ ok: false, error: 'refused', message: 'r' }, 403],
    [{ ok: false, error: 'not-found', message: 'n' }, 404],
    [{ ok: false, error: 'not-running', message: 'nr' }, 409],
    [{ ok: false, error: 'rate-limited', message: 'rl' }, 429],
    [{ ok: false, error: 'failed', message: 'f' }, 502],
    [{ ok: false, error: 'unavailable', message: 'u' }, 503],
  ])('answers the refusal %j with %i and its words', async (outcome, status) => {
    const base = await serve(recording(outcome).previews);
    expect(
      await post(base, APP, {
        authorization: `Bearer ${await signViewer(keys, 'u1')}`,
        'x-run-grant': await previewGrant('u1', APP),
      })
    ).toEqual({ status, body: { v: 1, error: outcome.error, message: outcome.message } });
  });

  it('end to end: the browser gets exactly the block and host, never the tunnel’s id', async () => {
    fake.add(APP);
    const base = await serve(restarter());
    const res = await fetch(`${base}/api/assistant-runner/apps/${APP}/preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await signViewer(keys, 'u1')}`,
        'x-run-grant': await previewGrant('u1', APP),
      },
      body: JSON.stringify({ v: 1 }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ v: 1, blockId: MANIFEST_BLOCK, host: HOST });
    expect(text).not.toContain(SESSION);
    // Control: civitai did hand the runner that id.
    expect(tunnels.started).toHaveLength(1);
  });

  it('end to end: civitai’s 429 reaches the browser as a 429 with words for the user', async () => {
    fake.add(APP);
    tunnels.startError = new DevTunnelError('Too many', 429, 'TOO_MANY_REQUESTS');
    const base = await serve(restarter());
    expect(
      await post(base, APP, {
        authorization: `Bearer ${await signViewer(keys, 'u1')}`,
        'x-run-grant': await previewGrant('u1', APP),
      })
    ).toEqual({
      status: 429,
      body: {
        v: 1,
        error: 'rate-limited',
        message:
          'Too many previews were started in the last hour. Wait a few minutes, then try again.',
      },
    });
  });
});
