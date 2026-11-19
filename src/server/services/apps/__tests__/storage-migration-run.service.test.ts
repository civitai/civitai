import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => {
    throw new Error('the tests pass their own store');
  },
}));

import type { DocStoreMaintenance, MigrateDocumentsResult } from '~/server/services/apps/doc-store';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { StorageMigrationRun } from '~/server/services/apps/storage-migration-run.service';
import { advanceStorageMigrationRun } from '~/server/services/apps/storage-migration-run.service';

/**
 * The run loop (`advanceStorageMigrationRun`) over a scripted store: what it persists after each
 * page, when it stops, and what status it leaves. The store operation itself is exercised on a
 * real database in `doc-store.migrate.test.ts`.
 */

const COLLECTION = {
  name: 'cards',
  config: {
    kind: 'docs',
    visibility: 'private',
    counters: [],
    marks: [],
    indexes: new Map(),
    showAuthor: false,
    // The new schema no longer allows `legacy`, so the declared `remove /legacy` deletes it.
    schema: { type: 'object', additionalProperties: false, properties: { keep: {} } },
  },
} as const;

const run = (over: Partial<StorageMigrationRun> = {}): StorageMigrationRun => ({
  publishRequestId: 'pubreq_RUN1',
  collection: 'cards',
  appBlockId: 'ab_RUN1',
  ops: [{ op: 'remove', path: '/legacy' }],
  status: 'running',
  cursor: null,
  scanned: 0,
  migrated: 0,
  unchanged: 0,
  failed: 0,
  invalid: 0,
  failures: [],
  lastError: null,
  attempts: 0,
  claimToken: 'claim-1',
  ...over,
});

const page = (over: Partial<MigrateDocumentsResult>): MigrateDocumentsResult => ({
  scanned: 0,
  migrated: 0,
  unchanged: 0,
  failed: 0,
  invalid: 0,
  failures: [],
  next: null,
  ...over,
});

function scripted(pages: (MigrateDocumentsResult | Error)[]) {
  const calls: unknown[] = [];
  const store = {
    migrateDocuments: vi.fn(
      async (_app: string, _coll: unknown, transform: unknown, opts: unknown) => {
        calls.push(opts);
        const next = pages.shift();
        if (!next) throw new Error('no more pages scripted');
        if (next instanceof Error) throw next;
        // The transform handed to the store is the declared ops.
        expect((transform as (d: object) => object | null)({ legacy: 1, keep: 2 })).toEqual({
          keep: 2,
        });
        return next;
      }
    ),
  } as unknown as DocStoreMaintenance;
  return { store, calls };
}

const live = async () => ({ collection: COLLECTION as never, superseded: false });

describe('advanceStorageMigrationRun', () => {
  it('pages to the end, summing counts and persisting the cursor after each page', async () => {
    const { store, calls } = scripted([
      page({ scanned: 2, migrated: 1, unchanged: 1, next: { scopeUid: 7, key: 'b' } }),
      page({
        scanned: 1,
        failed: 1,
        invalid: 1,
        failures: [{ scopeUid: 9, key: 'c', code: 'too_large' }],
      }),
    ]);
    const persisted: [string, unknown, boolean][] = [];
    const left = await advanceStorageMigrationRun(run(), {
      store,
      load: live,
      persist: async (r, done) => void persisted.push([r.status, r.cursor, done]),
    });
    expect(calls).toEqual([
      { after: null, limit: 100 },
      { after: { scopeUid: 7, key: 'b' }, limit: 100 },
    ]);
    expect(persisted).toEqual([
      ['running', { scopeUid: 7, key: 'b' }, false],
      ['completed_with_failures', null, true],
    ]);
    expect(left).toMatchObject({
      status: 'completed_with_failures',
      scanned: 3,
      migrated: 1,
      unchanged: 1,
      failed: 1,
      invalid: 1,
      failures: [{ scopeUid: 9, key: 'c', code: 'too_large' }],
    });
  });

  it('resumes from a persisted cursor and completes cleanly', async () => {
    const { store, calls } = scripted([page({ scanned: 4, migrated: 4 })]);
    const left = await advanceStorageMigrationRun(
      run({ cursor: { scopeUid: 3, key: 'k' }, scanned: 10, migrated: 6 }),
      { store, load: live, persist: async () => undefined }
    );
    expect(calls).toEqual([{ after: { scopeUid: 3, key: 'k' }, limit: 100 }]);
    expect([left.status, left.scanned, left.migrated]).toEqual(['completed', 14, 10]);
  });

  it('stops as superseded once a newer version is approved, without touching the store', async () => {
    const { store } = scripted([]);
    const left = await advanceStorageMigrationRun(run(), {
      store,
      load: async () => ({ collection: null, superseded: true }),
      persist: async () => undefined,
    });
    expect(left.status).toBe('superseded');
    expect(store.migrateDocuments).not.toHaveBeenCalled();
  });

  it('an unreachable store leaves the run pending with the error, for the next job run', async () => {
    const { store } = scripted([
      new DocStoreError('service_unavailable', 'storage is temporarily unavailable'),
    ]);
    const left = await advanceStorageMigrationRun(run(), {
      store,
      load: live,
      persist: async () => undefined,
    });
    // Transient: not counted as an attempt (an outage must not fail every run in flight).
    expect([left.status, left.lastError, left.attempts]).toEqual([
      'pending',
      // Prefixed with the code, so the approve gate can say why the run waits.
      'service_unavailable: storage is temporarily unavailable',
      0,
    ]);
  });

  it('out of page budget: hands the rest to the next job run as pending, cursor kept', async () => {
    const { store } = scripted([
      page({ scanned: 1, migrated: 1, next: { scopeUid: 1, key: 'a' } }),
      page({ scanned: 1, migrated: 1, next: { scopeUid: 1, key: 'b' } }),
    ]);
    const left = await advanceStorageMigrationRun(run(), {
      store,
      load: live,
      persist: async () => undefined,
      maxPages: 2,
    });
    expect([left.status, left.cursor, left.migrated]).toEqual([
      'pending',
      { scopeUid: 1, key: 'b' },
      2,
    ]);
  });

  it('a collection the approved manifest no longer declares fails the run', async () => {
    const { store } = scripted([]);
    const left = await advanceStorageMigrationRun(run(), {
      store,
      load: async () => ({ collection: null, superseded: false }),
      persist: async () => undefined,
    });
    expect([left.status, left.lastError]).toEqual([
      'failed',
      'the approved manifest does not declare collection cards',
    ]);
  });

  it('🔴 the fifth consecutive failed attempt fails the run for good', async () => {
    const { store } = scripted([new Error('relation is gone')]);
    const persisted: [string, boolean][] = [];
    const left = await advanceStorageMigrationRun(run({ attempts: 4 }), {
      store,
      load: live,
      persist: async (r, done) => void persisted.push([r.status, done]),
    });
    expect([left.status, left.attempts, left.lastError]).toEqual([
      'failed',
      5,
      'gave up after 5 failed attempts: relation is gone',
    ]);
    expect(persisted).toEqual([['failed', true]]);
  });

  it('a non-store error under the cap is recorded as pending and rethrown', async () => {
    const { store } = scripted([new Error('boom')]);
    const persisted: [string, number][] = [];
    await expect(
      advanceStorageMigrationRun(run({ attempts: 1 }), {
        store,
        load: live,
        persist: async (r) => void persisted.push([r.status, r.attempts]),
      })
    ).rejects.toThrow('boom');
    expect(persisted).toEqual([['pending', 2]]);
  });

  it('a page that completes resets the failed-attempt count', async () => {
    const { store } = scripted([page({ scanned: 1, migrated: 1 })]);
    const left = await advanceStorageMigrationRun(run({ attempts: 3 }), {
      store,
      load: live,
      persist: async () => undefined,
    });
    expect([left.status, left.attempts]).toEqual(['completed', 0]);
  });

  it.each([
    ['storage_disabled', 'document storage is disabled'],
    ['rate_limited', 'lock timeout'],
  ] as const)('🔴 a transient %s error at the cap does not fail the run', async (code, message) => {
    const { store } = scripted([new DocStoreError(code, message)]);
    const left = await advanceStorageMigrationRun(run({ attempts: 4 }), {
      store,
      load: live,
      persist: async () => undefined,
    });
    expect([left.status, left.attempts]).toEqual(['pending', 4]);
  });

  it('a request still pending (reserved, approval not written yet) is waited for: no page, no attempt', async () => {
    const { store } = scripted([]);
    const persisted: [string, number, boolean][] = [];
    const left = await advanceStorageMigrationRun(run({ attempts: 2 }), {
      store,
      load: async () => ({ collection: null, superseded: false, awaitingApproval: true }),
      persist: async (r, done) => void persisted.push([r.status, r.attempts, done]),
    });
    expect(store.migrateDocuments).not.toHaveBeenCalled();
    expect(left.status).toBe('pending');
    expect(persisted).toEqual([['pending', 2, false]]);
  });

  it('our own database failing to load the target is transient: pending, no attempt', async () => {
    const { store } = scripted([]);
    const left = await advanceStorageMigrationRun(run(), {
      store,
      load: async () => {
        throw new Error('primary unreachable');
      },
      persist: async () => undefined,
    });
    expect([left.status, left.attempts, left.lastError]).toEqual([
      'pending',
      0,
      'primary unreachable',
    ]);
  });
});
