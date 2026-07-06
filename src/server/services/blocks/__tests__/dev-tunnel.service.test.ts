import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APP DEV TUNNEL — service coverage: manifest shape (SSRF-safe host match),
 * startDevTunnel mint+render+persist, stop (ownership-checked), getActiveDevTunnel,
 * the per-session spend-cap backstop, and the reaper.
 */

const {
  mockK8sFetch,
  mockGetDp1Target,
  mockUnwrap,
  mockWaitForApplyJob,
  mockRecordTeardown,
  sysRedis,
  mockEnv,
  mockNewId,
} = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    mockK8sFetch: vi.fn(),
    mockGetDp1Target: vi.fn(async () => ({ server: 'https://k8s', token: 't' })),
    mockUnwrap: vi.fn(async (res: any) => {
      const t = await res.text();
      return t ? JSON.parse(t) : {};
    }),
    // F1: the route now renders via an apps-applier Job that renderDevTunnelRoute
    // awaits to Succeeded. Default the wait to 'succeeded' so start/render tests
    // don't poll; the failure test overrides it.
    mockWaitForApplyJob: vi.fn(async () => 'succeeded' as const),
    mockRecordTeardown: vi.fn(),
      sysRedis: {
        _store: store,
        get: vi.fn(async (k: string) => store.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
          return 'OK';
        }),
        del: vi.fn(async (k: string) => {
          store.delete(k);
          return 1;
        }),
        incrBy: vi.fn(async (k: string, n: number) => {
          const cur = Number(store.get(k) ?? '0') + n;
          store.set(k, String(cur));
          return cur;
        }),
        decrBy: vi.fn(async (k: string, n: number) => {
          const cur = Number(store.get(k) ?? '0') - n;
          store.set(k, String(cur));
          return cur;
        }),
        expire: vi.fn(async () => 1),
        ttl: vi.fn(async () => 100),
      },
    mockEnv: {
      APPS_DOMAIN: 'civit.ai',
      APPS_KUBE_NAMESPACE: 'civitai-apps',
      NEXTAUTH_URL: 'https://civitai.com',
      APPS_DEV_TUNNEL_SISH_BACKEND: 'http://sish-http.apps-dev-tunnel.svc.cluster.local:80',
      APPS_DEV_TUNNEL_ROUTE_NAMESPACE: 'apps-dev-tunnel',
      APPS_DEV_TUNNEL_INGRESS_TARGET: '192.0.2.1' as string | undefined,
      APPS_DEV_TUNNEL_FORWARDAUTH_URL: undefined as string | undefined,
      APPS_DEV_TUNNEL_SSH_HOST_PUBKEY: 'ssh-ed25519 AAAAC3NzaHostKeyExample sish-host' as
        | string
        | undefined,
      APPS_DEV_TUNNEL_CF_API_TOKEN: undefined as string | undefined,
      APPS_DEV_TUNNEL_CF_ZONE_ID: undefined as string | undefined,
    },
    mockNewId: vi.fn(() => 'bki_testsession'),
  };
});

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  getDp1Target: (...a: unknown[]) => mockGetDp1Target(...(a as [])),
  k8sFetch: (...a: unknown[]) => mockK8sFetch(...(a as [])),
  unwrap: (...a: unknown[]) => mockUnwrap(...(a as [any])),
  waitForApplyJob: (...a: unknown[]) => mockWaitForApplyJob(...(a as [])),
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis,
  withSysReadDeadline: <T>(p: Promise<T>) => p,
  REDIS_SYS_KEYS: { BLOCKS: { DEV_TUNNEL: 'system:blocks:dev-tunnel' } },
}));
vi.mock('~/server/utils/app-block-ids', () => ({ newBlockInstanceId: () => mockNewId() }));
vi.mock('~/server/prom/dev-tunnel.metrics', () => ({
  recordDevTunnelMint: vi.fn(),
  recordDevTunnelTeardown: (...a: unknown[]) => mockRecordTeardown(...(a as [])),
}));

import {
  buildDevTunnelApplyJob,
  buildDevTunnelIngressRoute,
  buildDevTunnelMiddleware,
  deleteDevTunnelDns,
  deleteDevTunnelRoute,
  getActiveDevTunnel,
  refundDevSessionBuzz,
  reserveDevSessionBuzz,
  startDevTunnel,
  stopDevTunnel,
  reapExpiredDevTunnels,
  touchDevTunnelActivity,
  __resetDevTunnelDnsCacheForTest,
  DEV_TUNNEL_IDLE_SECONDS,
  DEV_TUNNEL_HARD_SECONDS,
  DEV_TUNNEL_REAP_MIN_AGE_SECONDS,
  DEV_TUNNEL_SESSION_BUZZ_CAP,
} from '~/server/services/blocks/dev-tunnel.service';
import { DEV_HOST_LABEL_REGEX } from '~/server/services/blocks/dev-tunnel-session';

const PUBKEY = 'ssh-ed25519 AAAAC3NzaExampleBytes0123456789abcdef dev@laptop';

function okRes(body = '{}') {
  return { ok: true, status: 200, text: async () => body };
}

beforeEach(() => {
  sysRedis._store.clear();
  vi.clearAllMocks();
  mockK8sFetch.mockResolvedValue(okRes());
  mockGetDp1Target.mockResolvedValue({ server: 'https://k8s', token: 't' });
  mockWaitForApplyJob.mockResolvedValue('succeeded');
  mockEnv.APPS_DEV_TUNNEL_CF_API_TOKEN = undefined;
  mockEnv.APPS_DEV_TUNNEL_CF_ZONE_ID = undefined;
  __resetDevTunnelDnsCacheForTest();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockEnv.APPS_DEV_TUNNEL_CF_API_TOKEN = undefined;
  mockEnv.APPS_DEV_TUNNEL_CF_ZONE_ID = undefined;
});

describe('manifest builders (SSRF-safe, server-derived host)', () => {
  const opts = {
    host: 'dev-0123456789abcdef.civit.ai',
    sessionId: 'bki_s',
    namespace: 'civitai-apps',
    forwardAuthUrl: 'http://civitai-web/api/internal/dev-tunnel-gate',
    sishBackend: 'http://sish-http.apps-dev-tunnel.svc.cluster.local:8080',
    ingressTarget: '192.0.2.1', // RFC-5737 doc placeholder; the real LB IP is a per-env secret
  };

  it('IngressRoute matches EXACTLY the assigned host (never a wildcard/user input)', () => {
    const ir = buildDevTunnelIngressRoute(opts);
    expect(ir.spec.routes[0].match).toBe('Host(`dev-0123456789abcdef.civit.ai`)');
    // routes to the sish backend service, parsed into name/namespace/port
    expect(ir.spec.routes[0].services[0]).toMatchObject({
      name: 'sish-http',
      namespace: 'apps-dev-tunnel',
      port: 8080,
    });
    // gated by the forwardAuth middleware — the ref uses the DNS-1123-sanitized
    // suffix (`bki_s` → `bki-s`), matching the Middleware's actual resource name.
    expect(ir.spec.routes[0].middlewares[0].name).toBe('dev-tunnel-gate-bki-s');
    // labelled for the reaper + teardown sweep — the LABEL keeps the RAW sessionId
    // (label values permit `_`; the reaper deletes by this label, not by name).
    expect(ir.metadata.labels['civitai.com/dev-tunnel']).toBe('true');
    expect(ir.metadata.labels['civitai.com/dev-tunnel-session']).toBe('bki_s');
    // external-dns annotations present when ingressTarget is set — without them the
    // ephemeral host is NXDOMAIN and the browser can't load the tunnel.
    expect(ir.metadata.annotations['external-dns.alpha.kubernetes.io/hostname']).toBe(
      'dev-0123456789abcdef.civit.ai'
    );
    expect(ir.metadata.annotations['external-dns.alpha.kubernetes.io/target']).toBe('192.0.2.1');
    expect(ir.metadata.annotations['external-dns.alpha.kubernetes.io/cloudflare-proxied']).toBe(
      'true'
    );
  });

  it('omits external-dns annotations when no ingressTarget is configured (no DNS record)', () => {
    const { ingressTarget: _drop, ...noTarget } = opts;
    const ir = buildDevTunnelIngressRoute(noTarget);
    // No target → no annotations → external-dns creates no record. The route still
    // renders (routing is correct); the host just won't resolve until the env is set.
    expect(ir.metadata.annotations).toBeUndefined();
  });

  it('Middleware points forwardAuth at the dev-tunnel-gate endpoint', () => {
    const mw = buildDevTunnelMiddleware(opts);
    expect(mw.spec.forwardAuth.address).toBe('http://civitai-web/api/internal/dev-tunnel-gate');
    expect(mw.spec.forwardAuth.authResponseHeaders).toContain('X-Dev-User-Id');
  });

  // REGRESSION: the real sessionId is `bki_<ULID>` — Crockford base32 (UPPERCASE)
  // with a `_`. Interpolating it raw into a k8s RESOURCE name produces an invalid
  // name ("must be a lowercase RFC 1123 subdomain"), so the route-apply Job fails,
  // the mint hangs, and the CLI times out. The Middleware/IngressRoute names (and
  // the route→middleware ref) MUST be DNS-1123-sanitized; the session LABEL keeps
  // the raw id for the reaper.
  it('derives DNS-1123-valid resource names from a real bki_<ULID> sessionId', () => {
    const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
    const realId = 'bki_01KWW3E1GT3JZW1XNBA9XA06ZM'; // uppercase + underscore
    const realOpts = { ...opts, sessionId: realId };

    const mw = buildDevTunnelMiddleware(realOpts);
    const ir = buildDevTunnelIngressRoute(realOpts);
    const expectedSuffix = 'bki-01kww3e1gt3jzw1xnba9xa06zm';

    // Names are valid k8s resource names (no uppercase / underscore).
    expect(mw.metadata.name).toBe(`dev-tunnel-gate-${expectedSuffix}`);
    expect(ir.metadata.name).toBe(`dev-tunnel-${expectedSuffix}`);
    expect(mw.metadata.name).toMatch(RFC1123);
    expect(ir.metadata.name).toMatch(RFC1123);
    // The route's middleware ref must equal the Middleware's actual name.
    expect(ir.spec.routes[0].middlewares[0].name).toBe(mw.metadata.name);
    // Labels retain the RAW sessionId so the reaper's label-selector delete matches.
    expect(mw.metadata.labels['civitai.com/dev-tunnel-session']).toBe(realId);
    expect(ir.metadata.labels['civitai.com/dev-tunnel-session']).toBe(realId);
  });
});

describe('startDevTunnel', () => {
  it('mints an unguessable host, renders the route (via the apply Job), persists state, returns the URL + host pubkey', async () => {
    const result = await startDevTunnel({ userId: 555, blockId: 'my-app', sshPublicKey: PUBKEY });
    // host = dev-<16hex>.civit.ai
    expect(result.host).toMatch(/^dev-[a-f0-9]{16}\.civit\.ai$/);
    expect(result.host.split('.')[0]).toMatch(DEV_HOST_LABEL_REGEX);
    expect(result.url).toBe('https://civitai.com/apps/dev/my-app');
    expect(result.spendCapBuzz).toBe(DEV_TUNNEL_SESSION_BUZZ_CAP);
    // R1: returns the sish host pubkey (from env) for the CLI to pin.
    expect(result.sshHostPublicKey).toBe('ssh-ed25519 AAAAC3NzaHostKeyExample sish-host');
    // F1: the route renders via ONE apply Job POST (NOT direct CRD POSTs from the
    // web-pod SA), pre-deleted first, then awaited to Succeeded.
    const posts = mockK8sFetch.mock.calls.filter((c) => (c[2] as any)?.method === 'POST');
    expect(posts.length).toBe(1);
    expect(posts[0][1]).toMatch(/\/jobs$/);
    // NAMESPACE SPLIT (the fix): the apply Job is created in civitai-apps (APPS_KUBE_NAMESPACE,
    // where apps-applier + the Job-create RBAC live), but the manifests it applies target the
    // ROUTE namespace (apps-dev-tunnel = the sish backend's ns) so Traefik accepts the
    // same-namespace service ref. Reverting manifestOpts to APPS_KUBE_NAMESPACE fails here.
    expect(posts[0][1]).toContain('/namespaces/civitai-apps/jobs');
    const job = JSON.parse((posts[0][2] as { body: string }).body);
    const envVal = (name: string) =>
      job.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === name)?.value;
    const appliedIr = JSON.parse(envVal('INGRESSROUTE_JSON'));
    const appliedMw = JSON.parse(envVal('MIDDLEWARE_JSON'));
    expect(appliedIr.metadata.namespace).toBe('apps-dev-tunnel');
    expect(appliedMw.metadata.namespace).toBe('apps-dev-tunnel');
    // service + middleware refs are now SAME-namespace (the cross-ns 404 cause).
    expect(appliedIr.spec.routes[0].services[0].namespace).toBe('apps-dev-tunnel');
    // PORT: reference the sish-http SERVICE port (80), not the pod targetPort (8080) —
    // Traefik matches a service ref by Service port number. A revert to :8080 fails here.
    expect(appliedIr.spec.routes[0].services[0].port).toBe(80);
    expect(appliedIr.spec.routes[0].middlewares[0].namespace).toBe('apps-dev-tunnel');
    expect(mockWaitForApplyJob).toHaveBeenCalledTimes(1);
    // persisted the 4 index keys (cred/session/host/user-block)
    expect(sysRedis.set).toHaveBeenCalledTimes(4);
    // the credential is keyed by pubkey fingerprint (sish authz lookup index)
    const credKeys = [...sysRedis._store.keys()].filter((k) => k.includes(':cred:'));
    expect(credKeys.length).toBe(1);
    // the session record carries the initial idle marker
    const sessionRaw = sysRedis._store.get('system:blocks:dev-tunnel:session:bki_testsession')!;
    expect(JSON.parse(sessionRaw).lastActivityAt).toBeTypeOf('number');
  });

  it('R1: returns an EMPTY host pubkey when the env is unset (CLI fails closed)', async () => {
    mockEnv.APPS_DEV_TUNNEL_SSH_HOST_PUBKEY = undefined;
    try {
      const result = await startDevTunnel({ userId: 5, blockId: 'a', sshPublicKey: PUBKEY });
      expect(result.sshHostPublicKey).toBe('');
    } finally {
      mockEnv.APPS_DEV_TUNNEL_SSH_HOST_PUBKEY = 'ssh-ed25519 AAAAC3NzaHostKeyExample sish-host';
    }
  });

  it('F1: a FAILED route-apply Job aborts the mint — nothing is persisted', async () => {
    mockWaitForApplyJob.mockResolvedValueOnce('failed');
    await expect(
      startDevTunnel({ userId: 9, blockId: 'b', sshPublicKey: PUBKEY })
    ).rejects.toThrow(/apply Job failed/);
    // render threw before persist → no dev-tunnel keys left behind
    const keys = [...sysRedis._store.keys()].filter((k) => k.startsWith('system:blocks:dev-tunnel'));
    expect(keys).toEqual([]);
  });

  it('rejects an invalid SSH public key before touching k8s/redis', async () => {
    await expect(
      startDevTunnel({ userId: 1, blockId: 'a', sshPublicKey: 'junk' })
    ).rejects.toThrow(/invalid SSH public key/);
    expect(mockK8sFetch).not.toHaveBeenCalled();
    expect(sysRedis.set).not.toHaveBeenCalled();
  });
});

describe('buildDevTunnelApplyJob (F1 — renders via the scoped apps-applier SA)', () => {
  it('runs as the apps-applier SA and injects both manifests (never the web-pod SA)', () => {
    const mw = buildDevTunnelMiddleware({
      host: 'dev-0123456789abcdef.civit.ai',
      sessionId: 'bki_s',
      namespace: 'civitai-apps',
      forwardAuthUrl: 'http://civitai-web/api/internal/dev-tunnel-gate',
      sishBackend: 'http://sish-http.apps-dev-tunnel.svc.cluster.local:8080',
    });
    const ir = buildDevTunnelIngressRoute({
      host: 'dev-0123456789abcdef.civit.ai',
      sessionId: 'bki_s',
      namespace: 'civitai-apps',
      forwardAuthUrl: 'http://civitai-web/api/internal/dev-tunnel-gate',
      sishBackend: 'http://sish-http.apps-dev-tunnel.svc.cluster.local:8080',
    });
    const job = buildDevTunnelApplyJob({
      ns: 'civitai-apps',
      jobName: 'dev-tunnel-apply-bki_s',
      sessionId: 'bki_s',
      middleware: mw,
      ingressRoute: ir,
    });
    // THE F1 SECURITY INVARIANT: the create runs as the narrowly-scoped applier SA.
    expect(job.spec.template.spec.serviceAccountName).toBe('apps-applier');
    // F1-1: a bounded deadline guarantees a hung apply pod becomes terminal → GC'd,
    // and it must be >= the 180s render wait so a slow-succeeding pull isn't killed.
    expect(job.spec.activeDeadlineSeconds).toBe(200);
    expect(job.spec.activeDeadlineSeconds).toBeGreaterThanOrEqual(180);
    // Both manifests are injected into the Job (kubectl apply -f -), not POSTed
    // by the web pod.
    const env = job.spec.template.spec.containers[0].env;
    const mwEnv = env.find((e) => e.name === 'MIDDLEWARE_JSON')!;
    const irEnv = env.find((e) => e.name === 'INGRESSROUTE_JSON')!;
    expect(JSON.parse(mwEnv.value).kind).toBe('Middleware');
    expect(JSON.parse(irEnv.value).kind).toBe('IngressRoute');
    // labelled for the reaper/teardown sweep
    expect(job.metadata.labels['civitai.com/dev-tunnel-session']).toBe('bki_s');
    // hardened pod spec (non-root, RO fs, drop ALL)
    expect(job.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
    expect(job.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
  });
});

describe('stopDevTunnel (ownership-checked)', () => {
  it('a caller can NEVER tear down another author’s tunnel', async () => {
    await startDevTunnel({ userId: 555, blockId: 'my-app', sshPublicKey: PUBKEY });
    // wrong user → no-op false, session survives
    expect(await stopDevTunnel(999, 'bki_testsession')).toBe(false);
    expect(sysRedis._store.has('system:blocks:dev-tunnel:session:bki_testsession')).toBe(true);
  });

  it('the owner tears down: deletes route + all keys', async () => {
    await startDevTunnel({ userId: 555, blockId: 'my-app', sshPublicKey: PUBKEY });
    expect(await stopDevTunnel(555, 'bki_testsession')).toBe(true);
    const remaining = [...sysRedis._store.keys()].filter((k) => k.startsWith('system:blocks:dev-tunnel'));
    expect(remaining).toEqual([]);
  });
});

describe('getActiveDevTunnel', () => {
  it('returns the active session for the owner; null for a foreign/absent index', async () => {
    await startDevTunnel({ userId: 555, blockId: 'my-app', sshPublicKey: PUBKEY });
    const s = await getActiveDevTunnel(555, 'my-app');
    expect(s?.userId).toBe(555);
    expect(s?.host).toMatch(/^dev-[a-f0-9]{16}\.civit\.ai$/);
    // wrong user / wrong block → null (no cross-tenant leak)
    expect(await getActiveDevTunnel(999, 'my-app')).toBeNull();
    expect(await getActiveDevTunnel(555, 'other-app')).toBeNull();
  });
});

describe('reserveDevSessionBuzz (spend-cap backstop)', () => {
  it('allows spend under the ceiling and DENIES + rolls back once it would exceed', async () => {
    const cap = 100;
    expect(await reserveDevSessionBuzz('sess', 60, cap)).toEqual({ allowed: true, total: 60 });
    // 60 + 60 = 120 > 100 → denied, rolled back to 60
    expect(await reserveDevSessionBuzz('sess', 60, cap)).toEqual({ allowed: false, total: 60 });
    // a smaller top-up that fits still passes
    expect(await reserveDevSessionBuzz('sess', 40, cap)).toEqual({ allowed: true, total: 100 });
    // now full → any further spend denied
    expect(await reserveDevSessionBuzz('sess', 1, cap)).toEqual({ allowed: false, total: 100 });
  });

  it('fails CLOSED (denied) on a redis error — never silently uncaps', async () => {
    sysRedis.incrBy.mockRejectedValueOnce(new Error('redis down'));
    const r = await reserveDevSessionBuzz('sess', 10, 100);
    expect(r.allowed).toBe(false);
  });
});

describe('touchDevTunnelActivity (F3 — idle refresh on gate entry)', () => {
  it('stamps lastActivityAt without extending the hard-TTL', async () => {
    await startDevTunnel({ userId: 555, blockId: 'my-app', sshPublicKey: PUBKEY });
    const host = JSON.parse(
      sysRedis._store.get('system:blocks:dev-tunnel:session:bki_testsession')!
    ).host as string;
    // move the marker back so a refresh is observable
    const before = JSON.parse(
      sysRedis._store.get('system:blocks:dev-tunnel:session:bki_testsession')!
    );
    before.lastActivityAt = 1000;
    sysRedis._store.set(
      'system:blocks:dev-tunnel:session:bki_testsession',
      JSON.stringify(before)
    );

    await touchDevTunnelActivity(host);

    const after = JSON.parse(
      sysRedis._store.get('system:blocks:dev-tunnel:session:bki_testsession')!
    );
    expect(after.lastActivityAt).toBeGreaterThan(1000);
    // the re-persist used EX = remaining-until-hard-expiry, NOT a fresh 8h reset
    const setCall = sysRedis.set.mock.calls.find(
      (c) => c[0] === 'system:blocks:dev-tunnel:session:bki_testsession' && c[2]
    );
    expect((setCall![2] as { EX: number }).EX).toBeLessThanOrEqual(DEV_TUNNEL_HARD_SECONDS);
  });

  it('is a no-op for an unknown host (never throws)', async () => {
    await expect(touchDevTunnelActivity('dev-ffffffffffffffff.civit.ai')).resolves.toBeUndefined();
  });
});

describe('reserveDevSessionBuzz / refundDevSessionBuzz (F4 support)', () => {
  it('refund reverses a reservation (best-effort DECRBY)', async () => {
    const cap = 100;
    await reserveDevSessionBuzz('sess', 60, cap);
    await refundDevSessionBuzz('sess', 60);
    // back under the cap → a fresh 60 fits again
    expect(await reserveDevSessionBuzz('sess', 60, cap)).toEqual({ allowed: true, total: 60 });
  });
});

describe('reapExpiredDevTunnels (server-authoritative, idle + hardened)', () => {
  const NOW = Math.floor(Date.now() / 1000);

  function seedSession(
    sessionId: string,
    over: Partial<Record<string, unknown>> = {}
  ) {
    sysRedis._store.set(
      `system:blocks:dev-tunnel:session:${sessionId}`,
      JSON.stringify({
        sessionId,
        userId: 7,
        blockId: 'x',
        host: 'dev-aaaaaaaaaaaaaaaa.civit.ai',
        fingerprint: 'fp',
        createdAt: NOW - 60,
        hardExpiresAt: NOW + DEV_TUNNEL_HARD_SECONDS, // NOT hard-expired
        spendCapBuzz: 100,
        lastActivityAt: NOW,
        ...over,
      })
    );
  }

  /** Make the LIST return a single route labelled `sessionId`, with an optional
   *  creationTimestamp; every other call (DELETE) is a plain OK. */
  function listOneRoute(sessionId: string, creationTimestamp?: string) {
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        return okRes(
          JSON.stringify({
            items: [
              {
                metadata: {
                  labels: { 'civitai.com/dev-tunnel-session': sessionId },
                  ...(creationTimestamp ? { creationTimestamp } : {}),
                },
              },
            ],
          })
        );
      }
      return okRes();
    });
  }

  it('tears down a route whose backing session is HARD-expired (reap-maxttl)', async () => {
    const sessionId = 'bki_expired';
    seedSession(sessionId, { hardExpiresAt: 1, createdAt: 1, lastActivityAt: 1 });
    listOneRoute(sessionId);
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 1, reaped: 1, skipped: 0, listOk: true });
    expect(sysRedis._store.has(`system:blocks:dev-tunnel:session:${sessionId}`)).toBe(false);
    expect(mockRecordTeardown).toHaveBeenCalledWith('reap-maxttl');
  });

  it('F3: reaps an IDLE-expired session (activity older than the idle window) as reap-idle', async () => {
    const sessionId = 'bki_idle';
    seedSession(sessionId, { lastActivityAt: NOW - DEV_TUNNEL_IDLE_SECONDS - 60 });
    listOneRoute(sessionId);
    const result = await reapExpiredDevTunnels();
    expect(result).toMatchObject({ reaped: 1, skipped: 0, listOk: true });
    expect(mockRecordTeardown).toHaveBeenCalledWith('reap-idle');
    expect(sysRedis._store.has(`system:blocks:dev-tunnel:session:${sessionId}`)).toBe(false);
  });

  it('F3: does NOT reap a recently-ACTIVE session (survives, not counted as skipped)', async () => {
    const sessionId = 'bki_active';
    seedSession(sessionId, { lastActivityAt: NOW - 5 }); // just active
    listOneRoute(sessionId);
    const result = await reapExpiredDevTunnels();
    // a live session is kept: reaped 0 AND skipped 0 (skipped = read-error/guarded-absent only)
    expect(result).toEqual({ swept: 1, reaped: 0, skipped: 0, listOk: true });
    expect(sysRedis._store.has(`system:blocks:dev-tunnel:session:${sessionId}`)).toBe(true);
  });

  it('read-error skip: a Redis read error leaves a LIVE route alone (counted in skipped)', async () => {
    const sessionId = 'bki_blip';
    seedSession(sessionId);
    listOneRoute(sessionId);
    sysRedis.get.mockRejectedValueOnce(new Error('redis blip'));
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 1, reaped: 0, skipped: 1, listOk: true });
    // route + record untouched
    expect(sysRedis._store.has(`system:blocks:dev-tunnel:session:${sessionId}`)).toBe(true);
  });

  it('min-age guard: an absent-record route that is TOO YOUNG (mid-mint) is skipped, not reaped', async () => {
    const sessionId = 'bki_young';
    // no session record seeded → absent; route created just now
    listOneRoute(sessionId, new Date().toISOString());
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 1, reaped: 0, skipped: 1, listOk: true });
  });

  it('min-age guard: an absent-record route with UNKNOWN age (no creationTimestamp) is skipped', async () => {
    const sessionId = 'bki_noage';
    listOneRoute(sessionId); // no creationTimestamp → age indeterminable → skip (never reap)
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 1, reaped: 0, skipped: 1, listOk: true });
  });

  it('orphan reap: an absent-record route OLDER than the min-age is deleted', async () => {
    const sessionId = 'bki_orphan';
    const old = new Date((NOW - DEV_TUNNEL_REAP_MIN_AGE_SECONDS - 60) * 1000).toISOString();
    listOneRoute(sessionId, old);
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 1, reaped: 1, skipped: 0, listOk: true });
    expect(mockRecordTeardown).toHaveBeenCalledWith('reap-maxttl');
  });

  it('listOk: a NON-2xx LIST surfaces listOk:false + the HTTP status (not a silent empty sweep)', async () => {
    mockK8sFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 0, reaped: 0, skipped: 0, listOk: false, status: 403 });
  });

  it('listOk: a THROWN LIST (apiserver unreachable) surfaces listOk:false + status 0 sentinel', async () => {
    mockK8sFetch.mockRejectedValue(new Error('connection refused'));
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 0, reaped: 0, skipped: 0, listOk: false, status: 0 });
  });

  it('listOk: getDp1Target throwing (no SA token) surfaces listOk:false + status 0', async () => {
    mockGetDp1Target.mockRejectedValueOnce(new Error('not in-cluster'));
    const result = await reapExpiredDevTunnels();
    expect(result).toEqual({ swept: 0, reaped: 0, skipped: 0, listOk: false, status: 0 });
  });

  it('F1-2: discovers + reaps an ORPHAN MIDDLEWARE (no IngressRoute) for an absent session', async () => {
    const sessionId = 'bki_mw_orphan';
    const old = new Date((NOW - DEV_TUNNEL_REAP_MIN_AGE_SECONDS - 60) * 1000).toISOString();
    // ingressroutes LIST → EMPTY (the IngressRoute apply failed); middlewares LIST
    // → the orphan Middleware. No session record seeded → absent.
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        return okRes(JSON.stringify({ items: [] }));
      }
      if (init?.method === 'GET' && path.includes('middlewares?labelSelector')) {
        return okRes(
          JSON.stringify({
            items: [
              {
                metadata: {
                  name: `dev-tunnel-gate-${sessionId}`,
                  labels: { 'civitai.com/dev-tunnel-session': sessionId },
                  creationTimestamp: old,
                },
              },
            ],
          })
        );
      }
      return okRes();
    });
    const result = await reapExpiredDevTunnels();
    // the Middleware-only session was discovered (swept) + reaped (both-kind delete)
    expect(result.swept).toBe(1);
    expect(result.reaped).toBe(1);
    expect(mockRecordTeardown).toHaveBeenCalledWith('reap-maxttl');
    // deleteDevTunnelRoute issued a DELETE against the orphan middleware
    const mwDeletes = mockK8sFetch.mock.calls.filter(
      (c) => (c[2] as any)?.method === 'DELETE' && String(c[1]).includes('/middlewares/')
    );
    expect(mwDeletes.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare orphan-DNS cleanup (best-effort, opt-in, dev-<hex>-only guard)
// ---------------------------------------------------------------------------

const CF_DEV_HOST = 'dev-0123456789abcdef.civit.ai';

/** A CF v4 envelope Response stub. */
function cfEnvelope(result: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => ({ success: ok, result, errors: [] }) };
}

/** Route CF fetch by URL + method: zone lookup, per-name record list, deletes. */
function routeCfFetch(recordsByName: Record<string, Array<{ id: string }>>, zoneResult = [{ id: 'zone-1' }]) {
  return vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    if (String(url).includes('/zones?name=')) return cfEnvelope(zoneResult);
    const listMatch = String(url).match(/dns_records\?name=([^&]+)$/);
    if (method === 'GET' && listMatch) {
      const name = decodeURIComponent(listMatch[1]);
      return cfEnvelope(recordsByName[name] ?? []);
    }
    if (method === 'DELETE') return cfEnvelope({ id: 'deleted' });
    return cfEnvelope([]);
  });
}

describe('deleteDevTunnelDns (best-effort orphan CF DNS cleanup)', () => {
  beforeEach(() => {
    mockEnv.APPS_DEV_TUNNEL_CF_API_TOKEN = 'cf-token';
    mockEnv.APPS_DEV_TUNNEL_CF_ZONE_ID = undefined;
    __resetDevTunnelDnsCacheForTest();
  });

  it('looks up the zone by name, queries BOTH host + a-host names, and DELETEs each returned record', async () => {
    const fetchMock = routeCfFetch({
      [CF_DEV_HOST]: [{ id: 'rec-a' }],
      [`a-${CF_DEV_HOST}`]: [{ id: 'rec-txt' }],
    });
    await deleteDevTunnelDns(CF_DEV_HOST, fetchMock as unknown as typeof fetch);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // zone looked up by the registrable (last-two-label) domain of the host
    expect(urls.some((u) => u.includes('/zones?name=civit.ai'))).toBe(true);
    // both name forms queried (A record + external-dns TXT-registry forms)
    expect(urls.some((u) => u.includes(`dns_records?name=${encodeURIComponent(CF_DEV_HOST)}`))).toBe(true);
    expect(urls.some((u) => u.includes(`dns_records?name=${encodeURIComponent('a-' + CF_DEV_HOST)}`))).toBe(
      true
    );
    // one DELETE per returned record id
    const deletes = fetchMock.mock.calls
      .filter((c) => (c[1] as any)?.method === 'DELETE')
      .map((c) => String(c[0]));
    expect(deletes.some((u) => u.endsWith('/zones/zone-1/dns_records/rec-a'))).toBe(true);
    expect(deletes.some((u) => u.endsWith('/zones/zone-1/dns_records/rec-txt'))).toBe(true);
  });

  it('uses APPS_DEV_TUNNEL_CF_ZONE_ID directly when set (no zone lookup)', async () => {
    mockEnv.APPS_DEV_TUNNEL_CF_ZONE_ID = 'zone-env';
    const fetchMock = routeCfFetch({ [CF_DEV_HOST]: [{ id: 'r1' }], [`a-${CF_DEV_HOST}`]: [] });
    await deleteDevTunnelDns(CF_DEV_HOST, fetchMock as unknown as typeof fetch);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/zones?name='))).toBe(false);
    expect(urls.some((u) => u.includes('/zones/zone-env/dns_records'))).toBe(true);
  });

  it('SAFETY: refuses any host that is not a well-formed dev-<16hex>.… (no CF calls)', async () => {
    const fetchMock = vi.fn();
    await deleteDevTunnelDns('civitai.com', fetchMock as unknown as typeof fetch);
    await deleteDevTunnelDns('dev-notenoughhex.civit.ai', fetchMock as unknown as typeof fetch);
    await deleteDevTunnelDns('evil-dev-0123456789abcdef.civit.ai', fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the CF token is unset (feature off — no fetch)', async () => {
    mockEnv.APPS_DEV_TUNNEL_CF_API_TOKEN = undefined;
    const fetchMock = vi.fn();
    await deleteDevTunnelDns(CF_DEV_HOST, fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the CF call rejects (best-effort)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('cf down');
    });
    await expect(
      deleteDevTunnelDns(CF_DEV_HOST, fetchMock as unknown as typeof fetch)
    ).resolves.toBeUndefined();
  });

  it('never throws on a non-2xx CF response and issues no deletes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/zones?name=')) return cfEnvelope([], false, 403);
      return cfEnvelope([], false, 500);
    });
    await expect(
      deleteDevTunnelDns(CF_DEV_HOST, fetchMock as unknown as typeof fetch)
    ).resolves.toBeUndefined();
    const deletes = fetchMock.mock.calls.filter((c) => (c[1] as any)?.method === 'DELETE');
    expect(deletes.length).toBe(0);
  });
});

describe('orphan-DNS GC wiring (teardown + reap call the CF deleter, best-effort)', () => {
  /** LIST a route carrying the external-dns hostname annotation so
   *  deleteDevTunnelRoute can discover the host for CF cleanup. */
  function listRouteWithHost(sessionId: string, host: string) {
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        return okRes(
          JSON.stringify({
            items: [
              {
                metadata: {
                  name: 'dev-tunnel-x',
                  labels: { 'civitai.com/dev-tunnel-session': sessionId },
                  annotations: { 'external-dns.alpha.kubernetes.io/hostname': host },
                },
              },
            ],
          })
        );
      }
      return okRes();
    });
  }

  it('deleteDevTunnelRoute deletes the orphan CF record for the route host', async () => {
    mockEnv.APPS_DEV_TUNNEL_CF_API_TOKEN = 'cf-token';
    mockEnv.APPS_DEV_TUNNEL_CF_ZONE_ID = 'zone-1';
    listRouteWithHost('bki_wire', CF_DEV_HOST);
    const cf: Array<[string, string]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any) => {
        cf.push([init?.method ?? 'GET', String(url)]);
        if (String(url).includes('dns_records?name=')) return cfEnvelope([{ id: 'rec-1' }]);
        return cfEnvelope({});
      })
    );
    await deleteDevTunnelRoute('bki_wire');
    // the CF deleter was invoked with the route host and DELETEd its record
    expect(cf.some(([m, u]) => m === 'DELETE' && u.endsWith('/zones/zone-1/dns_records/rec-1'))).toBe(true);
  });

  it('a CF failure does NOT break teardown (route + keys still deleted)', async () => {
    mockEnv.APPS_DEV_TUNNEL_CF_API_TOKEN = 'cf-token';
    mockEnv.APPS_DEV_TUNNEL_CF_ZONE_ID = 'zone-1';
    sysRedis._store.set(
      'system:blocks:dev-tunnel:session:bki_wire2',
      JSON.stringify({
        sessionId: 'bki_wire2',
        userId: 42,
        blockId: 'b',
        host: CF_DEV_HOST,
        fingerprint: 'fp',
        createdAt: 1,
        hardExpiresAt: 9999999999,
        spendCapBuzz: 100,
      })
    );
    listRouteWithHost('bki_wire2', CF_DEV_HOST);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('cf down');
      })
    );
    // stopDevTunnel → teardownSession → deleteDevTunnelRoute (which GCs CF)
    expect(await stopDevTunnel(42, 'bki_wire2')).toBe(true);
    // teardown completed despite the CF failure — all keys gone
    const remaining = [...sysRedis._store.keys()].filter((k) =>
      k.startsWith('system:blocks:dev-tunnel')
    );
    expect(remaining).toEqual([]);
  });

  it('reapExpiredDevTunnels GCs CF DNS for a reaped session; a CF failure does not change counts', async () => {
    mockEnv.APPS_DEV_TUNNEL_CF_API_TOKEN = 'cf-token';
    mockEnv.APPS_DEV_TUNNEL_CF_ZONE_ID = 'zone-1';
    const sessionId = 'bki_reapdns';
    // hard-expired session record
    sysRedis._store.set(
      `system:blocks:dev-tunnel:session:${sessionId}`,
      JSON.stringify({
        sessionId,
        userId: 7,
        blockId: 'x',
        host: CF_DEV_HOST,
        fingerprint: 'fp',
        createdAt: 1,
        hardExpiresAt: 1,
        spendCapBuzz: 100,
        lastActivityAt: 1,
      })
    );
    // LIST returns the route WITH the hostname annotation (discovery + host source)
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        return okRes(
          JSON.stringify({
            items: [
              {
                metadata: {
                  name: 'dev-tunnel-x',
                  labels: { 'civitai.com/dev-tunnel-session': sessionId },
                  annotations: { 'external-dns.alpha.kubernetes.io/hostname': CF_DEV_HOST },
                },
              },
            ],
          })
        );
      }
      return okRes();
    });
    const cfUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        cfUrls.push(String(url));
        throw new Error('cf down');
      })
    );
    const result = await reapExpiredDevTunnels();
    // reap counts are unaffected by the (failing) best-effort CF cleanup
    expect(result).toEqual({ swept: 1, reaped: 1, skipped: 0, listOk: true });
    // the CF deleter WAS invoked for the reaped host's zone
    expect(cfUrls.some((u) => u.includes('/zones/zone-1/dns_records'))).toBe(true);
  });
});
