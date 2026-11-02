import { describe, expect, it } from 'vitest';
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import { importersOf } from './import-ledger';

/**
 * Maintenance — review-namespace deletion (`purgeReview`, `listReviewAppIds`), account
 * deletion (`wipeAccount`) and app deletion (`purgeApp`) — runs with settings that reach every
 * `rev:` row of a request, one user's rows in every app, or one app's rows in every namespace,
 * so it lives on its own object, never on the store the block-token routes hold. These cases pin
 * who may obtain it, by parsing every import in src; they fail when the set grows OR shrinks.
 */
describe('document-store maintenance is reachable from its four callers only', () => {
  it('only the publish-request decision path, the sweep job, the account wipe and the purge module import the maintenance instance', () => {
    expect(importersOf('server/services/apps/doc-store-maintenance.instance')).toEqual([
      'server/jobs/sweep-review-storage.ts',
      'server/services/apps/doc-store-purge.ts',
      'server/services/blocks/publish-request.service.ts',
      'server/services/user.service.ts',
    ]);
  });

  it('only the maintenance instance obtains the factory from the store module', () => {
    expect(importersOf('server/services/apps/doc-store', 'createDocStoreMaintenance')).toEqual([
      'server/services/apps/doc-store-maintenance.instance.ts',
    ]);
  });

  it('the maintenance object is exactly the four maintenance operations; the viewer store has none', () => {
    const MAINTENANCE = ['listReviewAppIds', 'purgeApp', 'purgeReview', 'wipeAccount'];
    expect(Object.keys(createDocStoreMaintenance({ db: null })).sort()).toEqual(MAINTENANCE);
    const viewer = Object.keys(createDocStore({ db: null }));
    expect(viewer.filter((k) => MAINTENANCE.includes(k))).toEqual([]);
  });
});
