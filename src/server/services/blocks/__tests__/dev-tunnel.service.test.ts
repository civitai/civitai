import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APP DEV TUNNEL — service coverage: manifest shape (SSRF-safe host match),
 * startDevTunnel mint+render+persist, stop (ownership-checked), getActiveDevTunnel,
 * the per-session spend-cap backstop, and the reaper.
 */

const { mockK8sFetch, mockGetDp1Target, mockUnwrap, sysRedis, mockEnv, mockNewId } = vi.hoisted(
  () => {
    const store = new Map<string, string>();
    return {
      store,
      mockK8sFetch: vi.fn(),
      mockGetDp1Target: vi.fn(async () => ({ server: 'https://k8s', token: 't' })),
      mockUnwrap: vi.fn(async (res: any) => {
        const t = await res.text();
        return t ? JSON.parse(t) : {};
      }),
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
        APPS_DEV_TUNNEL_SISH_BACKEND: 'http://sish-http.apps-dev-tunnel.svc.cluster.local:8080',
        APPS_DEV_TUNNEL_FORWARDAUTH_URL: undefined as string | undefined,
      },
      mockNewId: vi.fn(() => 'bki_testsession'),
    };
  }
);

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  getDp1Target: (...a: unknown[]) => mockGetDp1Target(...(a as [])),
  k8sFetch: (...a: unknown[]) => mockK8sFetch(...(a as [])),
  unwrap: (...a: unknown[]) => mockUnwrap(...(a as [any])),
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis,
  withSysReadDeadline: <T>(p: Promise<T>) => p,
  REDIS_SYS_KEYS: { BLOCKS: { DEV_TUNNEL: 'system:blocks:dev-tunnel' } },
}));
vi.mock('~/server/utils/app-block-ids', () => ({ newBlockInstanceId: () => mockNewId() }));
vi.mock('~/server/prom/dev-tunnel.metrics', () => ({
  recordDevTunnelMint: vi.fn(),
  recordDevTunnelTeardown: vi.fn(),
}));

import {
  buildDevTunnelIngressRoute,
  buildDevTunnelMiddleware,
  getActiveDevTunnel,
  reserveDevSessionBuzz,
  startDevTunnel,
  stopDevTunnel,
  reapExpiredDevTunnels,
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
});
afterEach(() => vi.clearAllMocks());

describe('manifest builders (SSRF-safe, server-derived host)', () => {
  const opts = {
    host: 'dev-0123456789abcdef.civit.ai',
    sessionId: 'bki_s',
    namespace: 'civitai-apps',
    forwardAuthUrl: 'http://civitai-web/api/internal/dev-tunnel-gate',
    sishBackend: 'http://sish-http.apps-dev-tunnel.svc.cluster.local:8080',
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
    // gated by the forwardAuth middleware
    expect(ir.spec.routes[0].middlewares[0].name).toBe('dev-tunnel-gate-bki_s');
    // labelled for the reaper + teardown sweep
    expect(ir.metadata.labels['civitai.com/dev-tunnel']).toBe('true');
    expect(ir.metadata.labels['civitai.com/dev-tunnel-session']).toBe('bki_s');
  });

  it('Middleware points forwardAuth at the dev-tunnel-gate endpoint', () => {
    const mw = buildDevTunnelMiddleware(opts);
    expect(mw.spec.forwardAuth.address).toBe('http://civitai-web/api/internal/dev-tunnel-gate');
    expect(mw.spec.forwardAuth.authResponseHeaders).toContain('X-Dev-User-Id');
  });
});

describe('startDevTunnel', () => {
  it('mints an unguessable host, renders the route, persists state, returns the URL', async () => {
    const result = await startDevTunnel({ userId: 555, blockId: 'my-app', sshPublicKey: PUBKEY });
    // host = dev-<16hex>.civit.ai
    expect(result.host).toMatch(/^dev-[a-f0-9]{16}\.civit\.ai$/);
    expect(result.host.split('.')[0]).toMatch(DEV_HOST_LABEL_REGEX);
    expect(result.url).toBe('https://civitai.com/apps/dev/my-app');
    expect(result.spendCapBuzz).toBe(DEV_TUNNEL_SESSION_BUZZ_CAP);
    // rendered: middleware + ingressroute each pre-deleted (DELETE) + POSTed
    const posts = mockK8sFetch.mock.calls.filter((c) => (c[2] as any)?.method === 'POST');
    expect(posts.length).toBe(2);
    // persisted the 4 index keys (cred/session/host/user-block)
    expect(sysRedis.set).toHaveBeenCalledTimes(4);
    // the credential is keyed by pubkey fingerprint (sish authz lookup index)
    const credKeys = [...sysRedis._store.keys()].filter((k) => k.includes(':cred:'));
    expect(credKeys.length).toBe(1);
  });

  it('rejects an invalid SSH public key before touching k8s/redis', async () => {
    await expect(
      startDevTunnel({ userId: 1, blockId: 'a', sshPublicKey: 'junk' })
    ).rejects.toThrow(/invalid SSH public key/);
    expect(mockK8sFetch).not.toHaveBeenCalled();
    expect(sysRedis.set).not.toHaveBeenCalled();
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

describe('reapExpiredDevTunnels (server-authoritative)', () => {
  it('tears down a route whose backing session has expired', async () => {
    // Seed an EXPIRED session + a k8s route labelled with it.
    const sessionId = 'bki_expired';
    sysRedis._store.set(
      `system:blocks:dev-tunnel:session:${sessionId}`,
      JSON.stringify({
        sessionId,
        userId: 7,
        blockId: 'x',
        host: 'dev-aaaaaaaaaaaaaaaa.civit.ai',
        fingerprint: 'fp',
        createdAt: 1,
        hardExpiresAt: 1, // long past
        spendCapBuzz: 100,
      })
    );
    // First k8sFetch (the LIST) returns the labelled route; subsequent DELETEs ok.
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        return okRes(
          JSON.stringify({
            items: [{ metadata: { labels: { 'civitai.com/dev-tunnel-session': sessionId } } }],
          })
        );
      }
      return okRes();
    });
    const result = await reapExpiredDevTunnels();
    expect(result.swept).toBe(1);
    expect(result.reaped).toBe(1);
    // the session record was removed during teardown
    expect(sysRedis._store.has(`system:blocks:dev-tunnel:session:${sessionId}`)).toBe(false);
  });

  /** Helper: make the main label-scoped LIST return `items`, everything else ok. */
  function listReturns(items: unknown[], listStatus?: { ok: boolean; status: number }) {
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        if (listStatus && !listStatus.ok) {
          return { ok: false, status: listStatus.status, text: async () => 'forbidden' };
        }
        return okRes(JSON.stringify({ items }));
      }
      return okRes();
    });
  }
  const deleteCalls = () =>
    mockK8sFetch.mock.calls.filter((c: unknown[]) => (c[2] as any)?.method === 'DELETE');

  it('(a) LEAVES an ACTIVE session ALONE — the delete blast-radius stays tight', async () => {
    // Present session with a FUTURE hardExpiresAt = a live tunnel. Must survive.
    const sessionId = 'bki_active';
    const key = `system:blocks:dev-tunnel:session:${sessionId}`;
    sysRedis._store.set(
      key,
      JSON.stringify({
        sessionId,
        userId: 7,
        blockId: 'x',
        host: 'dev-bbbbbbbbbbbbbbbb.civit.ai',
        fingerprint: 'fp',
        createdAt: 1,
        hardExpiresAt: Math.floor(Date.now() / 1000) + 3600, // 1h in the future
        spendCapBuzz: 100,
      })
    );
    listReturns([{ metadata: { labels: { 'civitai.com/dev-tunnel-session': sessionId } } }]);

    const result = await reapExpiredDevTunnels();

    expect(result).toMatchObject({ swept: 1, reaped: 0, skipped: 0, listOk: true });
    // the live session record is untouched + no route delete issued
    expect(sysRedis._store.has(key)).toBe(true);
    expect(deleteCalls().length).toBe(0);
  });

  it('(b) a non-2xx LIST surfaces listOk:false (NOT a silent empty sweep)', async () => {
    listReturns([], { ok: false, status: 403 });

    const result = await reapExpiredDevTunnels();

    expect(result).toMatchObject({ swept: 0, reaped: 0, skipped: 0, listOk: false, status: 403 });
    // nothing was deleted on a failed list
    expect(deleteCalls().length).toBe(0);
  });

  it('(c) a Redis READ ERROR during the sweep does NOT delete the route (skip, not reap)', async () => {
    const sessionId = 'bki_readerr';
    // Old route (would clear the min-age guard) — proving the SKIP is due to the
    // read FAILURE, not the age guard.
    listReturns([
      {
        metadata: {
          labels: { 'civitai.com/dev-tunnel-session': sessionId },
          creationTimestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      },
    ]);
    // The session read throws (Redis timeout) — must be treated as "unknown", not "gone".
    sysRedis.get.mockImplementation(async (k: string) => {
      if (k.includes(`:session:${sessionId}`)) throw new Error('redis timeout');
      return sysRedis._store.get(k) ?? null;
    });

    const result = await reapExpiredDevTunnels();

    expect(result).toMatchObject({ swept: 1, reaped: 0, skipped: 1, listOk: true });
    expect(deleteCalls().length).toBe(0);
  });

  it('(d) the min-age guard LEAVES a just-created route (create-before-persist race)', async () => {
    const sessionId = 'bki_young';
    // Route created just now, session record NOT yet written (clean miss).
    listReturns([
      {
        metadata: {
          labels: { 'civitai.com/dev-tunnel-session': sessionId },
          creationTimestamp: new Date().toISOString(),
        },
      },
    ]);

    const result = await reapExpiredDevTunnels();

    expect(result).toMatchObject({ swept: 1, reaped: 0, skipped: 1, listOk: true });
    expect(deleteCalls().length).toBe(0);
  });

  it('(e) an OLD absent-record route IS reaped — proving the guard is age-gated, not blanket-skip', async () => {
    const sessionId = 'bki_old_orphan';
    // Route older than the min-age guard, session record confirmed-absent.
    listReturns([
      {
        metadata: {
          labels: { 'civitai.com/dev-tunnel-session': sessionId },
          creationTimestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      },
    ]);

    const result = await reapExpiredDevTunnels();

    expect(result).toMatchObject({ swept: 1, reaped: 1, skipped: 0, listOk: true });
  });

  it('(f) a THROWN LIST (TLS/network) is list_failed (status 0), NOT a generic error — and deletes nothing', async () => {
    // Simulate a TLS-verify reject / connection failure on the LIST call itself.
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        throw new Error('unable to verify the first certificate'); // TLS handshake reject
      }
      return okRes();
    });

    // MUST NOT throw — the reaper converts an unreachable API into a discriminated
    // list_failed (sentinel status 0) so the job records `list_failed`, not `error`.
    const result = await reapExpiredDevTunnels();

    expect(result).toMatchObject({ swept: 0, reaped: 0, skipped: 0, listOk: false, status: 0 });
    expect(deleteCalls().length).toBe(0);
  });

  it('(g) route age uses the apiserver Date header — young-per-apiserver route is SKIPPED despite a pod clock running ~1h ahead', async () => {
    const sessionId = 'bki_skewguard';
    // Fixed base ~1h in the PAST of the real pod clock: under Date.now() the route
    // would look ~1h old → reaped. Session record confirmed-absent.
    const base = Date.now() - 60 * 60 * 1000;
    const creationTimestamp = new Date(base).toISOString();
    // apiserver "now" = 5s after creation → YOUNG in the apiserver's own clock domain.
    const apiserverDate = new Date(base + 5000).toUTCString();
    mockK8sFetch.mockImplementation(async (_t: unknown, path: string, init: any) => {
      if (init?.method === 'GET' && path.includes('ingressroutes?labelSelector')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h.toLowerCase() === 'date' ? apiserverDate : null) },
          text: async () =>
            JSON.stringify({
              items: [
                {
                  metadata: {
                    labels: { 'civitai.com/dev-tunnel-session': sessionId },
                    creationTimestamp,
                  },
                },
              ],
            }),
        };
      }
      return okRes();
    });

    const result = await reapExpiredDevTunnels();

    // Age computed from the apiserver Date (~5s) < guard → SKIPPED. If the code used
    // the pod clock (~1h ahead) it would have reaped a route mid-creation.
    expect(result).toMatchObject({ swept: 1, reaped: 0, skipped: 1, listOk: true });
    expect(deleteCalls().length).toBe(0);
  });
});
