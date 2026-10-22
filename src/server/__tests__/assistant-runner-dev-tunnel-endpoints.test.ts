import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
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
  sys.eval.mockImplementation(async () => 1);
  sys.sRem.mockImplementation(async () => 1);
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
