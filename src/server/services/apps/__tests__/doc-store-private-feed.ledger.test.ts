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

  it('the private feed is exactly its two reads and the head; neither the public feed nor the block-token store carries them', () => {
    // `privateHead` reads no user's documents (the namespace's write head, as the public feed's
    // `feedHead` does); it is here so a private stream reads it from the object it already holds.
    const PRIVATE = ['privateDocuments', 'privateHead', 'privateVersions'];
    expect(Object.keys(createDocStorePrivateFeed({ db: null })).sort()).toEqual(PRIVATE);
    for (const other of [createDocStore({ db: null }), createDocStoreFeed({ db: null })]) {
      expect(Object.keys(other).filter((k) => PRIVATE.includes(k))).toEqual([]);
    }
  });
});
