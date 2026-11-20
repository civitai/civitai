import * as grpc from '@grpc/grpc-js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Counter } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { allowConnection } from '~/__tests__/network-guard';
import type { Audience } from '~/server/registry-adapter/audience';
import {
  ANONYMOUS_AUDIENCE,
  SERVICE_AUDIENCE,
  audienceForUser,
  audienceOf,
} from '~/server/registry-adapter/audience';
import type { VerifyToken } from '~/server/registry-adapter/auth';
import { authenticate, watchPrincipal } from '~/server/registry-adapter/auth';
import { REGISTRY_SERVICE, createGrpcServer, listenGrpc } from '~/server/registry-adapter/grpc';
import type { PolicyEnforcer } from '~/server/registry-adapter/policy-enforce';
import {
  compareWidth,
  createEnforceMetrics,
  createPolicyEnforcer,
  serviceAudience,
  startPolicy,
} from '~/server/registry-adapter/policy-enforce';
import {
  createPolicyComparison,
  createShadowMetrics,
  ourDecision,
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

/** A source that records the audience each subscription is streamed, then ends. */
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

/** A user whose own settings read every rating: locally `mrx+xxx`, never the SFW `m`. */
const FULL_USER = { showNsfw: true, browsingLevel: 31 };
const LOCAL = audienceForUser(FULL_USER);
/** A user whose settings read R but not X or XXX (PG | PG-13 | R): locally `mr`. */
const R_USER = { showNsfw: true, browsingLevel: 1 | 2 | 4 };
const verifyToken: VerifyToken = async (token) => {
  if (token === 'user-token')
    return {
      subject: 'user:4711/client:9',
      userId: 4711,
      clientId: '9',
      scope: 0n,
      actor: null,
      user: FULL_USER,
      expiresAt: null,
    };
  if (token === 'r-user-token')
    return {
      subject: 'user:4712/client:9',
      userId: 4712,
      clientId: '9',
      scope: 0n,
      actor: null,
      user: R_USER,
      expiresAt: null,
    };
  if (token === 'service-token')
    return {
      subject: 'service:7e3a1c55/client:7e3a1c55',
      userId: null,
      clientId: '7e3a1c55',
      scope: 0n,
      actor: null,
      service: true,
      expiresAt: null,
    };
  return null;
};

/** The service's answer for FULL_USER from a country nothing holds: the adapter's own decision. */
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
/** A decision that differs: R only (`mr`), an audience that is neither the local one nor SFW. */
const DISAGREEING = { ...AGREEING, ratings: ['g', 'pg', 'pg13', 'r'], unknownRating: false };

const servers: Server[] = [];
const grpcServers: grpc.Server[] = [];
afterEach(async () => {
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

type Mode =
  | 'agree'
  | 'disagree'
  | 'timeout'
  | 'fallback'
  | 'malformed'
  | 'unexpressible'
  | 'http'
  | 'drops-hold'
  | 'region-only';

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
        if (mode === 'disagree') return json(200, DISAGREEING);
        if (mode === 'malformed') return json(200, { ratings: 'g' });
        // A decision no audience can express: PG-13 withheld.
        if (mode === 'unexpressible') return json(200, { ...AGREEING, ratings: ['g', 'pg', 'r'] });
        if (mode === 'http') return json(500, { error: 'boom' });
        // The SFW ratings, but no region hold: drops a hold this source applied.
        if (mode === 'drops-hold')
          return json(200, { ...AGREEING, ratings: ['g', 'pg', 'pg13'], unknownRating: false });
        // The same ratings as FULL_USER's, and a region hold this source did not apply.
        if (mode === 'region-only') return json(200, { ...AGREEING, regionHold: 'restricted' });
        return json(503, { ...AGREEING, ratings: ['g', 'pg', 'pg13'], fallback: true });
      });
    })
  );
  return { url: `http://127.0.0.1:${port}`, bodies };
}

/** An enforcer against `url`, with its two counters and its log. */
function observedEnforcer(
  url: string,
  timeoutMs = 2_000,
  outboundSignal?: (ms: number) => AbortSignal | undefined
) {
  const { registry, counter: shadowCounter } = createShadowMetrics();
  const counter = createEnforceMetrics(registry);
  const logged: string[] = [];
  const compare = createPolicyComparison({
    url,
    timeoutMs,
    counter: shadowCounter,
    log: (l) => logged.push(l),
    outboundSignal,
  });
  const enforce = createPolicyEnforcer({
    compare,
    counter,
    waitMs: timeoutMs,
    log: (l) => logged.push(l),
  });
  return { enforce, counter, shadowCounter, registry, logged };
}

const value = async <T extends string>(counter: Counter<T>, labels: Partial<Record<T, string>>) =>
  (await counter.get()).values.find((v) =>
    Object.entries(labels).every(([k, want]) => v.labels[k as T] === want)
  )?.value;

/** One HTTP subscription; the audience it was streamed and its full response text. */
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

const SIGNED_IN = { authorization: 'Bearer user-token', 'cf-ipcountry': 'NL' };

describe('🔴 enforcement is off unless REGISTRY_ADAPTER_POLICY_ENFORCE=1', () => {
  /** startPolicy's wiring, its /metrics on a free port, and a subscription through it. */
  async function throughEnv(extra: Record<string, string>) {
    const svc = await fakeService('disagree');
    // A port that was free a moment ago, for the /metrics server startPolicy opens.
    const free = await listen(createServer());
    servers.pop()!.close();
    const warned: string[] = [];
    const started = startPolicy(
      {
        REGISTRY_ADAPTER_POLICY_URL: svc.url,
        REGISTRY_ADAPTER_METRICS_PORT: String(free),
        ...extra,
      },
      { warn: (l) => warned.push(l), log: () => undefined }
    );
    servers.push(started.server!);
    const res = await subscribeHttp(
      { policyShadow: started.shadow, policyEnforce: started.enforce },
      SIGNED_IN
    );
    return { ...res, started, warned };
  }

  it('default (unset): the stream is byte-identical to one with no policy service at all', async () => {
    const baseline = await subscribeHttp({}, SIGNED_IN);
    const off = await throughEnv({});
    expect(off.started.enforce).toBeUndefined();
    expect(off.status).toBe(200);
    expect(off.text).toBe(baseline.text);
    expect(off.audience).toEqual(LOCAL);
    expect(off.warned).toEqual([]);
  });

  it.each(['0', '', 'true', 'yes', 'on'])('%j is off', async (flag) => {
    const off = await throughEnv({ REGISTRY_ADAPTER_POLICY_ENFORCE: flag });
    expect(off.started.enforce).toBeUndefined();
    expect(off.audience).toEqual(LOCAL);
  });

  it('positive control: "1" streams the service answer through the same wiring', async () => {
    const on = await throughEnv({ REGISTRY_ADAPTER_POLICY_ENFORCE: '1' });
    expect(on.started.enforce).toBeTypeOf('function');
    expect(on.audience?.key).toBe('mr');
  });

  it('"1" without the shadow is one warning, off, never a failed start', () => {
    const warned: string[] = [];
    const started = startPolicy(
      { REGISTRY_ADAPTER_POLICY_ENFORCE: '1' },
      { warn: (l) => warned.push(l), log: () => undefined }
    );
    expect(started.enforce).toBeUndefined();
    expect(warned).toEqual([
      'registry-adapter: WARNING: policy enforce off: the policy shadow is off',
    ]);
  });
});

describe('enforcement on (HTTP)', () => {
  it('service agrees: its answer is streamed, counted service/agree', async () => {
    const svc = await fakeService('agree');
    const o = observedEnforcer(svc.url);
    const res = await subscribeHttp({ policyEnforce: o.enforce }, SIGNED_IN);
    expect(res.status).toBe(200);
    expect(res.audience).toEqual(LOCAL);
    expect(svc.bodies).toHaveLength(1);
    expect(await value(o.counter, { source: 'service', reason: 'agree' })).toBe(1);
    // The shadow series keeps counting from the same, single request.
    expect(await value(o.shadowCounter, { result: 'agree' })).toBe(1);
  });

  it('🔴 service disagrees: its answer is still streamed, counted and logged without the viewer', async () => {
    const svc = await fakeService('disagree');
    const o = observedEnforcer(svc.url);
    const res = await subscribeHttp(
      { policyEnforce: o.enforce },
      { ...SIGNED_IN, 'cf-connecting-ip': '192.0.2.7' }
    );
    expect(res.status).toBe(200);
    expect(res.audience).toEqual({ key: 'mr', allowed: { r: true, x: false, xxx: false } });
    expect(await value(o.counter, { source: 'service', reason: 'disagree' })).toBe(1);
    expect(o.logged).toEqual([
      'registry-adapter: policy shadow disagree field=ratings ours=g,pg,pg13,r,x,xxx ' +
        'service=g,pg,pg13,r context=registry-subscription',
      'registry-adapter: policy enforce disagree applied=service local=mrx+xxx service=mr ' +
        'context=registry-subscription',
    ]);
    for (const line of o.logged)
      for (const secret of ['4711', 'user-token', '192.0.2.7']) expect(line).not.toContain(secret);
  });

  it.each<[Mode | 'down', string]>([
    ['timeout', 'timeout'],
    ['down', 'error'],
    ['http', 'error'],
    ['fallback', 'fallback'],
    ['malformed', 'malformed'],
    ['unexpressible', 'malformed'],
  ])(
    '🔴 service %s: this source’s own answer (not SFW), counted fallback_local/%s',
    async (mode, reason) => {
      const baseline = await subscribeHttp({}, SIGNED_IN);
      if (mode === 'down') allowConnection('127.0.0.1', 1);
      const url = mode === 'down' ? 'http://127.0.0.1:1' : (await fakeService(mode)).url;
      const o = observedEnforcer(url, 300);
      const res = await subscribeHttp({ policyEnforce: o.enforce }, SIGNED_IN);
      expect(res.status).toBe(200);
      expect(res.audience).toEqual(LOCAL);
      expect(res.audience?.key).not.toBe(ANONYMOUS_AUDIENCE.key);
      expect(res.text).toBe(baseline.text);
      expect(await value(o.counter, { source: 'fallback_local', reason })).toBe(1);
      expect(await value(o.counter, { source: 'service', reason: 'agree' })).toBe(0);
    }
  );

  it('🔴 a service that never answers holds the subscription for the timeout only, even with the outbound deadline switched off', async () => {
    const { url } = await fakeService('timeout');
    // `outbound-fetch-timeouts-off` thrown: the repo's deadline is gone.
    const o = observedEnforcer(url, 300, () => undefined);
    const t0 = Date.now();
    const res = await subscribeHttp({ policyEnforce: o.enforce }, SIGNED_IN);
    expect(res.status).toBe(200);
    expect(res.audience).toEqual(LOCAL);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await value(o.counter, { source: 'fallback_local', reason: 'timeout' })).toBe(1);
  }, 10_000);

  it('🔴 a service principal keeps its local audience: never sent, counted local/service', async () => {
    const svc = await fakeService('disagree');
    const o = observedEnforcer(svc.url);
    const res = await subscribeHttp(
      { policyEnforce: o.enforce },
      { authorization: 'Bearer service-token', 'cf-ipcountry': 'NL' }
    );
    expect(res.status).toBe(200);
    expect(res.audience).toEqual(SERVICE_AUDIENCE);
    expect(svc.bodies).toEqual([]);
    expect(await value(o.counter, { source: 'local', reason: 'service' })).toBe(1);
    expect(await value(o.shadowCounter, { result: 'service' })).toBe(1);
  });

  it('🔴 anonymous keeps its local audience and does not wait, still compared, counted local/anonymous', async () => {
    // The fake answers a full, unheld decision: enforced, it would widen the anonymous stream.
    const wide = await fakeService('agree');
    const o = observedEnforcer(wide.url);
    const res = await subscribeHttp({ policyEnforce: o.enforce }, { 'cf-ipcountry': 'NL' });
    expect(res.audience).toEqual(ANONYMOUS_AUDIENCE);
    expect(await value(o.counter, { source: 'local', reason: 'anonymous' })).toBe(1);
    // Compared in the background, as in shadow mode.
    await expect.poll(() => wide.bodies.length).toBe(1);
    await expect.poll(() => value(o.shadowCounter, { result: 'disagree' })).toBe(1);

    const black = await fakeService('timeout');
    const slow = observedEnforcer(black.url, 60_000);
    const t0 = Date.now();
    const quick = await subscribeHttp({ policyEnforce: slow.enforce }, { 'cf-ipcountry': 'NL' });
    expect(quick.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('an enforcer that rejects leaves the subscription its local audience', async () => {
    const broken = (() => Promise.reject(new Error('boom'))) as unknown as PolicyEnforcer;
    const res = await subscribeHttp({ policyEnforce: broken }, SIGNED_IN);
    expect(res.status).toBe(200);
    expect(res.audience).toEqual(LOCAL);
  });
});

describe('🔴 the service never widens a stream', () => {
  it('a wider rating answer keeps the local audience, counted fallback_local/widen and logged', async () => {
    // The fake answers every rating; this user's own settings read R only.
    const svc = await fakeService('agree');
    const o = observedEnforcer(svc.url);
    const headers = { authorization: 'Bearer r-user-token', 'cf-ipcountry': 'NL' };
    const baseline = await subscribeHttp({}, headers);
    expect(baseline.audience?.key).toBe('mr');
    const res = await subscribeHttp({ policyEnforce: o.enforce }, headers);
    expect(res.audience).toEqual(baseline.audience);
    expect(res.text).toBe(baseline.text);
    expect(await value(o.counter, { source: 'fallback_local', reason: 'widen' })).toBe(1);
    expect(await value(o.counter, { source: 'service', reason: 'disagree' })).toBe(0);
    expect(o.logged).toContain(
      'registry-adapter: policy enforce widen applied=local local=mr service=mrx+xxx ' +
        'context=registry-subscription'
    );
  });

  it('an answer that drops the local region hold keeps the local audience, counted fallback_local/widen', async () => {
    const svc = await fakeService('drops-hold');
    const o = observedEnforcer(svc.url);
    // No country: held to SFW here (`request-origin.ts`).
    const headers = { authorization: 'Bearer user-token', 'cf-ipcountry': 'XX' };
    const baseline = await subscribeHttp({}, headers);
    expect(baseline.audience?.key).toBe('m');
    const res = await subscribeHttp({ policyEnforce: o.enforce }, headers);
    expect(res.audience).toEqual(baseline.audience);
    expect(await value(o.counter, { source: 'fallback_local', reason: 'widen' })).toBe(1);
    expect(await value(o.counter, { source: 'service', reason: 'agree' })).toBe(0);
  });

  it('invariant: a narrower answer still applies, counted service/disagree', async () => {
    const svc = await fakeService('disagree');
    const o = observedEnforcer(svc.url);
    const res = await subscribeHttp({ policyEnforce: o.enforce }, SIGNED_IN);
    expect(res.audience?.key).toBe('mr');
    expect(await value(o.counter, { source: 'service', reason: 'disagree' })).toBe(1);
    expect(await value(o.counter, { source: 'fallback_local', reason: 'widen' })).toBe(0);
  });

  it('a hold only the service applies, with the same ratings, is counted service/region_only', async () => {
    const svc = await fakeService('region-only');
    const o = observedEnforcer(svc.url);
    const res = await subscribeHttp({ policyEnforce: o.enforce }, SIGNED_IN);
    expect(res.audience).toEqual(LOCAL);
    expect(await value(o.counter, { source: 'service', reason: 'region_only' })).toBe(1);
    expect(await value(o.counter, { source: 'service', reason: 'disagree' })).toBe(0);
    expect(o.logged).toContain(
      'registry-adapter: policy enforce region_only applied=service local=mrx+xxx ' +
        'service=mrx+xxx/held context=registry-subscription'
    );
  });

  it('invariant: a re-check leaves a service-narrowed stream alone', async () => {
    const svc = await fakeService('disagree');
    const o = observedEnforcer(svc.url);
    const authed = await authenticate('Bearer user-token', verifyToken, {
      regionRestricted: () => false,
    });
    const narrowed = await o.enforce({
      origin: { headers: { 'cf-ipcountry': 'NL' } },
      principal: authed,
      held: false,
    });
    expect(narrowed.audience.key).toBe('mr');
    // The re-check re-applies the local rule to notice a changed setting; the user's settings did
    // not change, so the narrowed stream is not ended as audience-changed.
    expect(await narrowed.recheck!()).toBe('active');
    const ended: string[] = [];
    const stop = watchPrincipal(narrowed, (err) => ended.push(err.code), { recheckMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();
    expect(ended).toEqual([]);
  });
});

describe('compareWidth, the one definition of wider', () => {
  const a = (r: boolean, x: boolean, xxx: boolean) => audienceOf({ r, x, xxx });
  it.each<[string, Audience, boolean, Audience, boolean, string]>([
    ['same', a(true, true, true), false, a(true, true, true), false, 'same'],
    ['fewer ratings', a(true, false, false), false, a(true, true, false), false, 'narrower'],
    ['a rating local lacks', a(true, true, false), false, a(true, false, false), false, 'wider'],
    ['a different set', a(false, true, false), false, a(true, false, false), false, 'wider'],
    ['drops the local hold', a(false, false, false), false, a(false, false, false), true, 'wider'],
    ['adds a hold', a(true, true, true), true, a(true, true, true), false, 'region_only'],
    ['both held', a(false, false, false), true, a(false, false, false), true, 'same'],
    ['narrower and held', a(false, false, false), true, a(true, false, false), false, 'narrower'],
  ])('%s', (_name, sAud, sHeld, lAud, lHeld, want) => {
    expect(compareWidth({ audience: sAud, held: sHeld }, { audience: lAud, held: lHeld })).toBe(
      want
    );
  });
});

describe('enforcement on (gRPC)', () => {
  async function subscribeGrpc(policyEnforce?: PolicyEnforcer) {
    const seen: (Audience | undefined)[] = [];
    const server = createGrpcServer(recordingAdapter(seen), { verifyToken, policyEnforce });
    grpcServers.push(server);
    const port = await listenGrpc(server, 0);
    const Client = grpc.makeGenericClientConstructor(REGISTRY_SERVICE, 'Registry');
    const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const metadata = new grpc.Metadata();
    metadata.set('authorization', 'Bearer user-token');
    metadata.set('cf-ipcountry', 'NL');
    await new Promise<void>((resolve, reject) => {
      const call = (
        client as unknown as Record<
          string,
          (...args: [unknown, grpc.Metadata]) => grpc.ClientReadableStream<unknown>
        >
      ).Subscribe.call(client, { schema: APPS, cursor: '', urns: [], filter: '' }, metadata);
      call.on('data', () => undefined);
      call.on('end', () => resolve());
      call.on('error', reject);
    });
    client.close();
    return seen[0];
  }

  it.each<[Mode, string]>([
    ['disagree', 'mr'],
    ['timeout', LOCAL.key],
  ])('service %s: streams %s', async (mode, key) => {
    const o = observedEnforcer((await fakeService(mode)).url, 300);
    expect((await subscribeGrpc(o.enforce))?.key).toBe(key);
  });
});

describe('the service answer as an audience', () => {
  it('round-trips every audience this source decides', () => {
    for (const audience of [
      ANONYMOUS_AUDIENCE,
      SERVICE_AUDIENCE,
      audienceForUser(FULL_USER),
      audienceForUser(FULL_USER, { regionRestricted: true }),
      audienceForUser({ showNsfw: true, browsingLevel: 1 | 2 | 4 | 8 }),
      audienceForUser({ showNsfw: true, browsingLevel: 1 | 2 | 4 | 8 | 16 }),
    ]) {
      const d = ourDecision(
        { subject: null, token: null, audience, expiresAt: null, recheck: null },
        false
      );
      const back = serviceAudience({ ...d, regionHold: 'none' });
      expect(back).toEqual(audience);
    }
  });

  it('refuses a decision no audience can express', () => {
    const full = { ratings: AGREEING.ratings, unknownRating: true, regionHold: 'none' };
    expect(serviceAudience(full)?.key).toBe('mrx+xxx');
    expect(serviceAudience({ ...full, ratings: ['pg', 'pg13', 'r', 'x', 'xxx'] })).toBeNull();
    expect(serviceAudience({ ...full, ratings: [...full.ratings, 'nc17'] })).toBeNull();
    expect(serviceAudience({ ...full, unknownRating: false })).toBeNull();
    expect(
      serviceAudience({ ...full, ratings: ['g', 'pg', 'pg13'], unknownRating: true })
    ).toBeNull();
  });
});
