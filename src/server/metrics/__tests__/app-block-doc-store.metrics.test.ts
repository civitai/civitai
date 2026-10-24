import client, { Registry } from 'prom-client';
import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { DocStoreDb } from '~/server/services/apps/doc-store';

/**
 * The document store's own series:
 *   - `civitai_app_block_doc_store_errors_total{endpoint, code}` moves once per error envelope
 *     the storage route sends, with the envelope's own code — whichever layer refused;
 *   - `civitai_app_block_doc_store_enabled` reads 0 when the store has no connection or its role
 *     check refuses, 1 once the role is confirmed;
 *   - the review-storage cleanup/sweep counters and the server-fault error series are published
 *     at 0 before anything has fired, so "never fired" is not "never wired".
 *
 * Every counter read is a before/after DELTA on the default registry (other files in a worker may
 * share it); the seeding cases use a FRESH registry, where a series that exists can only have come
 * from the seeder.
 */

// The route reads the caller's access before anything else; each case decides what it does.
const access = vi.hoisted(() => ({ fail: undefined as unknown }));
vi.mock('~/server/services/apps/doc-store-access', () => ({
  resolveStorageAccess: vi.fn(async () => {
    throw access.fail;
  }),
}));
// The process store is never reached by these cases; the route takes its store from deps.
vi.mock('~/server/db/appdataDb', () => ({ appdataDb: null }));

const ERRORS = 'civitai_app_block_doc_store_errors_total';
const ENABLED = 'civitai_app_block_doc_store_enabled';
const CLEANUP = 'civitai_app_block_review_storage_cleanup_total';
const SWEEP = 'civitai_app_block_review_storage_sweep_total';

type Point = { labels: Record<string, string | number>; value: number };

async function values(name: string, reg: Registry = client.register): Promise<Point[]> {
  const metric = reg.getSingleMetric(name) as
    | { get(): Promise<{ values: Point[] }> | { values: Point[] } }
    | undefined;
  if (!metric) return [];
  return (await metric.get()).values;
}

async function errorCount(endpoint: string, code: string): Promise<number> {
  const hit = (await values(ERRORS)).find(
    (v) => v.labels.endpoint === endpoint && v.labels.code === code
  );
  return hit?.value ?? 0;
}

async function enabledValue(reg: Registry = client.register): Promise<number | undefined> {
  return (await values(ENABLED, reg))[0]?.value;
}

function fakeReq(method: string, path: string[], extra: Record<string, unknown> = {}) {
  return {
    method,
    query: { path },
    headers: {},
    destroyed: false,
    ...extra,
  } as unknown as NextApiRequest;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    destroyed: false,
    writableEnded: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.writableEnded = true;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
  };
  return res;
}

const CLAIMS = { blockClaims: { appBlockId: 'app_1', sub: '1', scopes: ['apps:storage'] } };

async function serve(req: NextApiRequest) {
  const { createStorageHandler } = await import('~/server/services/apps/doc-store-api');
  const handler = createStorageHandler({ store: () => ({} as never) });
  const res = fakeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

describe('civitai_app_block_doc_store_errors_total', () => {
  it('counts a 401 refusal under its code and endpoint', async () => {
    const before = await errorCount('storage_info', 'unauthenticated');
    const res = await serve(fakeReq('GET', []));
    expect(res.statusCode).toBe(401);
    expect((res.body as { code: string }).code).toBe('unauthenticated');
    expect(await errorCount('storage_info', 'unauthenticated')).toBe(before + 1);
  });

  it('counts a 503 storage_disabled under its code, on the read endpoint', async () => {
    access.fail = new DocStoreError('storage_disabled', 'document storage is not configured');
    const before = await errorCount('storage_read', 'storage_disabled');
    const otherBefore = await errorCount('storage_info', 'storage_disabled');
    const res = await serve(fakeReq('GET', ['notes'], CLAIMS));
    expect(res.statusCode).toBe(503);
    expect(await errorCount('storage_read', 'storage_disabled')).toBe(before + 1);
    // The label is the request's endpoint, not a constant.
    expect(await errorCount('storage_info', 'storage_disabled')).toBe(otherBefore);
  });

  it('counts a fault that is not a DocStoreError as internal_error (500)', async () => {
    access.fail = new Error('boom');
    const before = await errorCount('storage_write', 'internal_error');
    const res = await serve(fakeReq('PUT', ['notes', 'k1'], CLAIMS));
    expect(res.statusCode).toBe(500);
    expect(await errorCount('storage_write', 'internal_error')).toBe(before + 1);
  });

  it('counts a 405 method_not_allowed', async () => {
    const before = await errorCount('storage_info', 'method_not_allowed');
    const res = await serve(fakeReq('PATCH', []));
    expect(res.statusCode).toBe(405);
    expect(await errorCount('storage_info', 'method_not_allowed')).toBe(before + 1);
  });

  it('counts a token-middleware refusal written in the storage envelope', async () => {
    const { storageRefusalBody } = await import('~/server/services/apps/doc-store-api');
    const before = await errorCount('storage_tally', 'insufficient_scope');
    const body = storageRefusalBody(
      { kind: 'insufficient_scope', status: 403, error: 'missing scope' },
      fakeReq('POST', ['notes', 'k1', 'counters', 'likes'])
    );
    expect(body.code).toBe('insufficient_scope');
    expect(await errorCount('storage_tally', 'insufficient_scope')).toBe(before + 1);
  });
});

describe('civitai_app_block_doc_store_enabled', () => {
  const roleDb = (row: Record<string, unknown> | undefined): DocStoreDb => ({
    connect: async () => ({
      query: async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
      release: () => undefined,
    }),
  });

  it('is published at 0 the moment the registry is built, before any probe', async () => {
    const { ensureRegisterAppBlockRuntimeMetrics } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const reg = new Registry();
    ensureRegisterAppBlockRuntimeMetrics(reg);
    expect(await enabledValue(reg)).toBe(0);
  });

  it('reads 0 with no connection, 1 for a confirmed role, 0 for a role that bypasses RLS', async () => {
    const { createDocStore } = await import('~/server/services/apps/doc-store');
    const { refreshDocStoreEnabled } = await import('~/server/services/apps/doc-store.instance');

    await refreshDocStoreEnabled(createDocStore({ db: null }));
    expect(await enabledValue()).toBe(0);

    await refreshDocStoreEnabled(
      createDocStore({
        db: roleDb({ rolname: 'r', rolsuper: false, rolbypassrls: false }),
      })
    );
    expect(await enabledValue()).toBe(1);

    await refreshDocStoreEnabled(
      createDocStore({
        db: roleDb({ rolname: 'r', rolsuper: false, rolbypassrls: true }),
      })
    );
    expect(await enabledValue()).toBe(0);

    // A role pg_roles cannot describe is refused like the store refuses it.
    await refreshDocStoreEnabled(createDocStore({ db: roleDb(undefined) }));
    expect(await enabledValue()).toBe(0);
  });

  it('reads 0 when the role cannot be read at all (not confirmed usable)', async () => {
    const { createDocStore } = await import('~/server/services/apps/doc-store');
    const { refreshDocStoreEnabled } = await import('~/server/services/apps/doc-store.instance');
    await refreshDocStoreEnabled(
      createDocStore({
        db: roleDb({ rolname: 'r', rolsuper: false, rolbypassrls: false }),
      })
    );
    expect(await enabledValue()).toBe(1);
    await refreshDocStoreEnabled(
      createDocStore({
        db: {
          connect: async () => {
            throw new Error('connection refused');
          },
        },
      })
    );
    expect(await enabledValue()).toBe(0);
  });

  it('agrees with the store: a refused role is the same store that answers storage_disabled', async () => {
    const { createDocStore } = await import('~/server/services/apps/doc-store');
    const store = createDocStore({
      db: roleDb({ rolname: 'r', rolsuper: true, rolbypassrls: false }),
    });
    expect(await store.isUsable()).toBe(false);
    await expect(store.usage({ appId: 'app_1', ns: 'prod', viewerUid: 1 })).rejects.toMatchObject({
      code: 'storage_disabled',
    });
  });
});

describe('seeded series', () => {
  it('publishes every review cleanup and sweep outcome at 0', async () => {
    const { seedAppBlockDocStoreMetrics } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const reg = new Registry();
    seedAppBlockDocStoreMetrics(reg);

    const cleanup = await values(CLEANUP, reg);
    expect(cleanup.map((v) => v.labels.outcome).sort()).toEqual(
      ['disabled', 'failed', 'nothing', 'purged'].sort()
    );
    expect(cleanup.every((v) => v.value === 0)).toBe(true);

    const sweep = await values(SWEEP, reg);
    expect(sweep.map((v) => v.labels.outcome).sort()).toEqual(['failed', 'purged']);
    expect(sweep.every((v) => v.value === 0)).toBe(true);
  });

  it('publishes every server-fault (5xx) error code at 0 on each endpoint that can raise it', async () => {
    const { seedAppBlockDocStoreMetrics } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const { STORAGE_ERROR_STATUS } = await import('~/server/services/apps/doc-store-api');
    const reg = new Registry();
    seedAppBlockDocStoreMetrics(reg);

    const seeded = await values(ERRORS, reg);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((v) => v.value === 0)).toBe(true);

    // Every 5xx code is seeded somewhere, and nothing but 5xx codes is.
    const fiveXx = Object.entries(STORAGE_ERROR_STATUS)
      .filter(([, status]) => status >= 500)
      .map(([code]) => code)
      .sort();
    expect([...new Set(seeded.map((v) => String(v.labels.code)))].sort()).toEqual(fiveXx);

    const has = (endpoint: string, code: string) =>
      seeded.some((v) => v.labels.endpoint === endpoint && v.labels.code === code);
    for (const endpoint of ['storage_info', 'storage_read', 'storage_write', 'storage_tally']) {
      expect(has(endpoint, 'storage_disabled')).toBe(true);
      expect(has(endpoint, 'internal_error')).toBe(true);
    }
    // Moderation runs only on writes and tallies.
    expect(has('storage_write', 'moderation_unavailable')).toBe(true);
    expect(has('storage_tally', 'moderation_unavailable')).toBe(true);
    expect(has('storage_read', 'moderation_unavailable')).toBe(false);
    expect(has('storage_info', 'moderation_unavailable')).toBe(false);
    // Consent is checked only when a write publishes.
    expect(has('storage_write', 'consent_unavailable')).toBe(true);
    expect(has('storage_read', 'consent_unavailable')).toBe(false);
    expect(has('storage_info', 'consent_unavailable')).toBe(false);
    expect(has('storage_tally', 'consent_unavailable')).toBe(false);
  });

  it('seeding does not reset a series that has already counted', async () => {
    const { ensureRegisterAppBlockRuntimeMetrics, seedAppBlockDocStoreMetrics } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const reg = new Registry();
    ensureRegisterAppBlockRuntimeMetrics(reg).reviewStorageSweepTotal.inc({ outcome: 'failed' });
    seedAppBlockDocStoreMetrics(reg);
    seedAppBlockDocStoreMetrics(reg);
    const failed = (await values(SWEEP, reg)).find((v) => v.labels.outcome === 'failed');
    expect(failed?.value).toBe(1);
  });
});
