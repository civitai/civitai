import { describe, expect, it } from 'vitest';
import {
  createDocStore,
  createDocStoreMaintenance,
  createDocStoreViewerData,
} from '~/server/services/apps/doc-store';
import { importersOf } from './import-ledger';

/**
 * The viewer-data object reads ONE user's usage rows in every app (the account-wipe enumeration's
 * setting) and deletes that user's documents in an app, keyed on a user id its caller supplies.
 * Only a session-authenticated caller passing its own user id may hold it, so it lives on its own
 * object and these cases pin who may obtain it, by parsing every import in src; they fail when
 * the set grows OR shrinks.
 */
describe('document-store viewer data is reachable from the account-settings service only', () => {
  it('only the viewer-usage service imports the viewer-data instance', () => {
    expect(importersOf('server/services/apps/doc-store-viewer-data.instance')).toEqual([
      'server/services/apps/doc-store-viewer-usage.service.ts',
    ]);
  });

  it('only the viewer-data instance obtains the factory from the store module', () => {
    expect(importersOf('server/services/apps/doc-store', 'createDocStoreViewerData')).toEqual([
      'server/services/apps/doc-store-viewer-data.instance.ts',
    ]);
  });

  it('the viewer-data object is exactly its two operations and the limits; neither the block-token store nor maintenance carries them', () => {
    const VIEWER_DATA = ['emptyViewerData', 'listViewerUsage'];
    expect(Object.keys(createDocStoreViewerData({ db: null })).sort()).toEqual([
      ...VIEWER_DATA,
      'limits',
    ]);
    for (const other of [createDocStore({ db: null }), createDocStoreMaintenance({ db: null })]) {
      expect(Object.keys(other).filter((k) => VIEWER_DATA.includes(k))).toEqual([]);
    }
  });
});
