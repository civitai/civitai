import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ModelVersion is the only entity type whose availability comes from a Redis cache rather than a
 * live query, and `hasEntityAccess` used to collapse "the cache had no record for this id" into
 * the same shape as "the record says Private" — a fail-CLOSED default. A cache that omits an id
 * (evicted, never written because `dontCacheFn` refused it, cluster hiccup) therefore denied
 * download AND generation to every signed-in non-moderator, non-owner on a perfectly Public model.
 *
 * The DB is the authority: an id the cache can't resolve must be re-read, not denied.
 */

vi.mock('@prisma/client', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
    sql: strings.join('?'),
  });
  const raw = (s: string) => ({ sql: s, values: [] });
  const join = (values: unknown[], separator = ',') => ({ values, separator });
  const empty = { sql: '', values: [] };
  class Sql {}
  const known: Record<string, unknown> = { sql, raw, join, empty, Sql, validator: () => (x: unknown) => x };
  const Prisma = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : {}),
  });
  return new Proxy(
    { Prisma, PrismaClient: class PrismaClient {} },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        if (prop === '__esModule') return true;
        return {};
      },
    }
  );
});

const dbReadQueryRaw = vi.fn();
const dbWriteQueryRaw = vi.fn();
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: (...args: unknown[]) => dbReadQueryRaw(...args) },
  dbWrite: { $queryRaw: (...args: unknown[]) => dbWriteQueryRaw(...args) },
}));

const modelVersionAccessFetch = vi.fn();
const lookupModelVersionAccessMock = vi.fn();
vi.mock('~/server/redis/caches', () => ({
  modelVersionAccessCache: { fetch: (...args: unknown[]) => modelVersionAccessFetch(...args) },
  lookupModelVersionAccess: (...args: unknown[]) => lookupModelVersionAccessMock(...args),
}));

const getPaidAccessMock = vi.fn();
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: (...args: unknown[]) => getPaidAccessMock(...args),
}));

import { hasEntityAccess } from '~/server/services/common.service';

const PUBLIC_VERSION = {
  entityId: 3156705,
  userId: 8319364,
  availability: 'Public',
  publishedAt: new Date('2026-07-29T15:58:16Z'),
  status: 'Published',
};

const byId = (...rows: typeof PUBLIC_VERSION[]) =>
  Object.fromEntries(rows.map((r) => [String(r.entityId), r]));

beforeEach(() => {
  vi.clearAllMocks();
  getPaidAccessMock.mockResolvedValue({});
  dbWriteQueryRaw.mockResolvedValue([]);
  dbReadQueryRaw.mockResolvedValue([]);
  lookupModelVersionAccessMock.mockResolvedValue({});
});

describe('hasEntityAccess — ModelVersion id the availability cache could not resolve', () => {
  it('re-reads the DB instead of denying a signed-in user', async () => {
    modelVersionAccessFetch.mockResolvedValue({});
    lookupModelVersionAccessMock.mockResolvedValue(byId(PUBLIC_VERSION));

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [3156705],
      userId: 1290051,
    });

    expect(lookupModelVersionAccessMock).toHaveBeenCalledWith([3156705]);
    expect(access.hasAccess).toBe(true);
    expect(access.availability).toBe('Public');
  });

  it('re-reads the DB instead of denying an anonymous user', async () => {
    modelVersionAccessFetch.mockResolvedValue({});
    lookupModelVersionAccessMock.mockResolvedValue(byId(PUBLIC_VERSION));

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [3156705],
    });

    expect(access.hasAccess).toBe(true);
  });

  it('still denies when the DB agrees the version is private', async () => {
    modelVersionAccessFetch.mockResolvedValue({});
    lookupModelVersionAccessMock.mockResolvedValue(
      byId({ ...PUBLIC_VERSION, availability: 'Private' })
    );

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [3156705],
      userId: 1290051,
    });

    expect(access.hasAccess).toBe(false);
    expect(access.availability).toBe('Private');
  });

  it('still denies when the version does not exist at all', async () => {
    modelVersionAccessFetch.mockResolvedValue({});
    lookupModelVersionAccessMock.mockResolvedValue({});

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [999999999],
      userId: 1290051,
    });

    expect(access.hasAccess).toBe(false);
    expect(access.availability).toBe('Private');
  });

  it('does not hit the DB when the cache resolved every id', async () => {
    modelVersionAccessFetch.mockResolvedValue(byId(PUBLIC_VERSION));

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [3156705],
      userId: 1290051,
    });

    expect(lookupModelVersionAccessMock).not.toHaveBeenCalled();
    expect(access.hasAccess).toBe(true);
  });

  it('only re-reads the ids the cache missed', async () => {
    modelVersionAccessFetch.mockResolvedValue(byId(PUBLIC_VERSION));
    lookupModelVersionAccessMock.mockResolvedValue(byId({ ...PUBLIC_VERSION, entityId: 111 }));

    const results = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [3156705, 111],
      userId: 1290051,
    });

    expect(lookupModelVersionAccessMock).toHaveBeenCalledWith([111]);
    expect(results.every((r) => r.hasAccess)).toBe(true);
  });

  it('re-reads instead of trusting a cached record that would deny', async () => {
    // A value this cache is not allowed to hold in the first place (dontCacheFn refuses non-Public),
    // so it can only be legacy poison — the exact state that made Public models undownloadable.
    modelVersionAccessFetch.mockResolvedValue(byId({ ...PUBLIC_VERSION, availability: 'EarlyAccess' }));
    lookupModelVersionAccessMock.mockResolvedValue(byId(PUBLIC_VERSION));

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [3156705],
      userId: 1290051,
    });

    expect(lookupModelVersionAccessMock).toHaveBeenCalledWith([3156705]);
    expect(access.hasAccess).toBe(true);
    expect(access.availability).toBe('Public');
  });

  it('a still-gated version stays gated when the DB has to resolve it', async () => {
    modelVersionAccessFetch.mockResolvedValue({});
    lookupModelVersionAccessMock.mockResolvedValue(byId(PUBLIC_VERSION));
    getPaidAccessMock.mockResolvedValue({
      3156705: { entityType: 'ModelVersion', entityId: 3156705, endsAt: null },
    });

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [3156705],
      userId: 1290051,
    });

    expect(access.hasAccess).toBe(false);
  });
});
