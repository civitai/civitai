import { describe, expect, it } from 'vitest';
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import { importersOf } from './import-ledger';

/**
 * Review-namespace maintenance (`purgeReview`, `listReviewAppIds`) runs with the setting that
 * reaches every `rev:` row of a request, so it lives on its own object, never on the store the
 * block-token routes hold. These cases pin who may obtain it, by parsing every import in src;
 * they fail when the set grows OR shrinks.
 */
describe('document-store review maintenance is reachable from its two callers only', () => {
  it('only the publish-request decision path and the sweep job import the maintenance instance', () => {
    expect(importersOf('server/services/apps/doc-store-maintenance.instance')).toEqual([
      'server/jobs/sweep-review-storage.ts',
      'server/services/blocks/publish-request.service.ts',
    ]);
  });

  it('only the maintenance instance obtains the factory from the store module', () => {
    expect(importersOf('server/services/apps/doc-store', 'createDocStoreMaintenance')).toEqual([
      'server/services/apps/doc-store-maintenance.instance.ts',
    ]);
  });

  it('the maintenance object is exactly the two review operations; the viewer store has neither', () => {
    expect(Object.keys(createDocStoreMaintenance({ db: null })).sort()).toEqual([
      'listReviewAppIds',
      'purgeReview',
    ]);
    const viewer = Object.keys(createDocStore({ db: null }));
    expect(viewer.filter((k) => k === 'purgeReview' || k === 'listReviewAppIds')).toEqual([]);
  });
});
