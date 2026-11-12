import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  clientIds: [] as string[],
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
        execute: async () => h.clientIds.filter((id) => ids.includes(id)).map((id) => ({ id })),
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
        },
      ],
    });
  });

  it('treats unset as no resources', () => {
    expect(parseExchangeResources(undefined)).toEqual({ resources: [] });
    expect(parseExchangeResources('')).toEqual({ resources: [] });
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
