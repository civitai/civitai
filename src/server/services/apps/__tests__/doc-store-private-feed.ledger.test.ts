import { describe, expect, it } from 'vitest';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStorePrivateFeed,
} from '~/server/services/apps/doc-store';
import { importersOf } from './import-ledger';

/**
 * The private feed reads ONE user's private documents, keyed on a user id its caller supplies. Only
 * the registry adapter's private stream, which passes a user only after the collection-read
 * predicate granted them, may hold it. These cases pin who may obtain it, by parsing every import
 * in src; they fail when the set grows OR shrinks.
 */
describe('the document-store private feed is reachable from the registry private stream only', () => {
  it('only the private stream wiring imports the private-feed instance', () => {
    expect(importersOf('server/services/apps/doc-store-private-feed.instance')).toEqual([
      'server/registry-adapter/private-feed.live.ts',
    ]);
  });

  it('only the private-feed instance obtains the factory from the store module', () => {
    expect(importersOf('server/services/apps/doc-store', 'createDocStorePrivateFeed')).toEqual([
      'server/services/apps/doc-store-private-feed.instance.ts',
    ]);
  });

  it('the private feed is exactly its two reads and the two heads; neither the public feed nor the block-token store carries them', () => {
    // `privateHead` and `privateMarkHead` read no user's documents (the namespace's write and mark
    // heads, as the public feed's `feedHead` and `feedMarkHead` do); they are here so a private
    // stream reads them from the object it already holds.
    const PRIVATE = ['privateDocuments', 'privateHead', 'privateMarkHead', 'privateVersions'];
    expect(Object.keys(createDocStorePrivateFeed({ db: null })).sort()).toEqual(PRIVATE);
    for (const other of [createDocStore({ db: null }), createDocStoreFeed({ db: null })]) {
      expect(Object.keys(other).filter((k) => PRIVATE.includes(k))).toEqual([]);
    }
  });
});
