import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';

/**
 * App Assistant's server runner opens, keeps alive and closes a dev tunnel for the user its run
 * grant names: `/api/internal/app-assistant/dev-tunnel/{start,keepalive,stop}`.
 *
 * The routes run against the REAL dev-tunnel service and the REAL shared start gate
 * (`dev-tunnel-access.service.ts`), over an in-memory sysRedis, so "recorded for the grant's
 * user", "moves the idle clock" and "ends the session" are read back from the state the service
 * wrote, not from a stub's call log. Mocked: the k8s apply/list (no cluster), the App Assistant
 * user gates (`getRunnerDevTunnelUser`, covered in app-assistant.service.test.ts), the dev-tunnel
 * Flipt flag, and app ownership (`BlockRegistry.resolveDevPageBlockForAuthor`).
 */

const { runnerUserMock, devTunnelFlagMock, resolveMock, k8sFetchMock, store } = vi.hoisted(() => ({
  runnerUserMock: vi.fn(),
  devTunnelFlagMock: vi.fn(),
  resolveMock: vi.fn(),
  k8sFetchMock: vi.fn(),
  store: new Map<string, string>(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  getRunnerDevTunnelUser: runnerUserMock,
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksDevTunnelEnabled: devTunnelFlagMock,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveDevPageBlockForAuthor: resolveMock },
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  getDp1Target: vi.fn(async () => ({ server: 'https://k8s.test', token: 'test-only' })),
  k8sFetch: k8sFetchMock,
  unwrap: vi.fn(async (res: { text: () => Promise<string> }) => {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }),
  waitForApplyJob: vi.fn(async () => 'succeeded'),
}));
vi.mock('~/server/prom/dev-tunnel.metrics', () => ({
  recordDevTunnelMint: vi.fn(),
  recordDevTunnelTeardown: vi.fn(),
  recordDevTunnelDnsGc: vi.fn(),
}));

const { signRunGrant, signRunnerViewerToken } = await import(
  '~/server/services/app-assistant/assistant-runner-tokens'
);
const { DEV_TUNNEL_IDLE_SECONDS, reapExpiredDevTunnels } = await import(
  '~/server/services/blocks/dev-tunnel.service'
);
const startRoute = (await import('~/pages/api/internal/app-assistant/dev-tunnel/start')).default;
const keepaliveRoute = (await import('~/pages/api/internal/app-assistant/dev-tunnel/keepalive'))
  .default;
const stopRoute = (await import('~/pages/api/internal/app-assistant/dev-tunnel/stop')).default;
const { recordDevTunnelTeardown } = await import('~/server/prom/dev-tunnel.metrics');

// TEST-ONLY values: a key pair generated for this run, a placeholder secret and host key.
const SECRET = 'test-only-runner-secret-for-tunnels';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SISH_HOST_KEY = 'ssh-ed25519 AAAAC3NzaTestOnlySishHostKey test-sish-host';
const SANDBOX_KEY = 'ssh-ed25519 AAAAC3NzaTestOnlySandboxTunnelKey0123 sandbox';

// Pairwise-distinct fixtures: two users, three apps, none sharing a number or a name.
const OWNER = 4101;
const OTHER = 4202;
const OWNED_APP = 'alpha-app';
const UNSUBMITTED_APP = 'gamma-app';
const OTHERS_APP = 'beta-app';
const APPS: Record<string, { blockId: string; status: string }> = {
  [`${OWNER}:${OWNED_APP}`]: { blockId: OWNED_APP, status: 'approved' },
  [`${OWNER}:${UNSUBMITTED_APP}`]: { blockId: UNSUBMITTED_APP, status: 'ephemeral' },
  [`${OTHER}:${OTHERS_APP}`]: { blockId: OTHERS_APP, status: 'pending' },
};

const PREFIX = 'system:blocks:dev-tunnel';
const sessionRecord = (sessionId: string) => {
  const raw = store.get(`${PREFIX}:session:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
};
const ageSession = (sessionId: string, lastActivityAt: number) =>
  store.set(
    `${PREFIX}:session:${sessionId}`,
    JSON.stringify({ ...sessionRecord(sessionId), lastActivityAt })
  );
const nowSec = () => Math.floor(Date.now() / 1000);
/** The service's scripts' Redis, set up per test in `beforeEach`. */
let lua: LuaRedis;

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;

async function call(handler: Handler, { headers = asRunner, body }: CallOpts) {
  let status = 200;
  let json: Record<string, unknown> | undefined;
  const sent = new Map<string, unknown>();
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      json = value;
      return res;
    },
    setHeader(name: string, value: unknown) {
      sent.set(name.toLowerCase(), value);
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', headers, body, query: {} } as unknown as NextApiRequest, res);
  return { status, json, headers: sent };
}
type CallOpts = { headers?: Record<string, string>; body?: unknown };

const asRunner = { authorization: `Bearer ${SECRET}` };
const grantFor = async (userId: number) =>
  (await signRunGrant({ userId, conversationId: `c-${userId}`, idempotencyKey: `k-${userId}` }))
    .token;

async function startFor(userId: number, blockId: string) {
  return call(startRoute, {
    body: { grant: await grantFor(userId), blockId, sshPublicKey: SANDBOX_KEY },
  });
}

function okRes(body = '{}') {
  return { ok: true, status: 200, text: async () => body, headers: { get: () => null } };
}

/** Every tunnel route the reaper's label-scoped LIST should see, created long ago. */
function listRoutesFor(sessionIds: string[]) {
  k8sFetchMock.mockImplementation(
    async (_target: unknown, path: string, init?: { method?: string }) => {
      if (
        init?.method === 'GET' &&
        path.includes('ingressroutes?labelSelector=civitai.com%2Fdev-tunnel%3Dtrue')
      )
        return okRes(
          JSON.stringify({
            items: sessionIds.map((id) => ({
              metadata: {
                labels: { 'civitai.com/dev-tunnel-session': id },
                creationTimestamp: '2020-01-01T00:00:00Z',
              },
            })),
          })
        );
      return okRes(JSON.stringify({ items: [] }));
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
    APPS_DEV_TUNNEL_SSH_HOST_PUBKEY: SISH_HOST_KEY,
    APPS_DEV_TUNNEL_INGRESS_TARGET: undefined,
    APPS_DEV_TUNNEL_CF_API_TOKEN: undefined,
  });
  runnerUserMock.mockImplementation(async (userId: number) => ({
    refusal: null,
    user: { id: userId, isModerator: true },
  }));
  devTunnelFlagMock.mockResolvedValue(true);
  resolveMock.mockImplementation(async (blockId: string, userId: number) => {
    const app = APPS[`${userId}:${blockId}`];
    return app ? { ...app, appBlockId: `apb-${app.blockId}`, appId: `app-${app.blockId}` } : null;
  });
  k8sFetchMock.mockImplementation(async () => okRes(JSON.stringify({ items: [] })));

  const sys = redisMock.sysRedis;
  sys.get.mockImplementation(async (k: string) => store.get(k) ?? null);
  sys.set.mockImplementation(
    async (k: string, v: string, opts?: { XX?: boolean; NX?: boolean }) => {
      if (opts?.XX && !store.has(k)) return null;
      if (opts?.NX && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }
  );
  sys.del.mockImplementation(async (k: string) => (store.delete(k) ? 1 : 0));
  sys.incrBy.mockImplementation(async (k: string, n: number) => {
    const next = Number(store.get(k) ?? '0') + n;
    store.set(k, String(next));
    return next;
  });
  sys.expire.mockImplementation(async () => true);
  sys.ttl.mockImplementation(async () => 3600);
  // The service's scripts (the ban index's SADD, a pointer's compare-and-delete) run for real, in
  // Lua, over the same keys `get`/`set`/`del` serve; the ban index lives in the harness's sets.
  lua = createLuaRedis(Date.now(), { integerArgs: true, strings: store });
  sys.eval.mockImplementation((script: string, opts: { keys: string[]; arguments: string[] }) =>
    lua.eval(script, opts)
  );
  sys.sRem.mockImplementation((k: string, v: string) =>
    lua.eval("return redis.call('SREM', KEYS[1], ARGV[1])", { keys: [k], arguments: [v] })
  );
});

describe('the runner’s secret and run grant, on every endpoint', () => {
  const routes = { start: startRoute, keepalive: keepaliveRoute, stop: stopRoute };
  const bodyFor = async (name: string, grant: string) =>
    name === 'start'
      ? { grant, blockId: OWNED_APP, sshPublicKey: SANDBOX_KEY }
      : { grant, sessionId: 'bki_whatever' };

  it.each(Object.keys(routes))(
    '%s: 401 to a missing or wrong secret, touching nothing',
    async (name) => {
      const body = await bodyFor(name, await grantFor(OWNER));
      for (const headers of [
        {},
        { authorization: 'Bearer not-the-secret' },
        { authorization: SECRET },
      ]) {
        const { status, json } = await call(routes[name as keyof typeof routes], { headers, body });
        expect(status, JSON.stringify(headers)).toBe(401);
        expect(json).toEqual({ error: 'Unauthorized' });
      }
      expect(runnerUserMock).not.toHaveBeenCalled();
      expect(resolveMock).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    }
  );

  it.each(Object.keys(routes))(
    '%s: 503 while the runner’s secret is not configured',
    async (name) => {
      setEnv({ ASSISTANT_RUNNER_SECRET: '' });
      const body = await bodyFor(name, await grantFor(OWNER));
      const { status } = await call(routes[name as keyof typeof routes], {
        headers: { authorization: 'Bearer ' },
        body,
      });
      expect(status).toBe(503);
      expect(store.size).toBe(0);
    }
  );

  it.each(Object.keys(routes))(
    '%s: 401 invalid_grant to an expired grant, a viewer token, or garbage',
    async (name) => {
      setEnv({ ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 60 });
      const soon = await grantFor(OWNER);
      const viewer = (await signRunnerViewerToken(OWNER)).token;
      vi.useFakeTimers({ now: Date.now() + 10 * 60 * 1000, toFake: ['Date'] });
      try {
        for (const grant of [soon, viewer, 'a.b.c']) {
          const { status, json } = await call(routes[name as keyof typeof routes], {
            body: await bodyFor(name, grant),
          });
          expect(status).toBe(401);
          expect(json).toMatchObject({ code: 'invalid_grant' });
        }
      } finally {
        vi.useRealTimers();
      }
      expect(runnerUserMock).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    }
  );

  it.each(Object.keys(routes))('%s: 400 to a body without a grant', async (name) => {
    const body = await bodyFor(name, await grantFor(OWNER));
    delete (body as { grant?: string }).grant;
    expect((await call(routes[name as keyof typeof routes], { body })).status).toBe(400);
  });
});

describe('POST dev-tunnel/start', () => {
  it('opens the tunnel for the grant’s user and returns only what the sandbox dials with', async () => {
    const { status, json, headers } = await startFor(OWNER, OWNED_APP);
    expect(status).toBe(200);
    expect(json).toEqual({
      sessionId: expect.stringMatching(/^bki_/),
      host: expect.stringMatching(/^dev-[a-f0-9]{16}\.civit\.ai$/),
      sshHostPublicKey: SISH_HOST_KEY,
    });
    expect(headers.get('cache-control')).toBe('no-store');
    // Recorded for the GRANT's user, against the app the ownership gate resolved.
    expect(sessionRecord(json!.sessionId)).toMatchObject({
      userId: OWNER,
      blockId: OWNED_APP,
      host: json!.host,
    });
    expect(store.get(`${PREFIX}:user:${OWNER}:${OWNED_APP}`)).toBe(json!.sessionId);
    expect(runnerUserMock).toHaveBeenCalledWith(OWNER);
    expect(resolveMock).toHaveBeenCalledWith(OWNED_APP, OWNER, { db: 'write' });
    // The approved/owned path does not spend the unsubmitted-app start budget.
    expect(redisMock.sysRedis.incrBy).not.toHaveBeenCalled();
  });

  it('refuses with the gate’s own status and code when an App Assistant gate refuses the user', async () => {
    runnerUserMock.mockResolvedValue({
      refusal: { status: 403, error: 'banned', code: 'refused' },
    });
    expect(await startFor(OWNER, OWNED_APP)).toMatchObject({
      status: 403,
      json: { error: 'banned', code: 'refused' },
    });
    runnerUserMock.mockResolvedValue({
      refusal: {
        status: 403,
        error: 'You do not have access to Apps authoring',
        code: 'FORBIDDEN',
      },
    });
    expect(await startFor(OWNER, OWNED_APP)).toMatchObject({
      status: 403,
      json: { code: 'FORBIDDEN' },
    });
    runnerUserMock.mockResolvedValue({
      refusal: { status: 503, error: 'later', unavailable: true, code: 'unavailable' },
    });
    expect(await startFor(OWNER, OWNED_APP)).toMatchObject({
      status: 503,
      json: { code: 'unavailable' },
    });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('refuses 403 FORBIDDEN, as blocks.startDevTunnel, while the dev-tunnel flag is off for the user', async () => {
    devTunnelFlagMock.mockResolvedValue(false);
    expect(await startFor(OWNER, OWNED_APP)).toMatchObject({
      status: 403,
      json: { error: 'Dev tunnels are not available', code: 'FORBIDDEN' },
    });
    expect(devTunnelFlagMock).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: OWNER }),
    });
    expect(store.size).toBe(0);
  });

  it('refuses 404 NOT_FOUND, as blocks.startDevTunnel, for an app the grant’s user does not own', async () => {
    expect(await startFor(OWNER, OTHERS_APP)).toMatchObject({
      status: 404,
      json: { error: 'App not found', code: 'NOT_FOUND' },
    });
    expect(store.size).toBe(0);
    // Control: its owner may open it.
    expect((await startFor(OTHER, OTHERS_APP)).status).toBe(200);
  });

  it('counts an unsubmitted app’s start against the user’s hourly limit, and refuses 429 past it', async () => {
    expect((await startFor(OWNER, UNSUBMITTED_APP)).status).toBe(200);
    expect(store.get(`system:blocks:dev-tunnel-ephemeral-rate-limit:${OWNER}`)).toBe('1');
    store.set(`system:blocks:dev-tunnel-ephemeral-rate-limit:${OWNER}`, '20');
    expect(await startFor(OWNER, UNSUBMITTED_APP)).toMatchObject({
      status: 429,
      json: { code: 'TOO_MANY_REQUESTS' },
    });
  });

  it('refuses 400 BAD_REQUEST an SSH public key that does not parse, opening nothing', async () => {
    const { status, json } = await call(startRoute, {
      // One field: no key type and body to normalize.
      body: { grant: await grantFor(OWNER), blockId: OWNED_APP, sshPublicKey: 'garbage' },
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'Invalid SSH public key', code: 'BAD_REQUEST' });
    expect([...store.keys()].filter((k) => k.startsWith(`${PREFIX}:`))).toEqual([]);
  });

  it('closes what it opened and answers 503 when the sish host key is not configured', async () => {
    setEnv({ APPS_DEV_TUNNEL_SSH_HOST_PUBKEY: undefined });
    const { status, json } = await startFor(OWNER, OWNED_APP);
    expect(status).toBe(503);
    expect(json).not.toHaveProperty('host');
    expect([...store.keys()].filter((k) => k.includes(':session:'))).toEqual([]);
  });

  it('answers 503 unavailable, without the render’s own text, when the route cannot be rendered', async () => {
    k8sFetchMock.mockImplementation(async () => {
      throw new Error('apiserver said something internal');
    });
    const { status, json } = await startFor(OWNER, OWNED_APP);
    expect(status).toBe(503);
    expect(json).toEqual({ error: 'Could not open the dev tunnel right now', code: 'unavailable' });
  });
});

describe('POST dev-tunnel/keepalive', () => {
  const keepalive = async (userId: number, sessionId: string) =>
    call(keepaliveRoute, { body: { grant: await grantFor(userId), sessionId } });

  it('moves the idle clock: a kept tunnel survives the reaper, an identical unkept one does not', async () => {
    const kept = (await startFor(OWNER, OWNED_APP)).json!.sessionId as string;
    const unkept = (await startFor(OTHER, OTHERS_APP)).json!.sessionId as string;
    const stale = nowSec() - DEV_TUNNEL_IDLE_SECONDS - 120;
    ageSession(kept, stale);
    ageSession(unkept, stale);

    const before = nowSec();
    const { status, json } = await keepalive(OWNER, kept);
    expect(status).toBe(200);
    expect(json).toEqual({
      sessionId: kept,
      idleExpiresAt: expect.any(Number),
      expiresAt: sessionRecord(kept).hardExpiresAt,
    });
    expect(sessionRecord(kept).lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(json!.idleExpiresAt).toBe(sessionRecord(kept).lastActivityAt + DEV_TUNNEL_IDLE_SECONDS);

    listRoutesFor([kept, unkept]);
    expect(await reapExpiredDevTunnels()).toMatchObject({ swept: 2, reaped: 1, listOk: true });
    expect(sessionRecord(kept)).not.toBeNull();
    expect(sessionRecord(unkept)).toBeNull();
  });

  it('refuses 404 NOT_FOUND to keep another user’s tunnel alive, leaving its idle clock alone', async () => {
    const theirs = (await startFor(OWNER, OWNED_APP)).json!.sessionId as string;
    ageSession(theirs, 1000);
    expect(await keepalive(OTHER, theirs)).toMatchObject({
      status: 404,
      json: { error: 'No such dev tunnel', code: 'NOT_FOUND' },
    });
    expect(sessionRecord(theirs).lastActivityAt).toBe(1000);
    // Control: the path is reachable — the owner's own grant keeps the same session alive.
    expect((await keepalive(OWNER, theirs)).status).toBe(200);
    expect(sessionRecord(theirs).lastActivityAt).not.toBe(1000);
  });

  it('refuses 404 NOT_FOUND for a session that does not exist', async () => {
    expect(await keepalive(OWNER, 'bki_01NOSUCHSESSION')).toMatchObject({
      status: 404,
      json: { code: 'NOT_FOUND' },
    });
    expect(store.has(`${PREFIX}:session:bki_01NOSUCHSESSION`)).toBe(false);
  });

  it('stops keeping tunnels alive once a gate refuses the user, or the dev-tunnel flag is off', async () => {
    const sessionId = (await startFor(OWNER, OWNED_APP)).json!.sessionId as string;
    ageSession(sessionId, 2000);
    devTunnelFlagMock.mockResolvedValue(false);
    expect(await keepalive(OWNER, sessionId)).toMatchObject({
      status: 403,
      json: { error: 'Dev tunnels are not available', code: 'FORBIDDEN' },
    });
    devTunnelFlagMock.mockResolvedValue(true);
    runnerUserMock.mockResolvedValue({
      refusal: { status: 403, error: 'banned', code: 'refused' },
    });
    expect(await keepalive(OWNER, sessionId)).toMatchObject({
      status: 403,
      json: { code: 'refused' },
    });
    expect(sessionRecord(sessionId).lastActivityAt).toBe(2000);
  });
});

describe('POST dev-tunnel/keepalive by host (a tunnel the run did not open)', () => {
  const keepHost = async (userId: number, host: string) =>
    call(keepaliveRoute, { body: { grant: await grantFor(userId), host } });

  it('keeps the grant’s user’s tunnel at the host alive, whoever opened it', async () => {
    // Opened outside this run (the page's Restart preview is another grant of the same user).
    const { sessionId, host } = (await startFor(OWNER, OWNED_APP)).json as {
      sessionId: string;
      host: string;
    };
    ageSession(sessionId, nowSec() - DEV_TUNNEL_IDLE_SECONDS - 120);
    const before = nowSec();
    const { status, json } = await keepHost(OWNER, host);
    expect(status).toBe(200);
    expect(json).toEqual({
      host,
      idleExpiresAt: sessionRecord(sessionId).lastActivityAt + DEV_TUNNEL_IDLE_SECONDS,
      expiresAt: sessionRecord(sessionId).hardExpiresAt,
    });
    expect(sessionRecord(sessionId).lastActivityAt).toBeGreaterThanOrEqual(before);
    // The run never learns the tunnel's id.
    expect(JSON.stringify(json)).not.toContain(sessionId);
    listRoutesFor([sessionId]);
    expect(await reapExpiredDevTunnels()).toMatchObject({ swept: 1, reaped: 0 });
  });

  it('never keeps another user’s tunnel alive, even at a host the caller names', async () => {
    const { sessionId: theirs, host } = (await startFor(OTHER, OTHERS_APP)).json as {
      sessionId: string;
      host: string;
    };
    ageSession(theirs, 3000);
    expect(await keepHost(OWNER, host)).toMatchObject({
      status: 404,
      json: { error: 'No such dev tunnel', code: 'NOT_FOUND' },
    });
    expect(sessionRecord(theirs).lastActivityAt).toBe(3000);
    // Control: the path is reachable — its owner's grant keeps the same tunnel alive.
    expect((await keepHost(OTHER, host)).status).toBe(200);
    expect(sessionRecord(theirs).lastActivityAt).not.toBe(3000);
  });

  it('never keeps a tunnel that is no longer at that host (a stale host entry)', async () => {
    const { sessionId, host } = (await startFor(OWNER, OWNED_APP)).json as {
      sessionId: string;
      host: string;
    };
    ageSession(sessionId, 4000);
    const stale = host.replace(/^dev-[0-9a-f]{16}/, 'dev-0f0f0f0f0f0f0f0f');
    expect(stale).not.toBe(host);
    store.set(`${PREFIX}:host:${stale}`, sessionId);
    expect(await keepHost(OWNER, stale)).toMatchObject({ status: 404 });
    expect(sessionRecord(sessionId).lastActivityAt).toBe(4000);
    // Control: the same tunnel at its own host is kept.
    expect((await keepHost(OWNER, host)).status).toBe(200);
    expect(sessionRecord(sessionId).lastActivityAt).not.toBe(4000);
  });

  it('404 NOT_FOUND for no tunnel at the host, or a host that is not a dev host; gates refuse first', async () => {
    const { sessionId, host } = (await startFor(OWNER, OWNED_APP)).json as {
      sessionId: string;
      host: string;
    };
    await call(stopRoute, { body: { grant: await grantFor(OWNER), sessionId } });
    expect(await keepHost(OWNER, host)).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(await keepHost(OWNER, 'example.com')).toMatchObject({ status: 404 });
    const live = (await startFor(OWNER, OWNED_APP)).json as { sessionId: string; host: string };
    ageSession(live.sessionId, 5000);
    devTunnelFlagMock.mockResolvedValue(false);
    expect(await keepHost(OWNER, live.host)).toMatchObject({
      status: 403,
      json: { code: 'FORBIDDEN' },
    });
    expect(sessionRecord(live.sessionId).lastActivityAt).toBe(5000);
  });
});

describe('POST dev-tunnel/stop', () => {
  const stop = async (userId: number, sessionId: string) =>
    call(stopRoute, { body: { grant: await grantFor(userId), sessionId } });

  it('ends the grant’s user’s own session: its record, host and credential go', async () => {
    const { json } = await startFor(OWNER, OWNED_APP);
    const sessionId = json!.sessionId as string;
    expect(await stop(OWNER, sessionId)).toMatchObject({ status: 200, json: { stopped: true } });
    expect(sessionRecord(sessionId)).toBeNull();
    expect(store.has(`${PREFIX}:host:${json!.host}`)).toBe(false);
    expect(store.has(`${PREFIX}:user:${OWNER}:${OWNED_APP}`)).toBe(false);
    // Idempotent: a second stop finds nothing.
    expect(await stop(OWNER, sessionId)).toMatchObject({ status: 200, json: { stopped: false } });
  });

  it('answers 503 unavailable, not stopped:false, when the session cannot be read just now', async () => {
    const sessionId = (await startFor(OWNER, OWNED_APP)).json!.sessionId as string;
    // A Redis blip on the session read only: "nothing to close" would tell the runner not to retry
    // while the tunnel is still live.
    redisMock.sysRedis.get.mockImplementation(async (k: string) => {
      if (k.includes(':session:')) throw new Error('redis blip');
      return store.get(k) ?? null;
    });
    expect(await stop(OWNER, sessionId)).toMatchObject({
      status: 503,
      json: { error: 'Could not close the dev tunnel right now', code: 'unavailable' },
    });
    expect(sessionRecord(sessionId)).toMatchObject({ userId: OWNER });
  });

  it('never ends another user’s session', async () => {
    const theirs = (await startFor(OWNER, OWNED_APP)).json!.sessionId as string;
    expect(await stop(OTHER, theirs)).toMatchObject({ status: 200, json: { stopped: false } });
    expect(sessionRecord(theirs)).toMatchObject({ userId: OWNER });
  });
});

/**
 * A start the runner gave up on (its reply ended, the user stopped it, or it timed out) never
 * learned the session id, so it closes the tunnel by the `clientKey` it sent the start with. That
 * must hold whether civitai's start is still running when the stop comes, or has just finished.
 */
describe('a start the runner gave up on, closed by its client key', () => {
  const CLIENT_KEY = 'test-only-client-key-5e1b';
  const sessionKeys = () => [...store.keys()].filter((k) => k.includes(':session:'));
  const startKeyed = async (userId: number, blockId: string, clientKey = CLIENT_KEY) =>
    call(startRoute, {
      body: { grant: await grantFor(userId), blockId, sshPublicKey: SANDBOX_KEY, clientKey },
    });
  const stopKeyed = async (userId: number, clientKey = CLIENT_KEY) =>
    call(stopRoute, { body: { grant: await grantFor(userId), clientKey } });
  /** Holds the next route apply until `release()`, as a slow apply Job does. */
  async function holdApply() {
    const pipeline = await import('~/server/services/blocks/apps-pipeline.service');
    const held: { release?: () => void } = {};
    vi.mocked(pipeline.waitForApplyJob).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          held.release = () => resolve('succeeded');
        })
    );
    return held;
  }

  it('a stop that comes while the start runs: the start closes what it opened, and answers 409', async () => {
    const held = await holdApply();
    const starting = startKeyed(OWNER, OWNED_APP);
    await vi.waitFor(() => expect(held.release).toBeTypeOf('function'));
    // Nothing is open yet, so nothing is stopped now, but the start is marked.
    expect(await stopKeyed(OWNER)).toMatchObject({ status: 200, json: { stopped: false } });
    held.release!();
    expect(await starting).toMatchObject({ status: 409, json: { code: 'cancelled' } });
    expect(sessionKeys()).toEqual([]);
    expect(store.has(`${PREFIX}:user:${OWNER}:${OWNED_APP}`)).toBe(false);
  });

  it('a stop that comes after the start answered closes the tunnel it opened', async () => {
    const { status, json } = await startKeyed(OWNER, OWNED_APP);
    expect(status).toBe(200);
    const sessionId = json!.sessionId as string;
    // Another user's grant with the same key closes nothing of this user's.
    expect(await stopKeyed(OTHER)).toMatchObject({ status: 200, json: { stopped: false } });
    expect(sessionRecord(sessionId)).toMatchObject({ userId: OWNER });
    expect(await stopKeyed(OWNER)).toMatchObject({ status: 200, json: { stopped: true } });
    expect(sessionRecord(sessionId)).toBeNull();
    expect(store.has(`${PREFIX}:host:${json!.host}`)).toBe(false);
  });

  it('a start that comes after its stop opens nothing, and leaves the user’s current tunnel', async () => {
    const current = (await startFor(OWNER, OWNED_APP)).json!.sessionId as string;
    expect(await stopKeyed(OWNER)).toMatchObject({ status: 200, json: { stopped: false } });
    expect(await startKeyed(OWNER, OWNED_APP)).toMatchObject({
      status: 409,
      json: { code: 'cancelled' },
    });
    expect(sessionKeys()).toEqual([`${PREFIX}:session:${current}`]);
    // Control: the same start under another key opens (and replaces the current tunnel).
    expect((await startKeyed(OWNER, OWNED_APP, 'test-only-client-key-9a07')).status).toBe(200);
  });

  it('a start answers by 185 s however long its route takes, and what it opens later is closed', async () => {
    const held = await holdApply();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let answer: Awaited<ReturnType<typeof call>> | undefined;
      void startKeyed(OWNER, OWNED_APP).then((a) => (answer = a));
      // The grant's check runs on Node's crypto, which no fake timer advances: wait, on real time
      // (`vi.waitFor`), until the start sits in its route apply. Its deadline is set by then.
      await vi.waitFor(() => expect(held.release).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(184_000);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      // The runner waits longer than this (apps/assistant-runner `START_TIMEOUT_MS`).
      expect(answer).toMatchObject({ status: 503, json: { code: 'unavailable' } });
      held.release!();
      // Done once the late start has closed what it opened: its one teardown.
      await vi.waitFor(() => expect(recordDevTunnelTeardown).toHaveBeenCalledTimes(1));
      expect(sessionKeys()).toEqual([]);
      expect(store.has(`${PREFIX}:user:${OWNER}:${OWNED_APP}`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late start the deadline cancelled leaves a newer start’s tunnel listed, and the ban index too', async () => {
    // A is held in its route apply past the deadline, which cancels it. B then opens the same app
    // and owns the (user, app) pointer. Then A's apply finishes, and A closes what it opened: it
    // must not take B's pointer, or B's ban-index entry, with it. Otherwise B's live tunnel is
    // invisible to a ban (its token is not revoked) and to the next start (it is not replaced).
    const pointer = `${PREFIX}:user:${OWNER}:${OWNED_APP}`;
    const banIndex = `${PREFIX}:user-index:${OWNER}`;
    const held = await holdApply();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let lateA: Awaited<ReturnType<typeof call>> | undefined;
      void startKeyed(OWNER, OWNED_APP).then((a) => (lateA = a));
      await vi.waitFor(() => expect(held.release).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(185_000);
      expect(lateA).toMatchObject({ status: 503, json: { code: 'unavailable' } });

      const b = await startKeyed(OWNER, OWNED_APP, 'test-only-client-key-b3c8');
      expect(b.status).toBe(200);
      const sessionB = b.json!.sessionId as string;
      expect(store.get(pointer)).toBe(sessionB);
      expect(lua.set(banIndex)).toEqual([OWNED_APP]);

      held.release!();
      // Done once A has closed what it opened: its one teardown.
      await vi.waitFor(() => expect(recordDevTunnelTeardown).toHaveBeenCalledTimes(1));
      // A's own keys are gone: only B's session (and its host) is left.
      expect(sessionKeys()).toEqual([`${PREFIX}:session:${sessionB}`]);
      expect([...store.keys()].filter((k) => k.includes(':host:'))).toEqual([
        `${PREFIX}:host:${b.json!.host}`,
      ]);
      // B is still the app's tunnel, and still in the index a ban enumerates.
      expect(store.get(pointer), 'B dropped off its (user, app) pointer').toBe(sessionB);
      expect(lua.set(banIndex), 'B dropped out of the ban index').toEqual([OWNED_APP]);
      expect(lua.errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A is held in its route apply while B opens the same app and takes the (user, app) pointer.
   * Then A finishes, and something goes wrong exactly where A decides whether it was cancelled:
   * the pointer and the ban-index entry must still be B's. `onPointerWrite` runs just before the
   * first write that names the pointer from then on (a plain SET, or a script), so it lands
   * between a cancel check and the write wherever the start makes them.
   */
  async function raceLateStart({
    whileHeld,
    onPointerWrite,
    failCancelCheck,
  }: {
    /** Runs after B has opened, while A is still held. */
    whileHeld?: () => Promise<void>;
    onPointerWrite?: () => Promise<void>;
    /** A key whose read (or any script naming it) fails once A is released. */
    failCancelCheck?: string;
  }): Promise<{ lateA: Awaited<ReturnType<typeof call>>; sessionB: string }> {
    const pointer = `${PREFIX}:user:${OWNER}:${OWNED_APP}`;
    const sys = redisMock.sysRedis;
    const baseSet = sys.set.getMockImplementation()!;
    const baseGet = sys.get.getMockImplementation()!;
    const baseEval = sys.eval.getMockImplementation()!;
    let armed = false;
    const before = async (keys: string[]) => {
      if (!armed || !keys.includes(pointer)) return;
      armed = false;
      await onPointerWrite?.();
    };
    sys.set.mockImplementation(async (k: string, v: string, opts?: Record<string, unknown>) => {
      await before([k]);
      return baseSet(k, v, opts);
    });
    sys.get.mockImplementation(async (k: string) => {
      if (failCancelCheck && armed && k === failCancelCheck) throw new Error('redis blip');
      return baseGet(k);
    });
    sys.eval.mockImplementation(
      async (script: string, opts: { keys: string[]; arguments: string[] }) => {
        if (failCancelCheck && armed && opts.keys.includes(failCancelCheck))
          throw new Error('redis blip');
        await before(opts.keys);
        return baseEval(script, opts);
      }
    );

    const held = await holdApply();
    const startingA = startKeyed(OWNER, OWNED_APP);
    await vi.waitFor(() => expect(held.release).toBeTypeOf('function'));
    const b = await startKeyed(OWNER, OWNED_APP, 'test-only-client-key-b3c8');
    expect(b.status).toBe(200);
    expect(store.get(pointer)).toBe(b.json!.sessionId);
    await whileHeld?.();
    armed = true;
    held.release!();
    return { lateA: await startingA, sessionB: b.json!.sessionId as string };
  }

  function expectBStillListed(sessionB: string) {
    expect(
      store.get(`${PREFIX}:user:${OWNER}:${OWNED_APP}`),
      'B dropped off its (user, app) pointer'
    ).toBe(sessionB);
    expect(lua.set(`${PREFIX}:user-index:${OWNER}`), 'B dropped out of the ban index').toEqual([
      OWNED_APP,
    ]);
    expect(sessionKeys()).toEqual([`${PREFIX}:session:${sessionB}`]);
  }

  it('a cancel landing between a late start’s cancel check and its pointer write leaves B listed', async () => {
    const { lateA, sessionB } = await raceLateStart({
      onPointerWrite: async () => {
        // The runner gives up on A right then: the cancel finds A's session and closes it.
        expect(await stopKeyed(OWNER)).toMatchObject({ status: 200, json: { stopped: true } });
      },
    });
    expect(lateA.status).not.toBe(200);
    expectBStillListed(sessionB);
  });

  it('a cancel check that errors, after a cancel landed, never takes a newer start’s pointer', async () => {
    // The cancel lands while A is still in its apply (nothing of A's to close yet), and the read
    // of its mark then fails: A must not go on as if nobody had cancelled it.
    const { lateA, sessionB } = await raceLateStart({
      whileHeld: async () => {
        expect(await stopKeyed(OWNER)).toMatchObject({ status: 200, json: { stopped: false } });
      },
      failCancelCheck: `${PREFIX}:client-cancelled:${OWNER}:${CLIENT_KEY}`,
    });
    expect(lateA.status).not.toBe(200);
    expectBStillListed(sessionB);
  });

  it('the runner waits for a start longer than civitai takes to answer one', async () => {
    const { RUNNER_DEV_TUNNEL_START_DEADLINE_MS } = await import(
      '~/server/services/blocks/dev-tunnel.service'
    );
    const root = path.resolve(__dirname, '../../..');
    const runner = readFileSync(
      path.join(root, 'apps/assistant-runner/src/app-assistant/dev-tunnel.ts'),
      'utf8'
    );
    // The runner imports nothing of civitai's, so it mirrors the number; the two must agree.
    const mirrored = /export const CIVITAI_START_DEADLINE_MS = ([\d_]+);/.exec(runner)?.[1];
    expect(Number(mirrored?.replace(/_/g, ''))).toBe(RUNNER_DEV_TUNNEL_START_DEADLINE_MS);
    const margin = /export const START_TIMEOUT_MS = CIVITAI_START_DEADLINE_MS \+ ([\d_]+);/.exec(
      runner
    )?.[1];
    expect(Number(margin?.replace(/_/g, ''))).toBeGreaterThanOrEqual(10_000);
  });
});
