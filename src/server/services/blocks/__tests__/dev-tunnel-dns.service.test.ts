import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DnsPromises from 'node:dns/promises';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const DOMAIN = 'apps.example';
const HOST = `dev-0123456789abcdef.${DOMAIN}`;
const devHost = (n: number) => `dev-${n.toString(16).padStart(16, '0')}.${DOMAIN}`;
// RFC 5737 documentation addresses. Three nameservers, the first with two addresses, so the
// "first two nameservers, one address each" selection differs from every simpler one.
const NS_NAMES = ['ns1.dns.example', 'ns2.dns.example', 'ns3.dns.example'];
const NS_ADDRESSES: Record<string, string[]> = {
  'ns1.dns.example.': ['192.0.2.53', '192.0.2.54'],
  'ns2.dns.example.': ['198.51.100.53'],
  'ns3.dns.example.': ['203.0.113.53'],
};
const FIRST = '192.0.2.53';
const SECOND = '198.51.100.53';

type Answer = () => Promise<string[]>;
const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });
const fails = (code: string) => () => Promise.reject(dnsError(code));
const address: Answer = async () => ['203.0.113.10'];

const dns = vi.hoisted(() => {
  const state = {
    /** Zone → NS names, as the system resolver answers. */
    zones: {} as Record<string, string[]>,
    nsAddresses: {} as Record<string, string[]>,
    /** Per authoritative server address: its A and CNAME answers for any name. */
    a: {} as Record<string, () => Promise<string[]>>,
    cname: {} as Record<string, () => Promise<string[]>>,
    /** Every query made: `servers` is null on a resolver left on the system's own servers. */
    queries: [] as { servers: string[] | null; type: string; name: string }[],
    options: [] as unknown[],
    moduleLevel: [] as string[],
  };
  const noData = () => Object.assign(new Error('query ENODATA'), { code: 'ENODATA' });
  class Resolver {
    servers: string[] | null = null;
    constructor(options?: unknown) {
      state.options.push(options);
    }
    setServers(servers: string[]) {
      this.servers = [...servers];
    }
    private log(type: string, name: string) {
      state.queries.push({ servers: this.servers, type, name });
    }
    async resolveNs(name: string) {
      this.log('NS', name);
      if (this.servers || !state.zones[name]) throw noData();
      return state.zones[name];
    }
    async resolve4(name: string) {
      this.log('A', name);
      if (this.servers) return state.a[this.servers[0]]();
      if (!state.nsAddresses[name]) throw noData();
      return state.nsAddresses[name];
    }
    async resolveCname(name: string) {
      this.log('CNAME', name);
      const answer = this.servers && state.cname[this.servers[0]];
      if (!answer) throw noData();
      return answer();
    }
  }
  return { state, Resolver };
});

// The module-level functions all go through the system resolver; none may ever be used.
vi.mock('node:dns/promises', async (importOriginal) => {
  const refuse = (fn: string) => async (name: string) => {
    dns.state.moduleLevel.push(`${fn}(${name})`);
    throw new Error(`${fn} uses the system resolver`);
  };
  return {
    ...(await importOriginal<typeof DnsPromises>()),
    Resolver: dns.Resolver,
    lookup: refuse('lookup'),
    resolve: refuse('resolve'),
    resolve4: refuse('resolve4'),
    resolveCname: refuse('resolveCname'),
    resolveNs: refuse('resolveNs'),
  };
});

const { __resetDevTunnelDnsServersForTest, getDevTunnelDnsReadiness, isDevTunnelHostPublished } =
  await import('~/server/services/blocks/dev-tunnel-dns.service');

/** The two nameservers that get asked answer `first` and `second` to an address query. */
function nameservers(first: Answer, second: Answer = first) {
  dns.state.a = { [FIRST]: first, [SECOND]: second };
}

const hostQueries = () => dns.state.queries.filter((q) => q.name.includes('dev-'));
const systemQueries = () => dns.state.queries.filter((q) => q.servers === null);

let warn: ReturnType<typeof vi.spyOn>;
const warnings = () => warn.mock.calls.map(([line]) => JSON.parse(line as string));

beforeEach(() => {
  __resetDevTunnelDnsServersForTest();
  setEnv({ APPS_DOMAIN: DOMAIN, APPS_DEV_TUNNEL_INGRESS_TARGET: '192.0.2.1' });
  Object.assign(dns.state, {
    zones: { [`${DOMAIN}.`]: NS_NAMES },
    nsAddresses: NS_ADDRESSES,
    cname: {},
    queries: [],
    options: [],
    moduleLevel: [],
  });
  nameservers(address);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isDevTunnelHostPublished', () => {
  it('is ready once the authoritative nameservers answer with an address', async () => {
    expect(await isDevTunnelHostPublished(HOST)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is not ready on NXDOMAIN, quietly', async () => {
    nameservers(fails('ENOTFOUND'));
    expect(await isDevTunnelHostPublished(HOST)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is not ready on an answer that carries no address and no alias', async () => {
    nameservers(async () => []);
    expect(await isDevTunnelHostPublished(HOST)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['ETIMEOUT', 'ECONNREFUSED', 'ESERVFAIL'])(
    'fails open, and does not throw, when every query fails with %s',
    async (code) => {
      nameservers(fails(code));
      await expect(isDevTunnelHostPublished(HOST)).resolves.toBe(true);
      expect(warnings()).toEqual([
        { event: 'app-blocks.dev-tunnel.dns-ready.error', code, error: `query ${code}` },
      ]);
    }
  );

  it('logs a failing check once per window, not once per query', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    nameservers(fails('ETIMEOUT'));
    await isDevTunnelHostPublished(HOST);
    vi.advanceTimersByTime(14_999);
    await isDevTunnelHostPublished(HOST);
    expect(warnings()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    await isDevTunnelHostPublished(HOST);
    expect(warnings()).toHaveLength(2);
  });

  it('is not ready while one nameserver has the record and another does not', async () => {
    nameservers(address, fails('ENOTFOUND'));
    expect(await isDevTunnelHostPublished(HOST)).toBe(false);
    nameservers(fails('ENOTFOUND'), address);
    expect(await isDevTunnelHostPublished(HOST)).toBe(false);
  });

  it('is ready on one positive answer when the other nameserver cannot be reached', async () => {
    nameservers(fails('ETIMEOUT'), address);
    expect(await isDevTunnelHostPublished(HOST)).toBe(true);
    expect(warnings()).toHaveLength(1);
  });

  // Measured against real nameservers: an address query for an alias succeeds with no addresses.
  // The ENODATA spelling is kept for resolvers that report it that way.
  it.each<[string, Answer]>([
    ['an empty answer', async () => []],
    ['ENODATA', fails('ENODATA')],
  ])('counts an alias as published when the address query gives %s', async (_label, a) => {
    nameservers(a);
    const alias: Answer = async () => ['edge.example.net'];
    dns.state.cname = { [FIRST]: alias, [SECOND]: alias };
    expect(await isDevTunnelHostPublished(HOST)).toBe(true);
    expect(hostQueries().map((q) => q.type)).toEqual(['A', 'A', 'CNAME', 'CNAME']);
  });

  it('is not ready when both the address and the alias query come back empty', async () => {
    nameservers(async () => []);
    dns.state.cname = { [FIRST]: async () => [], [SECOND]: async () => [] };
    expect(await isDevTunnelHostPublished(HOST)).toBe(false);
  });

  it('is not ready for a name that exists with neither an address nor an alias', async () => {
    nameservers(fails('ENODATA'));
    expect(await isDevTunnelHostPublished(HOST)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks only the authoritative nameservers about the host, never the system resolver', async () => {
    await isDevTunnelHostPublished(HOST);

    // One address for each of the first two nameservers, each asked on a resolver of its own,
    // for the absolute name.
    expect(hostQueries()).toEqual([
      { servers: [FIRST], type: 'A', name: `${HOST}.` },
      { servers: [SECOND], type: 'A', name: `${HOST}.` },
    ]);
    expect(systemQueries()).toEqual([
      { servers: null, type: 'NS', name: `${DOMAIN}.` },
      { servers: null, type: 'A', name: 'ns1.dns.example.' },
      { servers: null, type: 'A', name: 'ns2.dns.example.' },
    ]);
    expect(dns.state.moduleLevel).toEqual([]);
    // An unreachable nameserver costs one short timeout, not the resolver's defaults.
    expect(dns.state.options).toHaveLength(3);
    for (const options of dns.state.options) expect(options).toEqual({ timeout: 1_500, tries: 1 });
  });

  it('finds the nameservers of the enclosing zone when the apps domain is not a zone apex', async () => {
    setEnv({ APPS_DOMAIN: `preview.${DOMAIN}` });
    expect(await isDevTunnelHostPublished(`dev-0123456789abcdef.preview.${DOMAIN}`)).toBe(true);
    expect(systemQueries().slice(0, 2)).toEqual([
      { servers: null, type: 'NS', name: `preview.${DOMAIN}.` },
      { servers: null, type: 'NS', name: `${DOMAIN}.` },
    ]);
    expect(hostQueries().map((q) => q.servers)).toEqual([[FIRST], [SECOND]]);
  });

  it('skips a nameserver whose address cannot be found', async () => {
    dns.state.nsAddresses = { 'ns2.dns.example.': [SECOND] };
    expect(await isDevTunnelHostPublished(HOST)).toBe(true);
    expect(hostQueries().map((q) => q.servers)).toEqual([[SECOND]]);
  });

  describe('nameserver discovery cache', () => {
    const nsLookups = () => dns.state.queries.filter((q) => q.type === 'NS').length;

    it('discovers once, then again after ten minutes', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await isDevTunnelHostPublished(devHost(1));
      await isDevTunnelHostPublished(devHost(2));
      expect(nsLookups()).toBe(1);
      vi.advanceTimersByTime(10 * 60_000 - 1);
      await isDevTunnelHostPublished(devHost(3));
      expect(nsLookups()).toBe(1);
      vi.advanceTimersByTime(2);
      await isDevTunnelHostPublished(devHost(4));
      expect(nsLookups()).toBe(2);
    });

    it('shares one discovery between concurrent checks', async () => {
      await Promise.all([isDevTunnelHostPublished(HOST), isDevTunnelHostPublished(HOST)]);
      expect(nsLookups()).toBe(1);
    });

    it('fails open when no nameserver can be found, retries only after a short pause, and recovers', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      dns.state.zones = {};
      await expect(isDevTunnelHostPublished(HOST)).resolves.toBe(true);
      await expect(isDevTunnelHostPublished(HOST)).resolves.toBe(true);
      expect(nsLookups()).toBe(1);
      expect(hostQueries()).toEqual([]);
      expect(warnings()).toEqual([
        {
          event: 'app-blocks.dev-tunnel.dns-ready.error',
          error: 'no authoritative nameserver found',
        },
      ]);

      dns.state.zones = { [`${DOMAIN}.`]: NS_NAMES };
      nameservers(fails('ENOTFOUND'));
      vi.advanceTimersByTime(14_999);
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      expect(nsLookups()).toBe(1);
      vi.advanceTimersByTime(2);
      expect(await isDevTunnelHostPublished(HOST)).toBe(false);
      expect(nsLookups()).toBe(2);
    });

    it('does not reuse one apps domain’s nameservers for another', async () => {
      await isDevTunnelHostPublished(HOST);
      setEnv({ APPS_DOMAIN: 'other.example' });
      expect(await isDevTunnelHostPublished('dev-0123456789abcdef.other.example')).toBe(true);
      expect(hostQueries().some((q) => q.name.includes('other.example'))).toBe(false);
      expect(
        systemQueries()
          .filter((q) => q.type === 'NS')
          .map((q) => q.name)
      ).toEqual([`${DOMAIN}.`, 'other.example.']);
    });
  });

  describe('when no nameserver can be asked', () => {
    it('is ready when discovery finds no nameserver', async () => {
      dns.state.zones = {};
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      expect(hostQueries()).toEqual([]);
      expect(warnings().map((w) => w.error)).toEqual(['no authoritative nameserver found']);
    });

    it('is ready when every nameserver errors or times out', async () => {
      nameservers(fails('ETIMEOUT'), fails('ESERVFAIL'));
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      expect(hostQueries()).toHaveLength(2);
      expect(warnings().map((w) => w.code)).toEqual(['ETIMEOUT', 'ESERVFAIL']);
    });

    it.each(['ENOTFOUND', 'ENODATA'])(
      'is still not ready when one nameserver answers %s and the other errors',
      async (code) => {
        nameservers(fails(code), fails('ETIMEOUT'));
        expect(await isDevTunnelHostPublished(HOST)).toBe(false);
        nameservers(fails('ETIMEOUT'), fails(code));
        expect(await isDevTunnelHostPublished(HOST)).toBe(false);
      }
    );
  });

  describe('hosts seen published', () => {
    const queriesFor = (host: string) => hostQueries().filter((q) => q.name === `${host}.`);

    it.each(['ETIMEOUT', 'ENOTFOUND'])(
      'stay ready with no further lookup, even once the nameservers answer %s',
      async (code) => {
        expect(await isDevTunnelHostPublished(HOST)).toBe(true);
        const before = dns.state.queries.length;
        nameservers(fails(code));
        dns.state.zones = {};
        expect(await isDevTunnelHostPublished(HOST)).toBe(true);
        expect(dns.state.queries.length - before).toBe(0);
      }
    );

    it('are asked about again after eight hours', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      nameservers(fails('ENOTFOUND'));
      vi.advanceTimersByTime(8 * 60 * 60_000 - 1);
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      expect(queriesFor(HOST)).toHaveLength(2);
      vi.advanceTimersByTime(2);
      expect(await isDevTunnelHostPublished(HOST)).toBe(false);
      expect(queriesFor(HOST)).toHaveLength(4);
    });

    it('include a host one nameserver confirmed while the other could not be reached', async () => {
      nameservers(fails('ETIMEOUT'), address);
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      nameservers(fails('ENOTFOUND'));
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      expect(queriesFor(HOST)).toHaveLength(2);
    });

    it('never include a host last seen missing', async () => {
      nameservers(fails('ENOTFOUND'));
      expect(await isDevTunnelHostPublished(HOST)).toBe(false);
      nameservers(address);
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      expect(queriesFor(HOST)).toHaveLength(4);
    });

    it('never include a host only failed open on', async () => {
      nameservers(fails('ETIMEOUT'));
      expect(await isDevTunnelHostPublished(HOST)).toBe(true);
      nameservers(fails('ENOTFOUND'));
      expect(await isDevTunnelHostPublished(HOST)).toBe(false);
    });

    it('are capped at 1000, forgetting the oldest first', async () => {
      for (let n = 0; n <= 1000; n++) expect(await isDevTunnelHostPublished(devHost(n))).toBe(true);
      nameservers(fails('ENOTFOUND'));
      dns.state.queries = [];

      expect(await isDevTunnelHostPublished(devHost(1))).toBe(true);
      expect(await isDevTunnelHostPublished(devHost(1000))).toBe(true);
      expect(hostQueries()).toEqual([]);

      expect(await isDevTunnelHostPublished(devHost(0))).toBe(false);
      expect(queriesFor(devHost(0))).toHaveLength(2);
    });
  });

  it('refuses a name outside the dev-host shape without any lookup', async () => {
    for (const host of ['example.org', `my-app.${DOMAIN}`, `dev-0123456789abcdef.${DOMAIN}.evil`])
      expect(await isDevTunnelHostPublished(host)).toBe(false);
    expect(dns.state.queries).toEqual([]);
  });

  it('is always ready, with no lookup, where this deployment publishes no record per tunnel', async () => {
    setEnv({ APPS_DEV_TUNNEL_INGRESS_TARGET: undefined });
    nameservers(fails('ENOTFOUND'));
    expect(await isDevTunnelHostPublished(HOST)).toBe(true);
    expect(dns.state.queries).toEqual([]);
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
    nameservers(fails('ENOTFOUND'));
    expect(await getDevTunnelDnsReadiness(OWNER, 'my-app')).toEqual({ active: true, ready: false });

    nameservers(address);
    expect(await getDevTunnelDnsReadiness(OWNER, 'my-app')).toEqual({ active: true, ready: true });
    expect(hostQueries().map((q) => q.name)).toEqual(Array(4).fill(`${HOST}.`));
  });

  it("refuses another user's tunnel for the same app, with no lookup", async () => {
    seed({ userId: OWNER, blockId: 'my-app' }, SESSION);
    expect(await getDevTunnelDnsReadiness(999, 'my-app')).toEqual({ active: false });
    expect(dns.state.queries).toEqual([]);
  });

  it('refuses a session that is not the caller’s even when their index points at it', async () => {
    seed({ userId: 999, blockId: 'my-app' }, SESSION);
    expect(await getDevTunnelDnsReadiness(999, 'my-app')).toEqual({ active: false });
    expect(dns.state.queries).toEqual([]);
  });
});
