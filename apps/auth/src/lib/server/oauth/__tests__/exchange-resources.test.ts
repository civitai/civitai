import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  clientIds: [] as string[],
  clientRows: [] as Record<string, unknown>[],
  dev: false,
  logs: [] as Record<string, unknown>[],
}));

vi.mock('$app/environment', () => ({
  get dev() {
    return h.dev;
  },
}));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: async (data: Record<string, unknown>) => {
    h.logs.push(data);
  },
}));
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom: () => {
      let ids: string[] = [];
      const qb = {
        select: () => qb,
        where: (_c: string, _op: string, value: string[]) => {
          ids = value;
          return qb;
        },
        execute: async () => [
          ...h.clientIds.filter((id) => ids.includes(id)).map((id) => ({ id })),
          ...h.clientRows.filter((r) => ids.includes(r.id as string)),
        ],
      };
      return qb;
    },
  },
}));

import { TokenScope } from '@civitai/auth/token-scope';
import { getExchangeResources, parseExchangeResources } from '../exchange-resources';

const entry = (over: Record<string, unknown> = {}) => ({
  resource: 'https://registry.test',
  scopes: ['AIServicesRead', 'AIServicesWrite'],
  apps: ['app-1'],
  relays: ['relay-1'],
  introspectors: ['origin-1'],
  ...over,
});
const parse = (...entries: unknown[]) => parseExchangeResources(JSON.stringify(entries));

beforeEach(() => {
  h.clientIds = [];
  h.clientRows = [];
  h.dev = false;
  h.logs = [];
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
});

describe('parseExchangeResources', () => {
  it('parses a valid entry, scopes as a bitmask', () => {
    expect(parse(entry())).toEqual({
      resources: [
        {
          resource: 'https://registry.test',
          scopes: TokenScope.AIServicesRead | TokenScope.AIServicesWrite,
          apps: ['app-1'],
          relays: ['relay-1'],
          introspectors: ['origin-1'],
          services: [],
          serviceSubjects: [],
        },
      ],
      serviceErrors: [],
    });
  });

  it('accepts the Apps scopes (bits 31, 32): they are user scopes a resource may receive', () => {
    const parsed = parse(entry({ scopes: ['AppsRead', 'AppDataRead'] }));
    expect(parsed).not.toHaveProperty('error');
    expect((parsed as { resources: { scopes: bigint }[] }).resources[0].scopes).toBe(6442450944n);
  });

  it('treats unset as no resources', () => {
    expect(parseExchangeResources(undefined)).toEqual({ resources: [], serviceErrors: [] });
    expect(parseExchangeResources('')).toEqual({ resources: [], serviceErrors: [] });
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['an http resource', { resource: 'http://registry.test' }],
    ['a relative resource', { resource: '/registry' }],
    ['a trailing slash', { resource: 'https://registry.test/' }],
    ['a query', { resource: 'https://registry.test/x?a=1' }],
    ['a fragment', { resource: 'https://registry.test/x#a' }],
    ['an unknown scope', { scopes: ['AIServicesRead', 'Nope'] }],
    ['UserRead', { scopes: ['UserRead', 'AIServicesRead'] }],
    ['a client-only scope', { scopes: ['AppStoreCatalogWrite'] }],
    ['a worker scope', { scopes: ['WorkerRegister'] }],
    ['no scopes', { scopes: [] }],
    ['no apps', { apps: [] }],
    ['a client id outside the charset', { relays: ['relay 1'] }],
    ['a list that is not a list', { introspectors: 'origin-1' }],
  ];
  it.each(invalid)('refuses %s', (_, over) => {
    expect(parse(entry(over))).toHaveProperty('error');
  });

  it('refuses a resource listed twice', () => {
    expect(parse(entry(), entry())).toHaveProperty('error');
    expect(parse(entry(), entry({ resource: 'https://registry2.test' }))).toHaveProperty(
      'resources'
    );
  });

  it('allows a localhost resource only on a local hub', () => {
    const local = entry({ resource: 'http://orchestration.localhost:5000' });
    expect(parse(local)).toHaveProperty('error');
    process.env.AUTH_JWT_ISSUER = 'http://localhost:3000';
    expect(parse(local)).toHaveProperty('resources');
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
    h.dev = true;
    expect(parse(local)).toHaveProperty('resources');
  });
});

describe('getExchangeResources', () => {
  it('registers nothing when any entry is invalid', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([
      entry(),
      entry({ resource: 'https://b.test', scopes: ['UserRead'] }),
    ]);
    expect(await getExchangeResources()).toEqual([]);
    expect(h.logs[0]).toMatchObject({ type: 'error', name: 'oauth-exchange-resources-invalid' });
    // Control: the valid entry alone registers.
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([entry()]);
    expect(await getExchangeResources()).toHaveLength(1);
  });

  it('registers nothing when a resource is also an OAuth client id', async () => {
    h.clientIds = ['https://registry.test'];
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([
      entry(),
      { ...entry(), resource: 'https://c.test' },
    ]);
    expect(await getExchangeResources()).toEqual([]);
    h.clientIds = [];
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([entry()]);
    expect(await getExchangeResources()).toHaveLength(1);
  });
});

describe('parseExchangeResources — services', () => {
  const CACHER = '0b7c4a52-1f3e-4d6a-9c2b-5e8f7a6d4c3b';
  const OTHER = '6a1d2e3f-4b5c-4d7e-8f90-a1b2c3d4e5f6';
  const service = (over: Record<string, unknown> = {}) => ({
    client: CACHER,
    scopes: ['AIServicesWrite'],
    roles: ['trusted'],
    uid: -1001,
    ...over,
  });
  const resourcesOf = (result: ReturnType<typeof parse>) => {
    if (!('resources' in result)) throw new Error(result.error);
    return result.resources;
  };
  const servicesOf = (result: ReturnType<typeof parse>, i = 0) => resourcesOf(result)[i].services;

  it('parses a service entry, scopes as a bitmask and roles in order', () => {
    const result = parse(entry({ services: [service({ roles: ['trusted', 'Manager'] })] }));
    expect(servicesOf(result)).toEqual([
      {
        client: CACHER,
        scopes: TokenScope.AIServicesWrite,
        roles: ['trusted', 'Manager'],
        uid: -1001,
      },
    ]);
    expect(result).toMatchObject({ serviceErrors: [] });
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['a numeric client id', { client: '12345' }],
    ['a client id that is not a UUID', { client: 'image-cacher' }],
    ['a client id from another id family', { client: 'appblk-cacher' }],
    ['scopes outside the resource', { scopes: ['ModelsRead'] }],
    ['UserRead', { scopes: ['UserRead'] }],
    ['a client-only scope', { scopes: ['AppStoreCatalogWrite'] }],
    ['no scopes', { scopes: [] }],
    ['a role outside the charset', { roles: ['trusted role'] }],
    ['a role that is not a string', { roles: [7] }],
    ['more than 16 roles', { roles: Array.from({ length: 17 }, (_, i) => `r${i}`) }],
    ['no uid', { uid: undefined }],
    ['uid -999', { uid: -999 }],
    ['uid -1, the system account', { uid: -1 }],
    ['a positive uid', { uid: 1001 }],
    ['a uid below int32', { uid: -(2 ** 31) - 1 }],
    ['a fractional uid', { uid: -1000.5 }],
  ];
  it.each(invalid)("empties only that resource's services for %s", (_, over) => {
    const result = parse(
      entry({ services: [service(over)] }),
      entry({ resource: 'https://b.test', services: [service({ client: OTHER, uid: -1002 })] })
    );
    expect(servicesOf(result, 0)).toEqual([]);
    expect(servicesOf(result, 1)).toHaveLength(1);
    expect(resourcesOf(result)[0]).toMatchObject({
      apps: ['app-1'],
      relays: ['relay-1'],
      introspectors: ['origin-1'],
    });
    expect(result).toMatchObject({ serviceErrors: [expect.any(String)] });
  });

  it('accepts the bounds: uid -1000 and int32 min, 16 roles', () => {
    for (const over of [
      { uid: -1000 },
      { uid: -(2 ** 31) },
      { roles: Array.from({ length: 16 }, (_, i) => `r${i}`) },
    ]) {
      expect(servicesOf(parse(entry({ services: [service(over)] })))).toHaveLength(1);
    }
  });

  it('drops the services, never the app, when a client is both', () => {
    for (const lists of [{ apps: ['app-1', CACHER] }, { relays: [CACHER] }]) {
      const result = parse(entry({ ...lists, services: [service()] }));
      expect(servicesOf(result)).toEqual([]);
      expect(resourcesOf(result)[0]).toMatchObject(lists);
    }
    // An app of another resource counts too.
    const across = parse(
      entry({ services: [service()] }),
      entry({ resource: 'https://b.test', apps: [CACHER] })
    );
    expect(servicesOf(across, 0)).toEqual([]);
  });

  it('keeps a uid for the first resource that uses it, and drops the services of a later one', () => {
    const result = parse(
      entry({ services: [service()] }),
      entry({ resource: 'https://b.test', services: [service({ client: OTHER })] }),
      entry({ resource: 'https://c.test', services: [service({ client: OTHER, uid: -1002 })] })
    );
    expect(servicesOf(result, 0)).toHaveLength(1);
    expect(servicesOf(result, 1)).toEqual([]);
    expect(servicesOf(result, 2)).toHaveLength(1);
    expect(result).toMatchObject({ serviceErrors: [expect.stringContaining('https://b.test')] });
    // The same client keeps one uid per resource: listing it on two resources needs two uids.
    const twoResources = parse(
      entry({ services: [service()] }),
      entry({ resource: 'https://b.test', services: [service()] })
    );
    expect(servicesOf(twoResources, 1)).toEqual([]);
    // Within one resource too.
    expect(servicesOf(parse(entry({ services: [service(), service({ client: OTHER })] })))).toEqual(
      []
    );
  });

  it('drops a services list that is not a list, or names a client twice', () => {
    expect(servicesOf(parse(entry({ services: service() })))).toEqual([]);
    expect(servicesOf(parse(entry({ services: [service(), service({ uid: -1002 })] })))).toEqual(
      []
    );
  });
});

describe('getExchangeResources — services', () => {
  const CACHER = '0b7c4a52-1f3e-4d6a-9c2b-5e8f7a6d4c3b';
  const withService = () =>
    JSON.stringify([
      entry({
        services: [{ client: CACHER, scopes: ['AIServicesWrite'], roles: [], uid: -1001 }],
      }),
    ]);
  const row = (over: Record<string, unknown> = {}) => ({
    id: CACHER,
    userId: -1,
    grants: ['urn:civitai:grant:service'],
    isConfidential: true,
    secret: 'hash',
    accessMode: 'open',
    ...over,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('logs a dropped services list at error level', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([
      entry({ services: [{ client: '12345', scopes: ['AIServicesWrite'], uid: -1001 }] }),
    ]);
    const [r] = await getExchangeResources();
    expect(r.services).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ type: 'error', name: 'oauth-exchange-services-invalid' })
    );
  });

  it('only warns about a service client row that cannot get tokens, and keeps the entry', async () => {
    h.clientRows = [row({ grants: ['urn:civitai:grant:service', 'client_credentials'] })];
    process.env.OAUTH_EXCHANGE_RESOURCES = withService();
    const [r] = await getExchangeResources();
    await flush();
    expect(r.services).toHaveLength(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ type: 'warning', name: 'oauth-exchange-service-client' })
    );
    // Control: a service client row as the admin page creates it logs nothing.
    h.logs = [];
    h.clientRows = [row()];
    process.env.OAUTH_EXCHANGE_RESOURCES = `${withService()} `;
    await getExchangeResources();
    await flush();
    expect(h.logs).toEqual([]);
  });
});
