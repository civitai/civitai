import { describe, expect, it } from 'vitest';

import {
  APP_STORAGE_ALL_FEATURES_ON,
  APP_STORAGE_ENABLED_FEATURES,
  appStorageScopeErrors,
  isCollectionRegistryPublic,
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
};

describe('APP_STORAGE_ENABLED_FEATURES', () => {
  // A ledger: turning a feature on must be a deliberate edit of this line AND of the
  // runtime behind it.
  it('ships with anyone-writes, owner writes, log collections, TTL, per-author write budgets, permission hooks and registry export switched off', () => {
    expect(APP_STORAGE_ENABLED_FEATURES).toEqual({
      anyoneWrites: false,
      ownerWrites: false,
      logCollections: false,
      ttl: false,
      perAuthorWriteBudget: false,
      hooks: false,
      registryExport: false,
    });
    expect(Object.isFrozen(APP_STORAGE_ENABLED_FEATURES)).toBe(true);
  });

  // Positive control for every "not available yet" refusal: the same declaration is
  // accepted once its feature is on, so the refusal is the switch's and not a shape error.
  const FEATURE_CONTROLS = [
    ['anyoneWrites', { visibility: 'shared', write: 'anyone', marks: ['vote'] }],
    ['ownerWrites', { visibility: 'shared', write: 'owner', counters: ['plays'] }],
    ['logCollections', { visibility: 'private', kind: 'log', maxEntries: 500 }],
    ['ttl', { visibility: 'private', ttlSeconds: 86400 }],
    ['perAuthorWriteBudget', { visibility: 'shared', write: 'own', dailyWritesPerAuthor: 200 }],
    ['hooks', { visibility: 'private', hook: { file: 'hooks/cards.js', sha256: 'a'.repeat(64) } }],
    ['registryExport', { visibility: 'shared', write: 'own', registry: 'public' }],
  ] as const;

  // Updating the ledger above for a new switch key is not enough: the key must also get a
  // control row here, or nothing shows that it refuses anything.
  it('has a positive-control row for exactly the keys of the switch', () => {
    expect(FEATURE_CONTROLS.map(([feature]) => feature).sort()).toEqual(
      Object.keys(APP_STORAGE_ENABLED_FEATURES).sort()
    );
  });

  it.each(FEATURE_CONTROLS)('%s: refused while off, accepted once on', (feature, decl) => {
    const storage = { collections: { c: decl } };
    expect(parseManifestStorage({ storage }).errors).toHaveLength(1);
    expect(
      parseManifestStorage({ storage }, { ...APP_STORAGE_ENABLED_FEATURES, [feature]: true }).errors
    ).toEqual([]);
  });
});

describe('registry (publishing a collection to registries)', () => {
  const parse = (decl: Record<string, unknown>) =>
    parseManifestStorage(
      { storage: { collections: { notes: decl } } },
      APP_STORAGE_ALL_FEATURES_ON
    );

  it('absent: not published', () => {
    const c = parse({ visibility: 'shared', write: 'own' }).collections.get('notes')!;
    expect([c.registry, isCollectionRegistryPublic(c)]).toEqual([undefined, false]);
  });

  it('"public" on a shared collection: published', () => {
    const c = parse({ visibility: 'shared', write: 'own', registry: 'public' }).collections.get(
      'notes'
    )!;
    expect([c.registry, isCollectionRegistryPublic(c)]).toEqual(['public', true]);
  });

  it.each([
    [
      { visibility: 'private', registry: 'public' },
      'storage.collections.notes.registry applies to shared collections only',
    ],
    [
      { visibility: 'shared', write: 'own', registry: 'everyone' },
      'storage.collections.notes.registry must be one of public',
    ],
    [
      { visibility: 'shared', write: 'own', registry: true },
      'storage.collections.notes.registry must be one of public',
    ],
  ])('refuses %o', (decl, message) => {
    expect(parse(decl).errors).toEqual([message]);
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
    });
  });

  it('carries ownedModelVersions pointers through verbatim, in declared order', () => {
    const pointers = ['/workflow/modelVersionId', '/_meta/v2'];
    const parsed = parseManifestStorage({
      storage: {
        collections: {
          picks: { visibility: 'shared', write: 'own', ownedModelVersions: pointers },
        },
      },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.collections.get('picks')?.ownedModelVersions).toEqual(pointers);
  });

  it('carries a declared schema into the declaration exactly as declared; none means no key', () => {
    const schema = {
      type: 'object',
      required: ['label'],
      properties: { label: { type: 'string', maxLength: 33 } },
    };
    const parsed = parseManifestStorage({
      storage: {
        collections: { cards: { visibility: 'private', schema }, prefs: { visibility: 'private' } },
      },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.collections.get('cards')?.schema).toEqual(schema);
    expect(parsed.collections.get('prefs')).not.toHaveProperty('schema');
  });

  it('refuses ownedModelVersions on a private collection as a shared-only field', () => {
    const { errors } = parseManifestStorage({
      storage: { collections: { drafts: { visibility: 'private', ownedModelVersions: ['/v'] } } },
    });
    expect(errors).toEqual([
      'storage.collections.drafts.ownedModelVersions applies only to shared collections',
    ]);
  });

  it('says why ownedModelVersions is refused on a collection the writer may not author', () => {
    const { errors } = parseManifestStorage({
      storage: {
        collections: {
          plays: {
            visibility: 'shared',
            write: 'none',
            counters: ['plays'],
            ownedModelVersions: ['/v'],
          },
        },
      },
    });
    expect(errors).toEqual([
      'storage.collections.plays.ownedModelVersions applies only to shared collections with write "own" — the viewer writing a document must be its author',
    ]);
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
      'scopes includes apps:storage:publish but no storage collection is shared with write "own" — remove the scope, or declare the collection it is for',
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
      'scopes includes apps:storage:publish but no storage collection is shared with write "own" — remove the scope, or declare the collection it is for',
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

/**
 * `write: "anyone"` is refused by the feature switch before any scope rule runs, so this pins
 * what the publish rule does the day `anyoneWrites` flips: viewers author those documents,
 * so the publish scope is required — with no change to the rule itself.
 */
describe('write "anyone" collections (feature on)', () => {
  const ANYONE_ON = { ...APP_STORAGE_ENABLED_FEATURES, anyoneWrites: true };
  const notes = { visibility: 'shared', write: 'anyone', marks: ['vote'] };

  it('require apps:storage:publish', () => {
    const parsed = parseManifestStorage({ storage: { collections: { notes } } }, ANYONE_ON);
    expect(parsed.errors).toEqual([]);
    expect(appStorageScopeErrors(['apps:storage'], parsed)).toEqual([
      'storage collection notes lets viewers write documents other users read, which requires the apps:storage:publish scope — add it to scopes with a scopeJustifications entry',
    ]);
    expect(appStorageScopeErrors(['apps:storage', 'apps:storage:publish'], parsed)).toEqual([]);
  });
});

/**
 * Permission hooks. Refused by the feature switch in production (the off/on control is in the
 * ledger above), so the shape rules are pinned with the feature on, plus the exact refusal text
 * while it is off.
 */
describe('storage hooks', () => {
  const HOOKS_ON = { ...APP_STORAGE_ENABLED_FEATURES, hooks: true };
  const SHA = 'b'.repeat(64);
  const OTHER_SHA = 'c'.repeat(64);
  const parseHook = (hook: unknown, manifest: Record<string, unknown> = {}) =>
    parseManifestStorage(
      { ...manifest, storage: { collections: { cards: { visibility: 'private', hook } } } },
      HOOKS_ON
    );

  it('while the feature is off, says the hook is not available yet', () => {
    expect(
      parseManifestStorage({
        storage: {
          collections: { cards: { visibility: 'private', hook: { file: 'h.js', sha256: SHA } } },
        },
      }).errors
    ).toEqual([
      'storage.collections.cards.hook is not available yet — permission hooks arrive in a later phase of App Storage; remove hook (the collection schema still applies)',
    ]);
  });

  it('normalises a valid hook, filling timeoutMs with 50; no hook means no key', () => {
    const parsed = parseManifestStorage(
      {
        storage: {
          collections: {
            cards: { visibility: 'private', hook: { file: 'hooks/cards.js', sha256: SHA } },
            notes: {
              visibility: 'shared',
              write: 'own',
              hook: { file: 'src/x.y/notes-hook_1.mjs', sha256: OTHER_SHA, timeoutMs: 500 },
            },
            plays: { visibility: 'shared', write: 'none', counters: ['plays'] },
          },
        },
      },
      HOOKS_ON
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.collections.get('cards')?.hook).toEqual({
      file: 'hooks/cards.js',
      sha256: SHA,
      timeoutMs: 50,
    });
    expect(parsed.collections.get('notes')?.hook).toEqual({
      file: 'src/x.y/notes-hook_1.mjs',
      sha256: OTHER_SHA,
      timeoutMs: 500,
    });
    expect(parsed.collections.get('plays')).not.toHaveProperty('hook');
  });

  it('accepts timeoutMs 1 and a 200-character path', () => {
    const file = `${'a'.repeat(197)}.js`;
    expect(parseHook({ file, sha256: SHA, timeoutMs: 1 }).errors).toEqual([]);
  });

  const FILE_ERROR =
    'storage.collections.cards.hook.file is required and must be the relative path of a .js or .mjs file in the bundle: "/"-separated segments, each starting with a letter, digit, _ or - (no "." or ".." segment, no leading "/"), at most 200 characters';
  const SHA_ERROR =
    'storage.collections.cards.hook.sha256 is required and must be the SHA-256 of the file as 64 lowercase hex characters';
  const TIMEOUT_ERROR =
    'storage.collections.cards.hook.timeoutMs must be a whole number of milliseconds from 1 to 500 (omitted means 50)';

  it.each<[string, unknown, string[]]>([
    [
      'not an object',
      'hooks/cards.js',
      ['storage.collections.cards.hook must be an object { file, sha256, timeoutMs? }'],
    ],
    ['file missing', { sha256: SHA }, [FILE_ERROR]],
    ['file a number', { file: 1, sha256: SHA }, [FILE_ERROR]],
    ['leading slash', { file: '/hooks/cards.js', sha256: SHA }, [FILE_ERROR]],
    ['".." segment', { file: 'hooks/../cards.js', sha256: SHA }, [FILE_ERROR]],
    ['"." segment', { file: './cards.js', sha256: SHA }, [FILE_ERROR]],
    ['hidden file', { file: 'hooks/.cards.js', sha256: SHA }, [FILE_ERROR]],
    ['empty segment', { file: 'hooks//cards.js', sha256: SHA }, [FILE_ERROR]],
    ['backslash', { file: 'hooks\\cards.js', sha256: SHA }, [FILE_ERROR]],
    ['not .js', { file: 'hooks/cards.ts', sha256: SHA }, [FILE_ERROR]],
    ['201 characters', { file: `${'a'.repeat(198)}.js`, sha256: SHA }, [FILE_ERROR]],
    [
      'inside node_modules',
      { file: 'node_modules/x/index.js', sha256: SHA },
      [
        'storage.collections.cards.hook.file must not be inside node_modules — a hook is one self-contained module the app ships itself',
      ],
    ],
    ['sha256 missing', { file: 'h.js' }, [SHA_ERROR]],
    ['sha256 uppercase', { file: 'h.js', sha256: 'B'.repeat(64) }, [SHA_ERROR]],
    ['sha256 of 63 chars', { file: 'h.js', sha256: 'b'.repeat(63) }, [SHA_ERROR]],
    ['timeoutMs 0', { file: 'h.js', sha256: SHA, timeoutMs: 0 }, [TIMEOUT_ERROR]],
    ['timeoutMs 501', { file: 'h.js', sha256: SHA, timeoutMs: 501 }, [TIMEOUT_ERROR]],
    ['timeoutMs fractional', { file: 'h.js', sha256: SHA, timeoutMs: 10.5 }, [TIMEOUT_ERROR]],
    [
      'decide (v2)',
      { file: 'h.js', sha256: SHA, decide: { allow: true } },
      [
        "storage.collections.cards.hook.decide is not supported — a v1 permission hook is code only (its file's default export decides each write); remove decide",
      ],
    ],
    [
      'unknown key',
      { file: 'h.js', sha256: SHA, source: 'x' },
      [
        'storage.collections.cards.hook.source is not allowed (hook takes only file, sha256, timeoutMs)',
      ],
    ],
  ])('refuses %s', (_label, hook, errors) => {
    expect(parseHook(hook).errors).toEqual(errors);
  });

  it.each<[string, string]>([
    ['dist', 'dist/hooks/cards.js'],
    ['./dist/', 'dist/cards.js'],
    ['dist/', 'dist/x.mjs'],
    ['.', 'hooks/cards.js'],
  ])('refuses a file inside outputDir %s (%s)', (outputDir, file) => {
    expect(parseHook({ file, sha256: SHA }, { outputDir }).errors).toEqual([
      `storage.collections.cards.hook.file ${JSON.stringify(
        file
      )} is inside the build output (outputDir) — a hook must be a committed source file of the bundle, shipped verbatim, so its sha256 can be checked at submit`,
    ]);
  });

  it('accepts a file beside outputDir that only shares its prefix', () => {
    expect(
      parseHook({ file: 'dist-hooks/cards.js', sha256: SHA }, { outputDir: 'dist' }).errors
    ).toEqual([]);
  });

  it('refuses one file pinned with two different sha256s', () => {
    const { errors } = parseManifestStorage(
      {
        storage: {
          collections: {
            a: { visibility: 'private', hook: { file: 'h.js', sha256: SHA } },
            b: { visibility: 'private', hook: { file: 'h.js', sha256: OTHER_SHA } },
            c: { visibility: 'private', hook: { file: 'h.js', sha256: SHA } },
          },
        },
      },
      HOOKS_ON
    );
    expect(errors).toEqual([
      'storage.collections.b.hook pins "h.js" with a different sha256 than storage.collections.a.hook — one file has one sha256',
    ]);
  });
});
