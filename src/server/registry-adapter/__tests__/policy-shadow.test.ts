import * as grpc from '@grpc/grpc-js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowConnection } from '~/__tests__/network-guard';
import type { Audience } from '~/server/registry-adapter/audience';
import {
  ANONYMOUS_AUDIENCE,
  SERVICE_AUDIENCE,
  audienceForUser,
} from '~/server/registry-adapter/audience';
import type { Principal, VerifyToken } from '~/server/registry-adapter/auth';
import { REGISTRY_SERVICE, createGrpcServer, listenGrpc } from '~/server/registry-adapter/grpc';
import type { PolicyShadow, ShadowResult } from '~/server/registry-adapter/policy-shadow';
import {
  compareDecisions,
  createMetricsServer,
  createPolicyShadow,
  createShadowMetrics,
  ourDecision,
  policyRequest,
  policyShadowFromEnv,
  runShadow,
  startPolicyShadow,
  userIdOfSubject,
} from '~/server/registry-adapter/policy-shadow';
import type { Adapter, AdapterContext, Entity } from '~/server/registry-adapter/protocol';
import type { ServeOptions } from '~/server/registry-adapter/serve';
import { createRegistryServer } from '~/server/registry-adapter/serve';

const APPS = 'urn:schema:apps.civitai.com:app@v1';
const one: Entity = {
  urn: 'urn:apps.civitai.com:app/orbit-notes',
  schemas: [APPS],
  rev: 'rev-7a',
  body: { slug: 'orbit-notes', contentRating: 'g' },
};

/** A source that records the audience each subscription is decided with, then ends. */
function recordingAdapter(seen: (Audience | undefined)[]): Adapter {
  return {
    namespace: 'apps.civitai.com',
    serves: (schema) => schema === APPS,
    snapshot: async (_schema: string, ctx: AdapterContext) => {
      seen.push(ctx.audience);
      // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
      return { cursor: 'c1.snapshot-cursor', entities: [one] };
    },
    changes: async () =>
      (async function* () {
        // No changes: the stream ends after the snapshot.
      })(),
  };
}

const FULL_USER = { showNsfw: true, browsingLevel: 31 };
const verifyToken: VerifyToken = async (token) =>
  token === 'good-token'
    ? {
        subject: 'user:4711/client:9',
        userId: 4711,
        clientId: '9',
        scope: 0n,
        actor: null,
        user: FULL_USER,
        expiresAt: null,
      }
    : null;

/** What the service answers for a full user from a country nothing holds: the adapter's decision. */
const AGREEING = {
  ratings: ['g', 'pg', 'pg13', 'r', 'x', 'xxx'],
  unknownRating: true,
  browsingLevel: 31,
  regionHold: 'none',
  reason: 'user-settings',
  context: 'registry-subscription',
  policyVersion: 'abc123abc123',
  fallback: false,
};

const servers: Server[] = [];
const grpcServers: grpc.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of grpcServers.splice(0)) s.forceShutdown();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

type Mode = 'agree' | 'disagree' | 'timeout' | 'fallback';

/** A stand-in content-policy service: records each request body, answers by `mode`. */
async function fakeService(mode: Mode) {
  const bodies: unknown[] = [];
  const port = await listen(
    createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        if (mode === 'timeout') return; // never answers
        const json = (status: number, body: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (mode === 'agree') return json(200, AGREEING);
        if (mode === 'disagree') return json(200, { ...AGREEING, ratings: ['g', 'pg', 'pg13'] });
        return json(503, {
          ...AGREEING,
          ratings: ['g', 'pg', 'pg13'],
          fallback: true,
          reason: 'error',
        });
      });
    })
  );
  return { url: `http://127.0.0.1:${port}`, bodies };
}

/** A shadow whose comparisons the test can await, and its counter and log. */
function observedShadow(url: string, timeoutMs = 2_000) {
  const { counter, registry } = createShadowMetrics();
  const logged: string[] = [];
  const inner = createPolicyShadow({ url, timeoutMs, counter, log: (l) => logged.push(l) });
  const runs: Promise<ShadowResult>[] = [];
  // Set the moment a comparison resolves, attached as it starts: a subscription that waited for it
  // would end only after this is set.
  const settled: boolean[] = [];
  const shadow: PolicyShadow = (s) => {
    const p = inner(s);
    const i = runs.push(p) - 1;
    settled[i] = false;
    void p.then(() => (settled[i] = true));
    return p;
  };
  return { shadow, runs, settled, logged, counter, registry };
}

/** One HTTP subscription; the audience it was decided with and its full response text. */
async function subscribeHttp(opts: ServeOptions, headers: Record<string, string>) {
  const seen: (Audience | undefined)[] = [];
  const server = createRegistryServer(recordingAdapter(seen), { verifyToken, ...opts });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/subscribe?schema=${encodeURIComponent(APPS)}`, {
    headers,
  });
  const text = (await res.text()).replace(/b1\.[0-9a-f]{24}\./g, '');
  return { status: res.status, text, audience: seen[0] };
}

const SIGNED_IN = { authorization: 'Bearer good-token', 'cf-ipcountry': 'NL' };

describe('🔴 shadow mode never changes the live decision (HTTP)', () => {
  it.each<[Mode | 'down', ShadowResult]>([
    ['agree', 'agree'],
    ['disagree', 'disagree'],
    ['fallback', 'error'],
    ['timeout', 'timeout'],
    ['down', 'error'],
  ])(
    'service %s: same audience and same stream as with no shadow, counted %s',
    async (mode, want) => {
      const baseline = await subscribeHttp({}, SIGNED_IN);
      // Nothing listens on port 1: the connection is refused, as for a service that is down.
      if (mode === 'down') allowConnection('127.0.0.1', 1);
      const url = mode === 'down' ? 'http://127.0.0.1:1' : (await fakeService(mode as Mode)).url;
      const o = observedShadow(url, mode === 'timeout' ? 100 : 2_000);
      const shadowed = await subscribeHttp({ policyShadow: o.shadow }, SIGNED_IN);

      expect(shadowed.status).toBe(200);
      expect(shadowed.text).toBe(baseline.text);
      expect(shadowed.audience).toEqual(baseline.audience);
      expect(shadowed.audience).toEqual(audienceForUser(FULL_USER));
      expect(o.runs).toHaveLength(1);
      expect(await o.runs[0]).toBe(want);
      expect((await o.counter.get()).values.find((v) => v.labels.result === want)?.value).toBe(1);
    }
  );

  it('a comparison the service never answers does not hold the subscription: the stream ends first', async () => {
    const { url } = await fakeService('timeout');
    const o = observedShadow(url, 400);
    const shadowed = await subscribeHttp({ policyShadow: o.shadow }, SIGNED_IN);
    expect(shadowed.status).toBe(200);
    expect(o.settled).toEqual([false]);
    expect(await o.runs[0]).toBe('timeout');
    expect(o.settled).toEqual([true]);
  });

  it('a shadow that throws, synchronously or not, leaves the subscription alone', async () => {
    const baseline = await subscribeHttp({}, SIGNED_IN);
    for (const shadow of [
      (() => {
        throw new Error('sync');
      }) as unknown as PolicyShadow,
      (() => Promise.reject(new Error('async'))) as unknown as PolicyShadow,
    ]) {
      const shadowed = await subscribeHttp({ policyShadow: shadow }, SIGNED_IN);
      expect(shadowed.text).toBe(baseline.text);
      expect(shadowed.audience).toEqual(baseline.audience);
    }
  });

  it('sends the viewer and the edge values, nothing else', async () => {
    const svc = await fakeService('agree');
    const o = observedShadow(svc.url);
    await subscribeHttp(
      { policyShadow: o.shadow },
      { ...SIGNED_IN, 'cf-region-code': 'NH', 'x-isuk': '0', 'cf-connecting-ip': '192.0.2.7' }
    );
    await o.runs[0];
    expect(svc.bodies).toEqual([
      { context: 'registry-subscription', userId: 4711, country: 'NL', region: 'NH', isUk: '0' },
    ]);
  });

  it('anonymous: no user id; a held region compares as held', async () => {
    const svc = await fakeService('agree');
    const o = observedShadow(svc.url);
    const res = await subscribeHttp({ policyShadow: o.shadow }, { 'cf-ipcountry': 'XX' });
    expect(res.audience).toEqual(ANONYMOUS_AUDIENCE);
    // The fake answers a full, unheld decision: the anonymous, held subscription disagrees on ratings.
    expect(await o.runs[0]).toBe('disagree');
    expect(svc.bodies).toEqual([{ context: 'registry-subscription', country: 'XX' }]);
    expect(o.logged).toEqual([
      'registry-adapter: policy shadow disagree field=ratings ours=g,pg,pg13 ' +
        'service=g,pg,pg13,r,x,xxx context=registry-subscription',
    ]);
  });

  it('the disagreement line names no user, token or address', async () => {
    const svc = await fakeService('disagree');
    const o = observedShadow(svc.url);
    await subscribeHttp(
      { policyShadow: o.shadow },
      { ...SIGNED_IN, 'cf-connecting-ip': '192.0.2.7' }
    );
    await o.runs[0];
    expect(o.logged).toEqual([
      'registry-adapter: policy shadow disagree field=ratings ours=g,pg,pg13,r,x,xxx ' +
        'service=g,pg,pg13 context=registry-subscription',
    ]);
    for (const secret of ['4711', 'good-token', '192.0.2.7', '127.0.0.1'])
      expect(o.logged[0]).not.toContain(secret);
  });

  it('a refused token is never compared', async () => {
    const svc = await fakeService('agree');
    const o = observedShadow(svc.url);
    const res = await subscribeHttp(
      { policyShadow: o.shadow },
      { authorization: 'Bearer bad-token', 'cf-ipcountry': 'NL' }
    );
    expect(res.status).toBe(401);
    expect(o.runs).toHaveLength(0);
  });
});

describe('🔴 shadow mode never changes the live decision (gRPC)', () => {
  async function subscribeGrpc(policyShadow?: PolicyShadow) {
    const seen: (Audience | undefined)[] = [];
    const server = createGrpcServer(recordingAdapter(seen), { verifyToken, policyShadow });
    grpcServers.push(server);
    const port = await listenGrpc(server, 0);
    const Client = grpc.makeGenericClientConstructor(REGISTRY_SERVICE, 'Registry');
    const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const metadata = new grpc.Metadata();
    metadata.set('authorization', 'Bearer good-token');
    metadata.set('cf-ipcountry', 'NL');
    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const call = (
        client as unknown as Record<
          string,
          (...args: [unknown, grpc.Metadata]) => grpc.ClientReadableStream<unknown>
        >
      ).Subscribe.call(client, { schema: APPS, cursor: '', urns: [], filter: '' }, metadata);
      call.on('data', (e) => events.push(e));
      call.on('end', () => resolve());
      call.on('error', reject);
    });
    client.close();
    return { audience: seen[0], events };
  }

  it.each<[Mode, ShadowResult]>([
    ['agree', 'agree'],
    ['disagree', 'disagree'],
    ['timeout', 'timeout'],
  ])('service %s: same audience and events as with no shadow', async (mode, want) => {
    const baseline = await subscribeGrpc();
    const o = observedShadow((await fakeService(mode)).url, 100);
    const shadowed = await subscribeGrpc(o.shadow);
    expect(shadowed.audience).toEqual(baseline.audience);
    expect(shadowed.audience).toEqual(audienceForUser(FULL_USER));
    expect(shadowed.events).toEqual(baseline.events);
    expect(await o.runs[0]).toBe(want);
  });
});

describe('the comparison', () => {
  const principal = (subject: string | null, audience: Audience): Principal => ({
    subject,
    token: null,
    audience,
    expiresAt: null,
    recheck: null,
  });

  it('reads the user id from the subject', () => {
    expect(userIdOfSubject('user:4711/client:9')).toBe(4711);
    expect(userIdOfSubject(null)).toBeUndefined();
    expect(userIdOfSubject('client:9')).toBeNull();
    expect(userIdOfSubject('user:12345678901/client:9')).toBeNull();
  });

  it('a subject without a user id is an error, not a guess', async () => {
    const { counter } = createShadowMetrics();
    const shadow = createPolicyShadow({
      url: 'http://127.0.0.1:1',
      counter,
      fetch: () => {
        throw new Error('must not be called');
      },
    });
    expect(
      await shadow({
        origin: { headers: {} },
        principal: principal('client:9', audienceForUser(FULL_USER)),
        held: false,
      })
    ).toBe('error');
  });

  it('🔴 a service principal is not compared: counted service, nothing sent, never error', async () => {
    const { registry, counter } = createShadowMetrics();
    const calls: unknown[] = [];
    const shadow = createPolicyShadow({
      url: 'http://127.0.0.1:1',
      counter,
      fetch: (async (...args: unknown[]) => {
        calls.push(args);
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    const result = await shadow({
      origin: { headers: { 'cf-ipcountry': 'GB' } },
      principal: {
        ...principal('service:7e3a1c55-2b4d-4f60-9a8e-1c2d3e4f5a6b', SERVICE_AUDIENCE),
        service: true,
      },
      held: true,
    });
    expect(result).toBe('service');
    expect(calls).toEqual([]);
    const text = await registry.metrics();
    expect(text).toContain('registry_adapter_policy_shadow_total{result="service"} 1');
    expect(text).toContain('registry_adapter_policy_shadow_total{result="error"} 0');
  });

  it('sends a repeated header as JavaScript reads it, and meta only when trusted', () => {
    const p = principal('user:5/client:1', ANONYMOUS_AUDIENCE);
    const origin = {
      headers: { 'cf-ipcountry': ['GB', 'FR'], 'cf-region-code': 'ENG' },
      meta: { country: 'DE' },
    };
    expect(policyRequest(origin, p)).toEqual({
      context: 'registry-subscription',
      userId: 5,
      country: 'GB,FR',
      region: 'ENG',
    });
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    expect(policyRequest(origin, p)?.country).toBe('DE');
  });

  it('ourDecision is the audience: anonymous, a full user, a held user', () => {
    expect(ourDecision(principal(null, ANONYMOUS_AUDIENCE), true)).toEqual({
      ratings: ['g', 'pg', 'pg13'],
      unknownRating: false,
      held: true,
    });
    // A user whose level carries R, X and XXX: every rating, and an unknown one.
    expect(ourDecision(principal('user:1/client:1', audienceForUser(FULL_USER)), false)).toEqual({
      ratings: ['g', 'pg', 'pg13', 'r', 'x', 'xxx'],
      unknownRating: true,
      held: false,
    });
    // The audience carries its own XXX bit: R+X without XXX reads neither xxx nor an unknown rating,
    // and XXX alone reads xxx but not R or X. These are the answers the service gives for the same
    // levels (its registry-subscription vectors), so the shadow compares like with like.
    const rx = audienceForUser({ showNsfw: true, browsingLevel: 12 });
    expect(rx.key).toBe('mrx');
    expect(ourDecision(principal('user:1/client:1', rx), false)).toEqual({
      ratings: ['g', 'pg', 'pg13', 'r', 'x'],
      unknownRating: false,
      held: false,
    });
    const xxxOnly = audienceForUser({ showNsfw: true, browsingLevel: 16 });
    expect(xxxOnly.key).toBe('m+xxx');
    expect(ourDecision(principal('user:1/client:1', xxxOnly), false)).toEqual({
      ratings: ['g', 'pg', 'pg13', 'xxx'],
      unknownRating: false,
      held: false,
    });
    expect(
      ourDecision(
        principal('user:1/client:1', audienceForUser(FULL_USER, { regionRestricted: true })),
        true
      ).ratings
    ).toEqual(['g', 'pg', 'pg13']);
  });

  it('names the first field that differs', () => {
    const ours = { ratings: ['g', 'pg', 'pg13'], unknownRating: false, held: true };
    const same = { ratings: ['g', 'pg', 'pg13'], unknownRating: false, regionHold: 'restricted' };
    expect(compareDecisions(ours, same)).toBeNull();
    expect(compareDecisions(ours, { ...same, regionHold: 'blocked' })).toBeNull();
    expect(compareDecisions(ours, { ...same, ratings: ['g', 'pg'] })).toEqual({
      field: 'ratings',
      ours: 'g,pg,pg13',
      service: 'g,pg',
    });
    expect(compareDecisions(ours, { ...same, unknownRating: true })).toEqual({
      field: 'unknownRating',
      ours: 'false',
      service: 'true',
    });
    expect(compareDecisions(ours, { ...same, regionHold: 'none' })).toEqual({
      field: 'regionHold',
      ours: 'held',
      service: 'none',
    });
    expect(compareDecisions({ ...ours, ratings: [] }, { ...same, ratings: [] })).toBeNull();
  });

  it('a body that is not a decision is an error', async () => {
    const { counter } = createShadowMetrics();
    for (const body of [
      {},
      { ratings: 'g' },
      { ratings: [1], unknownRating: true, regionHold: 'x' },
    ]) {
      const shadow = createPolicyShadow({
        url: 'http://content-policy.invalid',
        counter,
        fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
      });
      expect(
        await shadow({
          origin: { headers: {} },
          principal: principal(null, ANONYMOUS_AUDIENCE),
          held: false,
        })
      ).toBe('error');
    }
    const notJson = createPolicyShadow({
      url: 'http://content-policy.invalid',
      counter,
      fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }),
    });
    expect(
      await notJson({
        origin: { headers: {} },
        principal: principal(null, ANONYMOUS_AUDIENCE),
        held: false,
      })
    ).toBe('error');
  });

  it('runShadow without a shadow does nothing', () => {
    expect(() =>
      runShadow(undefined, {
        origin: { headers: {} },
        principal: principal(null, ANONYMOUS_AUDIENCE),
        held: false,
      })
    ).not.toThrow();
  });
});

describe('the in-flight cap', () => {
  const p = (): Principal => ({
    subject: null,
    token: null,
    audience: ANONYMOUS_AUDIENCE,
    expiresAt: null,
    recheck: null,
  });
  const run = (shadow: PolicyShadow) =>
    shadow({ origin: { headers: {} }, principal: p(), held: false });

  it('past the cap a comparison is not sent and is counted dropped; a freed slot sends again', async () => {
    const { counter } = createShadowMetrics();
    const pending: (() => void)[] = [];
    let sent = 0;
    // A service that answers only when the test lets it, and never by itself (a black hole).
    const fetchImpl = (() => {
      sent++;
      return new Promise<Response>((resolve) =>
        pending.push(() => resolve(new Response(JSON.stringify(AGREEING), { status: 200 })))
      );
    }) as unknown as typeof fetch;
    const shadow = createPolicyShadow({
      url: 'http://content-policy.invalid',
      counter,
      fetch: fetchImpl,
      maxInFlight: 2,
    });
    const first = run(shadow);
    const second = run(shadow);
    const third = run(shadow);
    // Checked before awaiting: a third request sent to the black hole would never come back.
    expect(sent).toBe(2);
    expect(await third).toBe('dropped');
    const value = async (r: string) =>
      (await counter.get()).values.find((v) => v.labels.result === r)?.value;
    expect(await value('dropped')).toBe(1);
    pending.splice(0).forEach((answer) => answer());
    await Promise.all([first, second]);
    // Both slots are free again: the next one is sent, not dropped.
    const fourth = run(shadow);
    expect(sent).toBe(3);
    pending.splice(0).forEach((answer) => answer());
    await fourth;
    expect(await value('dropped')).toBe(1);
  });
});

describe('🔴 a shadow misconfiguration never stops the adapter', () => {
  it.each([
    [{ REGISTRY_ADAPTER_POLICY_URL: 'not a url' }, 'REGISTRY_ADAPTER_POLICY_URL is not a URL'],
    [
      {
        REGISTRY_ADAPTER_POLICY_URL: 'http://cp.invalid',
        REGISTRY_ADAPTER_POLICY_TIMEOUT_MS: '-1',
      },
      'REGISTRY_ADAPTER_POLICY_TIMEOUT_MS must be a positive integer',
    ],
    [
      { REGISTRY_ADAPTER_POLICY_URL: 'http://cp.invalid', REGISTRY_ADAPTER_METRICS_PORT: 'x' },
      'REGISTRY_ADAPTER_METRICS_PORT must be a positive integer',
    ],
  ])('%j: one warning, shadow off, no throw', (env, message) => {
    const warned: string[] = [];
    let started: ReturnType<typeof startPolicyShadow> | undefined;
    expect(() => {
      started = startPolicyShadow(env, { warn: (l) => warned.push(l), log: () => undefined });
    }).not.toThrow();
    expect(started).toEqual({});
    expect(warned).toEqual([`registry-adapter: WARNING: policy shadow off: ${message}`]);
  });

  it('unset: nothing, and nothing logged', () => {
    const lines: string[] = [];
    expect(
      startPolicyShadow({}, { warn: (l) => lines.push(l), log: (l) => lines.push(l) })
    ).toEqual({});
    expect(lines).toEqual([]);
  });

  it('a metrics port already in use is a warning; the comparison still runs', async () => {
    const port = await listen(createServer());
    const warned: string[] = [];
    const started = startPolicyShadow(
      {
        REGISTRY_ADAPTER_POLICY_URL: 'http://127.0.0.1:1',
        REGISTRY_ADAPTER_METRICS_PORT: String(port),
      },
      { warn: (l) => warned.push(l), log: () => undefined }
    );
    expect(started.shadow).toBeTypeOf('function');
    await new Promise<void>((resolve) => started.server!.once('error', () => resolve()));
    expect(warned).toEqual([
      `registry-adapter: WARNING: policy shadow /metrics not served on :${port} (EADDRINUSE); the comparison still runs`,
    ]);
    expect(started.server!.listening).toBe(false);
  });

  it('positive control: a free port serves /metrics', async () => {
    const free = await listen(createServer());
    servers.pop()!.close();
    const logged: string[] = [];
    const started = startPolicyShadow(
      {
        REGISTRY_ADAPTER_POLICY_URL: 'http://127.0.0.1:1',
        REGISTRY_ADAPTER_METRICS_PORT: String(free),
      },
      { warn: (l) => logged.push(l), log: (l) => logged.push(l) }
    );
    servers.push(started.server!);
    await new Promise<void>((resolve) => started.server!.once('listening', () => resolve()));
    expect(logged).toEqual([`registry-adapter: policy shadow on; /metrics on :${free}`]);
    expect((await fetch(`http://127.0.0.1:${free}/metrics`)).status).toBe(200);
  });
});

describe('configuration and metrics', () => {
  it('is off unless REGISTRY_ADAPTER_POLICY_URL is set', () => {
    expect(policyShadowFromEnv({})).toBeNull();
    expect(policyShadowFromEnv({ REGISTRY_ADAPTER_POLICY_URL: '' })).toBeNull();
    expect(policyShadowFromEnv({ REGISTRY_ADAPTER_POLICY_URL: 'http://cp.invalid:8080' })).toEqual({
      url: 'http://cp.invalid:8080',
      timeoutMs: 250,
      metricsPort: 7132,
    });
    expect(
      policyShadowFromEnv({
        REGISTRY_ADAPTER_POLICY_URL: 'https://cp.invalid',
        REGISTRY_ADAPTER_POLICY_TIMEOUT_MS: '80',
        REGISTRY_ADAPTER_METRICS_PORT: '9464',
      })
    ).toEqual({ url: 'https://cp.invalid', timeoutMs: 80, metricsPort: 9464 });
  });

  it.each([
    [{ REGISTRY_ADAPTER_POLICY_URL: 'not a url' }, 'is not a URL'],
    [{ REGISTRY_ADAPTER_POLICY_URL: 'ftp://cp.invalid' }, 'must be http or https'],
    [
      { REGISTRY_ADAPTER_POLICY_URL: 'http://cp.invalid', REGISTRY_ADAPTER_POLICY_TIMEOUT_MS: '0' },
      'REGISTRY_ADAPTER_POLICY_TIMEOUT_MS must be a positive integer',
    ],
    [
      { REGISTRY_ADAPTER_POLICY_URL: 'http://cp.invalid', REGISTRY_ADAPTER_METRICS_PORT: 'x' },
      'REGISTRY_ADAPTER_METRICS_PORT must be a positive integer',
    ],
  ])('refuses %j', (env, message) => {
    expect(() => policyShadowFromEnv(env)).toThrow(message);
  });

  it('serves the counter, every result from zero, on /metrics only', async () => {
    const { registry, counter } = createShadowMetrics();
    counter.inc({ result: 'disagree' });
    const port = await listen(createMetricsServer(registry));
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('registry_adapter_policy_shadow_total{result="agree"} 0');
    expect(text).toContain('registry_adapter_policy_shadow_total{result="disagree"} 1');
    expect(text).toContain('registry_adapter_policy_shadow_total{result="error"} 0');
    expect(text).toContain('registry_adapter_policy_shadow_total{result="timeout"} 0');
    expect(text).toContain('registry_adapter_policy_shadow_total{result="service"} 0');
    expect((await fetch(`http://127.0.0.1:${port}/subscribe`)).status).toBe(404);
  });
});
