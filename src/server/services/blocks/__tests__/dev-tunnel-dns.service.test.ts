import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { DevTunnelDnsDeps } from '~/server/services/blocks/dev-tunnel-dns.service';
import {
  __resetDevTunnelDnsServersForTest,
  getDevTunnelDnsReadiness,
  isDevTunnelHostPublished,
} from '~/server/services/blocks/dev-tunnel-dns.service';

const DOMAIN = 'apps.example';
const HOST = `dev-0123456789abcdef.${DOMAIN}`;
// RFC 5737 documentation addresses.
const NS_ADDRESSES: Record<string, string[]> = {
  'ns1.dns.example.': ['192.0.2.53'],
  'ns2.dns.example.': ['198.51.100.53'],
};
const AUTHORITATIVE = ['192.0.2.53', '198.51.100.53'];

const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });

/**
 * Injected resolver wiring. `systemLookups` records every name the two system-resolver functions
 * were asked for, which is how the tests show the tunnel host never reaches them.
 */
function wiring(answer: {
  a?: () => Promise<string[]>;
  cname?: () => Promise<string[]>;
  ns?: Record<string, string[]>;
}) {
  const systemLookups: string[] = [];
  const resolver = {
    setServers: vi.fn<(servers: readonly string[]) => void>(),
    resolve4: vi.fn<(name: string) => Promise<string[]>>(
      answer.a ?? (async () => ['203.0.113.10'])
    ),
    resolveCname: vi.fn<(name: string) => Promise<string[]>>(
      answer.cname ?? (async () => Promise.reject(dnsError('ENODATA')))
    ),
  };
  const zones = answer.ns ?? { [`${DOMAIN}.`]: Object.keys(NS_ADDRESSES) };
  let clock = 1_000_000;
  const deps = {
    resolveNs: vi.fn(async (zone: string) => {
      systemLookups.push(zone);
      if (!zones[zone]) throw dnsError('ENODATA');
      return zones[zone];
    }),
    resolveNsAddress: vi.fn(async (name: string) => {
      systemLookups.push(name);
      return NS_ADDRESSES[name] ?? [];
    }),
    createResolver: vi.fn(() => resolver),
    now: () => clock,
  } satisfies DevTunnelDnsDeps;
  return { deps, resolver, systemLookups, advance: (ms: number) => (clock += ms) };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetDevTunnelDnsServersForTest();
  setEnv({ APPS_DOMAIN: DOMAIN, APPS_DEV_TUNNEL_INGRESS_TARGET: '192.0.2.1' });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  warn.mockClear();
});

describe('isDevTunnelHostPublished', () => {
  it('is ready once the authoritative nameservers answer with an address', async () => {
    const { deps, resolver } = wiring({});
    expect(await isDevTunnelHostPublished(HOST, deps)).toBe(true);
    expect(resolver.resolve4).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is not ready on NXDOMAIN, quietly', async () => {
    const { deps, resolver } = wiring({ a: () => Promise.reject(dnsError('ENOTFOUND')) });
    expect(await isDevTunnelHostPublished(HOST, deps)).toBe(false);
    expect(resolver.resolveCname).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is not ready on an answer that carries no address', async () => {
    const { deps } = wiring({ a: async () => [] });
    expect(await isDevTunnelHostPublished(HOST, deps)).toBe(false);
  });

  it.each(['ETIMEOUT', 'ECONNREFUSED', 'ESERVFAIL'])(
    'is not ready, and does not throw, when the query fails with %s',
    async (code) => {
      const { deps } = wiring({ a: () => Promise.reject(dnsError(code)) });
      await expect(isDevTunnelHostPublished(HOST, deps)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
        event: 'app-blocks.dev-tunnel.dns-ready.error',
        code,
      });
    }
  );

  it('is not ready when the nameservers cannot be found, without querying anything', async () => {
    const { deps, resolver } = wiring({ ns: {} });
    await expect(isDevTunnelHostPublished(HOST, deps)).resolves.toBe(false);
    expect(deps.createResolver).not.toHaveBeenCalled();
    expect(resolver.resolve4).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('counts an alias as published when the name has no address of its own', async () => {
    const { deps } = wiring({
      a: () => Promise.reject(dnsError('ENODATA')),
      cname: async () => ['edge.example.net'],
    });
    expect(await isDevTunnelHostPublished(HOST, deps)).toBe(true);
  });

  it('is not ready for a name that exists with neither an address nor an alias', async () => {
    const { deps } = wiring({ a: () => Promise.reject(dnsError('ENODATA')) });
    expect(await isDevTunnelHostPublished(HOST, deps)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks only the authoritative nameservers about the host, never the system resolver', async () => {
    const { deps, resolver, systemLookups } = wiring({});
    await isDevTunnelHostPublished(HOST, deps);

    expect(resolver.setServers).toHaveBeenCalledExactlyOnceWith(AUTHORITATIVE);
    expect(resolver.setServers.mock.invocationCallOrder[0]).toBeLessThan(
      resolver.resolve4.mock.invocationCallOrder[0]
    );
    // Absolute, so the resolver cannot append a search domain to it.
    expect(resolver.resolve4).toHaveBeenCalledExactlyOnceWith(`${HOST}.`);
    // The system resolver saw the zone and its nameservers, and nothing else.
    expect(systemLookups).toEqual([`${DOMAIN}.`, 'ns1.dns.example.', 'ns2.dns.example.']);
    expect(systemLookups.some((name) => name.includes('dev-'))).toBe(false);
  });

  it('finds the nameservers of the enclosing zone when the apps domain is not a zone apex', async () => {
    setEnv({ APPS_DOMAIN: `preview.${DOMAIN}` });
    const { deps, resolver, systemLookups } = wiring({
      ns: { [`${DOMAIN}.`]: Object.keys(NS_ADDRESSES) },
    });
    expect(await isDevTunnelHostPublished(`dev-0123456789abcdef.preview.${DOMAIN}`, deps)).toBe(
      true
    );
    expect(systemLookups.slice(0, 2)).toEqual([`preview.${DOMAIN}.`, `${DOMAIN}.`]);
    expect(resolver.setServers).toHaveBeenCalledWith(AUTHORITATIVE);
  });

  it('looks the nameservers up once, then again after the cache expires', async () => {
    const { deps, advance } = wiring({});
    await isDevTunnelHostPublished(HOST, deps);
    await isDevTunnelHostPublished(HOST, deps);
    expect(deps.resolveNs).toHaveBeenCalledTimes(1);
    advance(10 * 60_000 + 1);
    await isDevTunnelHostPublished(HOST, deps);
    expect(deps.resolveNs).toHaveBeenCalledTimes(2);
  });

  it('refuses a name outside the dev-host shape without any lookup', async () => {
    const { deps, systemLookups } = wiring({});
    for (const host of ['example.org', `my-app.${DOMAIN}`, `dev-0123456789abcdef.${DOMAIN}.evil`])
      expect(await isDevTunnelHostPublished(host, deps)).toBe(false);
    expect(systemLookups).toEqual([]);
    expect(deps.createResolver).not.toHaveBeenCalled();
  });

  it('is always ready, with no lookup, where this deployment publishes no record per tunnel', async () => {
    setEnv({ APPS_DEV_TUNNEL_INGRESS_TARGET: undefined });
    const { deps, systemLookups } = wiring({ a: () => Promise.reject(dnsError('ENOTFOUND')) });
    expect(await isDevTunnelHostPublished(HOST, deps)).toBe(true);
    expect(systemLookups).toEqual([]);
    expect(deps.createResolver).not.toHaveBeenCalled();
  });
});

describe('getDevTunnelDnsReadiness', () => {
  const OWNER = 555;
  const SESSION = {
    sessionId: 'bki_owner',
    userId: OWNER,
    blockId: 'my-app',
    host: HOST,
    fingerprint: 'f'.repeat(64),
    createdAt: 1,
    hardExpiresAt: 9e9,
    spendCapBuzz: 5000,
  };

  /** Seeds the tunnel store: `index` is the (user, block) → session pointer the lookup starts from. */
  function seed(index: { userId: number; blockId: string }, session: typeof SESSION) {
    redisMock.sysRedis.get.mockImplementation(async (key: string) => {
      if (key.endsWith(`:user:${index.userId}:${index.blockId}`)) return session.sessionId;
      if (key.endsWith(`:session:${session.sessionId}`)) return JSON.stringify(session);
      return null;
    });
  }

  it("reports the caller's own live tunnel", async () => {
    seed({ userId: OWNER, blockId: 'my-app' }, SESSION);
    const ready = wiring({});
    expect(await getDevTunnelDnsReadiness(OWNER, 'my-app', ready.deps)).toEqual({
      active: true,
      ready: true,
    });
    expect(ready.resolver.resolve4).toHaveBeenCalledWith(`${HOST}.`);

    __resetDevTunnelDnsServersForTest();
    const pending = wiring({ a: () => Promise.reject(dnsError('ENOTFOUND')) });
    expect(await getDevTunnelDnsReadiness(OWNER, 'my-app', pending.deps)).toEqual({
      active: true,
      ready: false,
    });
  });

  it("refuses another user's tunnel for the same app, with no lookup", async () => {
    seed({ userId: OWNER, blockId: 'my-app' }, SESSION);
    const { deps, systemLookups } = wiring({});
    expect(await getDevTunnelDnsReadiness(999, 'my-app', deps)).toEqual({ active: false });
    expect(systemLookups).toEqual([]);
    expect(deps.createResolver).not.toHaveBeenCalled();
  });

  it('refuses a session that is not the caller’s even when their index points at it', async () => {
    seed({ userId: 999, blockId: 'my-app' }, SESSION);
    const { deps, systemLookups } = wiring({});
    expect(await getDevTunnelDnsReadiness(999, 'my-app', deps)).toEqual({ active: false });
    expect(systemLookups).toEqual([]);
    expect(deps.createResolver).not.toHaveBeenCalled();
  });
});
