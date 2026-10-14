import { describe, expect, it } from 'vitest';

import {
  APP_STORAGE_ENABLED_FEATURES,
  appStorageScopeErrors,
  parseManifestStorage,
} from '../block-storage.constants';

/**
 * The `storage` parser's own contract — what the validator-level table in
 * `block-manifest-validator.storage.test.ts` cannot see: the feature switch, the parsed
 * declaration a later reader consumes, totality and the error cap.
 */

const REQUESTS = {
  visibility: 'shared',
  write: 'own',
  marks: ['vote'],
  counters: ['views'],
  indexes: { status: 'string', 'meta.round': 'number' },
  showAuthor: true,
  dailyWritesPerAuthor: 200,
};

describe('APP_STORAGE_ENABLED_FEATURES', () => {
  // A ledger: turning a feature on must be a deliberate edit of this line AND of the
  // runtime behind it.
  it('ships with owner writes, log collections and TTL switched off', () => {
    expect(APP_STORAGE_ENABLED_FEATURES).toEqual({
      ownerWrites: false,
      logCollections: false,
      ttl: false,
    });
    expect(Object.isFrozen(APP_STORAGE_ENABLED_FEATURES)).toBe(true);
  });

  // Positive control for every "not available yet" refusal: the same declaration is
  // accepted once its feature is on, so the refusal is the switch's and not a shape error.
  it.each([
    ['ownerWrites', { visibility: 'shared', write: 'owner', counters: ['plays'] }],
    ['logCollections', { visibility: 'private', kind: 'log', maxEntries: 500 }],
    ['ttl', { visibility: 'private', ttlSeconds: 86400 }],
  ] as const)('%s: refused while off, accepted once on', (feature, decl) => {
    const storage = { collections: { c: decl } };
    expect(parseManifestStorage({ storage }).errors).toHaveLength(1);
    expect(
      parseManifestStorage({ storage }, { ...APP_STORAGE_ENABLED_FEATURES, [feature]: true }).errors
    ).toEqual([]);
  });
});

describe('parseManifestStorage', () => {
  it('a manifest with no storage declares nothing and is valid', () => {
    const parsed = parseManifestStorage({ blockId: 'x' });
    expect(parsed.declared).toBe(false);
    expect(parsed.errors).toEqual([]);
    expect(parsed.collections.size).toBe(0);
  });

  it('normalises a valid declaration (defaults filled, Map-keyed)', () => {
    const parsed = parseManifestStorage({
      storage: { collections: { prefs: { visibility: 'private' }, requests: REQUESTS } },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.collections.get('prefs')).toEqual({
      kind: 'docs',
      visibility: 'private',
      counters: [],
      marks: [],
      indexes: new Map(),
      showAuthor: false,
    });
    expect(parsed.collections.get('requests')).toEqual({
      kind: 'docs',
      visibility: 'shared',
      write: 'own',
      counters: ['views'],
      marks: ['vote'],
      indexes: new Map([
        ['status', 'string'],
        ['meta.round', 'number'],
      ]),
      showAuthor: true,
      dailyWritesPerAuthor: 200,
    });
  });

  it('a lookup of an undeclared `constructor` collection finds nothing', () => {
    const parsed = parseManifestStorage({
      storage: { collections: { prefs: { visibility: 'private' } } },
    });
    expect(parsed.collections.get('constructor')).toBeUndefined();
  });

  it('is all or nothing: one bad collection empties the declaration', () => {
    const parsed = parseManifestStorage({
      storage: {
        collections: { prefs: { visibility: 'private' }, bad: { visibility: 'nope' } },
      },
    });
    expect(parsed.collections.size).toBe(0);
    expect(parsed.errors).toEqual([
      'storage.collections.bad.visibility is required and must be one of private, shared',
    ]);
  });

  it('caps the errors it reports', () => {
    const collections = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `c${i}`,
        { visibility: 'private', write: 'own', marks: ['x'] },
      ])
    );
    const { errors } = parseManifestStorage({ storage: { collections } });
    expect(errors).toHaveLength(21);
    expect(errors[20]).toBe('…and 12 more storage errors');
  });

  it('never throws, even on a throwing getter', () => {
    const storage = {
      get collections() {
        throw new Error('boom');
      },
    };
    expect(parseManifestStorage({ storage }).errors).toEqual(['storage could not be read']);
  });
});

describe('appStorageScopeErrors', () => {
  const parse = (collections: Record<string, unknown>) =>
    parseManifestStorage({ storage: { collections } });

  it('is silent for a consistent manifest', () => {
    expect(
      appStorageScopeErrors(['apps:storage', 'apps:storage:publish'], parse({ requests: REQUESTS }))
    ).toEqual([]);
  });

  it('reports every missing and every unused scope at once', () => {
    expect(
      appStorageScopeErrors(['apps:storage:publish'], parse({ prefs: { visibility: 'private' } }))
    ).toEqual([
      'storage declares prefs but scopes does not include apps:storage — add it, or remove storage',
      'scopes includes apps:storage:publish but no storage collection is shared with write "own" or "anyone" — remove the scope, or declare the collection it is for',
    ]);
  });

  it('treats a non-array scopes as declaring nothing', () => {
    expect(
      appStorageScopeErrors('apps:storage', parse({ prefs: { visibility: 'private' } }))
    ).toEqual([
      'storage declares prefs but scopes does not include apps:storage — add it, or remove storage',
    ]);
  });
});

/**
 * Owner-written collections are refused by the feature switch before any scope rule runs,
 * so these pin what the rules do the day `ownerWrites` flips — a path production cannot
 * reach yet and the validator-level tests therefore cannot see.
 */
describe('owner-written collections (feature on)', () => {
  const OWNER_ON = { ...APP_STORAGE_ENABLED_FEATURES, ownerWrites: true };
  const plays = { visibility: 'shared', write: 'owner', counters: ['plays'] };

  it('do not need apps:storage:publish — viewers do not author them', () => {
    const parsed = parseManifestStorage({ storage: { collections: { plays } } }, OWNER_ON);
    expect(parsed.errors).toEqual([]);
    expect(appStorageScopeErrors(['apps:storage'], parsed)).toEqual([]);
    expect(appStorageScopeErrors(['apps:storage', 'apps:storage:publish'], parsed)).toEqual([
      'scopes includes apps:storage:publish but no storage collection is shared with write "own" or "anyone" — remove the scope, or declare the collection it is for',
    ]);
  });

  it('refuse dailyWritesPerAuthor', () => {
    expect(
      parseManifestStorage(
        { storage: { collections: { plays: { ...plays, dailyWritesPerAuthor: 5 } } } },
        OWNER_ON
      ).errors
    ).toEqual([
      'storage.collections.plays.dailyWritesPerAuthor does not apply to write "owner" — only the app owner writes that collection',
    ]);
  });
});
