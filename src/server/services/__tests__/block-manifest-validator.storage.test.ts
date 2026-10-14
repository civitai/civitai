import { describe, expect, it } from 'vitest';
import { BlockManifestValidator } from '../block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The manifest `storage` declaration (the App Blocks document store), through the REAL
 * submit-time validator.
 *
 * 🔴 Imports ONLY the validator, and every expected message is a LITERAL. Deriving a message
 * from the module under test would make the assertion agree with whatever the module says;
 * importing the new constants module would make this file fail to import on a tree without
 * it, which reads as "no tests" rather than as the rule being absent.
 *
 * Refusals assert the WHOLE error list (`toEqual`), so a case also proves no second rule
 * fired on the same manifest. The manifests are the shapes the storage design maps today's
 * apps onto: a private `prefs` collection, a private `ledger`, a shared `requests` feed with
 * votes, a `datasets` / `items` pair joined by an index, and a `plays` collection of counters.
 */

const BASE = {
  blockId: 'test-block',
  version: '1.0.0',
  name: 'Test Block',
  contentRating: 'g',
  renderMode: 'iframe',
  trustTier: 'unverified',
  iframe: {
    src: 'https://blocks.civitai.com/test',
    minHeight: 200,
    maxHeight: null,
    resizable: true,
    sandbox: 'allow-scripts',
  },
};
const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://blocks.civitai.com'],
};

const STORAGE = 'apps:storage';
const PUBLISH = 'apps:storage:publish';
const JUSTIFIED = { [PUBLISH]: 'Viewers post requests that other viewers vote on.' };

type Extra = Record<string, unknown>;
const manifest = (storage: unknown, scopes: string[], extra: Extra = {}) => ({
  ...BASE,
  scopes: ['models:read:self', ...scopes],
  ...(storage === undefined ? {} : { storage }),
  ...extra,
});
const validate = (m: unknown) => BlockManifestValidator.validate(m, APP_CTX);
/**
 * The same manifest with every storage scope (and its justification) taken off, so it
 * declares only scopes every tree already knows. A shape or phase refusal must hold here
 * too: the scope rules are silent while the declaration is invalid (pinned below), so the
 * error list is exactly the storage rule's — and a tree WITHOUT the rule accepts the
 * manifest outright, which is the unambiguous red.
 */
const isolated = (m: Record<string, unknown>) => {
  const { scopeJustifications: _dropped, ...rest } = m;
  return { ...rest, scopes: ['models:read:self'] };
};
const refused = (...errors: string[]) => ({ valid: false, errors });

const PREFS = { visibility: 'private' };
const LEDGER = { visibility: 'private', indexes: { kind: 'string' } };
const REQUESTS = {
  visibility: 'shared',
  write: 'own',
  marks: ['vote'],
  indexes: { status: 'string' },
  showAuthor: true,
};
const DATASETS = { visibility: 'shared', write: 'own', marks: ['vote'] };
const ITEMS = {
  visibility: 'shared',
  write: 'own',
  marks: ['vote'],
  indexes: { datasetId: 'string' },
};

/** A shared feed with everything a phase-1 collection may carry, for one-field variations. */
const withRequests = (override: Extra) =>
  manifest({ collections: { requests: { ...REQUESTS, ...override } } }, [STORAGE, PUBLISH], {
    scopeJustifications: JUSTIFIED,
  });
/** A private collection, for one-field variations. */
const withPrefs = (override: Extra) =>
  manifest({ collections: { prefs: { ...PREFS, ...override } } }, [STORAGE]);

describe('manifest storage — accepted declarations', () => {
  it.each<[string, unknown]>([
    ['private prefs', manifest({ collections: { prefs: PREFS } }, [STORAGE])],
    [
      'private prefs + ledger with an index',
      manifest({ collections: { prefs: PREFS, ledger: LEDGER } }, [STORAGE]),
    ],
    ['shared requests feed with votes, a status index and authors shown', withRequests({})],
    [
      'datasets + items joined by an index',
      manifest({ collections: { datasets: DATASETS, items: ITEMS } }, [STORAGE, PUBLISH], {
        scopeJustifications: JUSTIFIED,
      }),
    ],
    [
      // The counter-only shape: tallies keyed by something outside the store. No viewer
      // authors a document, so `apps:storage` alone suffices — no publish scope, no prompt.
      'plays: write "none" with a counter and a mark, on apps:storage alone',
      manifest(
        {
          collections: {
            plays: { visibility: 'shared', write: 'none', counters: ['plays'], marks: ['vote'] },
          },
        },
        [STORAGE]
      ),
    ],
    [
      'write "none" with only a mark',
      manifest(
        { collections: { likes: { visibility: 'shared', write: 'none', marks: ['like'] } } },
        [STORAGE]
      ),
    ],
    [
      'plays: shared counters on viewer-authored documents (write "own")',
      manifest(
        { collections: { plays: { visibility: 'shared', write: 'own', counters: ['plays'] } } },
        [STORAGE, PUBLISH],
        { scopeJustifications: JUSTIFIED }
      ),
    ],
    ['kind "docs" stated explicitly', withPrefs({ kind: 'docs' })],
    ['a 3-segment index path', withPrefs({ indexes: { 'meta.round.n': 'number' } })],
    [
      '4 indexes of every type',
      withPrefs({ indexes: { a: 'string', b: 'number', c: 'boolean', d: 'time' } }),
    ],
    [
      '8 counters and 8 marks',
      withRequests({
        counters: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'],
        marks: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
      }),
    ],
    [
      '16 collections',
      manifest(
        {
          collections: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`c${i}`, PREFS])),
        },
        [STORAGE]
      ),
    ],
  ])('%s', (_label, m) => {
    expect(validate(m)).toEqual({ valid: true });
  });
});

describe('manifest storage — shape rules', () => {
  it.each<[string, unknown, string]>([
    [
      'write on a private collection',
      withPrefs({ write: 'own' }),
      'storage.collections.prefs.write applies only to shared collections — a private collection is written only by its viewer',
    ],
    [
      'marks on a private collection',
      withPrefs({ marks: ['vote'] }),
      'storage.collections.prefs.marks applies only to shared collections',
    ],
    [
      'counters on a private collection',
      withPrefs({ counters: ['opens'] }),
      'storage.collections.prefs.counters applies only to shared collections',
    ],
    [
      'showAuthor on a private collection',
      withPrefs({ showAuthor: true }),
      'storage.collections.prefs.showAuthor applies only to shared collections',
    ],
    [
      'dailyWritesPerAuthor on a private collection',
      withPrefs({ dailyWritesPerAuthor: 10 }),
      'storage.collections.prefs.dailyWritesPerAuthor applies only to shared collections',
    ],
    [
      'a shared collection with no write policy',
      manifest({ collections: { requests: { visibility: 'shared' } } }, [STORAGE]),
      'storage.collections.requests.write is required on a shared collection and must be one of own, anyone, owner, none',
    ],
    [
      'an unknown write policy',
      withRequests({ write: 'everyone' }),
      'storage.collections.requests.write must be one of own, anyone, owner, none',
    ],
    [
      'no visibility',
      manifest({ collections: { prefs: {} } }, [STORAGE]),
      'storage.collections.prefs.visibility is required and must be one of private, shared',
    ],
    [
      'maxEntries on a docs collection',
      withPrefs({ maxEntries: 100 }),
      'storage.collections.prefs.maxEntries applies only to kind "log"',
    ],
    [
      'declaring the built-in report mark',
      withRequests({ marks: ['vote', 'report'] }),
      'storage.collections.requests.marks[1] "report" is a built-in mark on every shared collection — do not declare it',
    ],
    [
      'a counter named report',
      withRequests({ counters: ['report'] }),
      'storage.collections.requests.counters[0] "report" is the name of a built-in mark — choose another counter name',
    ],
    [
      'one name as both a counter and a mark',
      withRequests({ counters: ['vote'] }),
      'storage.collections.requests declares "vote" as both a counter and a mark — use different names',
    ],
    [
      'a mark declared twice',
      withRequests({ marks: ['vote', 'vote'] }),
      'storage.collections.requests.marks[1] duplicates an earlier mark ("vote")',
    ],
    [
      '9 marks',
      withRequests({ marks: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'] }),
      'storage.collections.requests.marks may declare at most 8 marks (found 9)',
    ],
    [
      'an uppercase mark name',
      withRequests({ marks: ['Vote'] }),
      'storage.collections.requests.marks[0] must be lowercase snake_case: a letter, then up to 31 of a-z, 0-9 or _',
    ],
    [
      'a 4-segment index path',
      withPrefs({ indexes: { 'a.b.c.d': 'string' } }),
      'storage.collections.prefs.indexes key "a.b.c.d" must be a field path of 1 to 3 segments joined by ".", each a letter then up to 31 letters, digits or _',
    ],
    [
      'an empty index path segment',
      withPrefs({ indexes: { 'meta..round': 'string' } }),
      'storage.collections.prefs.indexes key "meta..round" must be a field path of 1 to 3 segments joined by ".", each a letter then up to 31 letters, digits or _',
    ],
    [
      'an index that shadows a built-in sort key',
      withPrefs({ indexes: { createdAt: 'time' } }),
      'storage.collections.prefs.indexes key "createdAt" is a built-in sort key (key, createdAt, updatedAt) and cannot be an index',
    ],
    [
      'an unknown index type',
      withPrefs({ indexes: { title: 'text' } }),
      'storage.collections.prefs.indexes.title must be one of string, number, boolean, time',
    ],
    [
      '5 indexes',
      withPrefs({ indexes: { a: 'string', b: 'string', c: 'string', d: 'string', e: 'string' } }),
      'storage.collections.prefs.indexes may declare at most 4 indexes (found 5)',
    ],
    [
      'dailyWritesPerAuthor over 1000',
      withRequests({ dailyWritesPerAuthor: 1001 }),
      'storage.collections.requests.dailyWritesPerAuthor must be a whole number from 1 to 1000',
    ],
    [
      'an unknown collection field',
      withPrefs({ public: true }),
      'storage.collections.prefs.public is not allowed',
    ],
    [
      'an uppercase collection name',
      manifest({ collections: { Prefs: PREFS } }, [STORAGE]),
      'storage.collections key "Prefs" must be lowercase snake_case: a letter, then up to 31 of a-z, 0-9 or _',
    ],
    [
      '17 collections',
      manifest(
        {
          collections: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`c${i}`, PREFS])),
        },
        [STORAGE]
      ),
      'storage.collections may declare at most 16 collections (found 17)',
    ],
    [
      'no collections',
      manifest({ collections: {} }, [STORAGE]),
      'storage.collections must declare at least one collection (or omit storage)',
    ],
    [
      'counters that are not an array',
      withRequests({ counters: 'plays' }),
      'storage.collections.requests.counters must be an array of names',
    ],
    [
      'a collection that is not an object',
      manifest({ collections: { prefs: null } }, [STORAGE]),
      'storage.collections.prefs must be an object',
    ],
    [
      'storage with no collections key',
      manifest({}, [STORAGE]),
      'storage.collections must be an object mapping collection name to declaration',
    ],
    [
      'indexes that are not an object',
      withPrefs({ indexes: ['status'] }),
      'storage.collections.prefs.indexes must be an object mapping a field path to its type',
    ],
    [
      'write "none" with no counters or marks',
      manifest({ collections: { plays: { visibility: 'shared', write: 'none' } } }, [STORAGE]),
      'storage.collections.plays has write "none" but declares no counters or marks, so nothing could ever be written to it — declare at least one counter or mark, or choose another write policy',
    ],
    [
      'write "none" with empty counter and mark lists',
      manifest(
        {
          collections: { plays: { visibility: 'shared', write: 'none', counters: [], marks: [] } },
        },
        [STORAGE]
      ),
      'storage.collections.plays has write "none" but declares no counters or marks, so nothing could ever be written to it — declare at least one counter or mark, or choose another write policy',
    ],
    [
      // The "declares no counters or marks" rule must stay silent when the tally list is
      // there but malformed: that already has its own error, and "declares none" would be
      // a false second one.
      'write "none" with a malformed counters value',
      manifest(
        { collections: { plays: { visibility: 'shared', write: 'none', counters: 'plays' } } },
        [STORAGE]
      ),
      'storage.collections.plays.counters must be an array of names',
    ],
    [
      'dailyWritesPerAuthor on a write "none" collection',
      manifest(
        {
          collections: {
            plays: {
              visibility: 'shared',
              write: 'none',
              counters: ['plays'],
              dailyWritesPerAuthor: 10,
            },
          },
        },
        [STORAGE]
      ),
      'storage.collections.plays.dailyWritesPerAuthor does not apply to write "none" — viewers do not create or edit documents in that collection',
    ],
    ['storage that is not an object', manifest(['prefs'], [STORAGE]), 'storage must be an object'],
  ])('refuses %s', (_label, m, message) => {
    expect(validate(isolated(m as Record<string, unknown>))).toEqual(refused(message));
    expect(validate(m)).toEqual(refused(message));
  });

  it('reports an unknown storage key AND keeps checking the collections', () => {
    expect(
      validate(manifest({ collections: { prefs: { visibility: 'public' } }, quota: 5 }, []))
    ).toEqual(
      refused(
        'storage.quota is not allowed (storage takes only collections)',
        'storage.collections.prefs.visibility is required and must be one of private, shared'
      )
    );
  });

  // Error messages are bounded: a crafted key cannot turn the submit response into a
  // multi-megabyte message. Keys are cut at 80 characters.
  it('bounds a long collection name in its error', () => {
    expect(validate(manifest({ collections: { ['a'.repeat(200)]: PREFS } }, []))).toEqual(
      refused(
        `storage.collections key "${'a'.repeat(
          80
        )}…" must be lowercase snake_case: a letter, then up to 31 of a-z, 0-9 or _`
      )
    );
  });

  it('bounds a long unknown field name in its error', () => {
    expect(validate(isolated(withPrefs({ ['x'.repeat(200)]: true })))).toEqual(
      refused(`storage.collections.prefs.${'x'.repeat(80)}… is not allowed`)
    );
  });
});

describe('manifest storage — features not available yet', () => {
  it.each<[string, unknown, string]>([
    [
      'a log collection',
      manifest({ collections: { events: { visibility: 'private', kind: 'log' } } }, [STORAGE]),
      'storage.collections.events.kind "log" is not available yet — append-only log collections arrive in a later phase of App Storage; declare kind "docs" (or omit kind) for now',
    ],
    [
      'a TTL',
      withPrefs({ ttlSeconds: 3600 }),
      'storage.collections.prefs.ttlSeconds is not available yet — expiring documents arrive in a later phase of App Storage; remove ttlSeconds for now',
    ],
    [
      'a per-collection write budget',
      withRequests({ dailyWritesPerAuthor: 1000 }),
      'storage.collections.requests.dailyWritesPerAuthor is not available yet — per-collection write budgets arrive in a later phase of App Storage; remove dailyWritesPerAuthor for now (the platform default applies)',
    ],
    [
      'owner-written documents',
      manifest(
        { collections: { plays: { visibility: 'shared', write: 'owner', counters: ['plays'] } } },
        [STORAGE]
      ),
      'storage.collections.plays.write "owner" is not available yet — owner-written documents arrive in a later phase of App Storage; use "own" or "none" for now',
    ],
    [
      'documents any viewer may edit',
      manifest(
        { collections: { notes: { visibility: 'shared', write: 'anyone', marks: ['vote'] } } },
        [STORAGE, PUBLISH],
        { scopeJustifications: JUSTIFIED }
      ),
      'storage.collections.notes.write "anyone" is not available yet — documents any viewer may edit arrive in a later phase of App Storage; use "own" or "none" for now',
    ],
  ])('refuses %s', (_label, m, message) => {
    expect(validate(isolated(m as Record<string, unknown>))).toEqual(refused(message));
    expect(validate(m)).toEqual(refused(message));
  });

  // The gate must not swallow a SHAPE error behind "not available yet": an out-of-range TTL
  // is wrong whatever the phase, and saying "not yet" about it would invite a resubmit
  // that fails again.
  it('reports an out-of-range TTL as a shape error, not as a feature that is coming', () => {
    expect(validate(isolated(withPrefs({ ttlSeconds: 59 })))).toEqual(
      refused(
        'storage.collections.prefs.ttlSeconds must be a whole number of seconds from 60 to 31536000'
      )
    );
  });
});

describe('manifest storage — scope rules', () => {
  it('declaring a collection requires apps:storage', () => {
    expect(validate(manifest({ collections: { prefs: PREFS, ledger: LEDGER } }, []))).toEqual(
      refused(
        'storage declares prefs, ledger but scopes does not include apps:storage — add it, or remove storage'
      )
    );
  });

  it('a shared collection viewers write requires apps:storage:publish', () => {
    expect(
      validate(manifest({ collections: { prefs: PREFS, requests: REQUESTS } }, [STORAGE]))
    ).toEqual(
      refused(
        'storage collection requests lets viewers write documents other users read, which requires the apps:storage:publish scope — add it to scopes with a scopeJustifications entry'
      )
    );
  });

  it('names every collection that needs apps:storage:publish', () => {
    expect(
      validate(manifest({ collections: { datasets: DATASETS, items: ITEMS } }, [STORAGE]))
    ).toEqual(
      refused(
        'storage collection datasets, items lets viewers write documents other users read, which requires the apps:storage:publish scope — add it to scopes with a scopeJustifications entry'
      )
    );
  });

  it('apps:storage with no storage block is refused', () => {
    expect(validate(manifest(undefined, [STORAGE]))).toEqual(
      refused(
        'scopes includes apps:storage but storage declares no collections — declare them under storage.collections, or remove the scope'
      )
    );
  });

  it('apps:storage:publish with only private collections is refused', () => {
    expect(
      validate(
        manifest({ collections: { prefs: PREFS } }, [STORAGE, PUBLISH], {
          scopeJustifications: JUSTIFIED,
        })
      )
    ).toEqual(
      refused(
        'scopes includes apps:storage:publish but no storage collection is shared with write "own" — remove the scope, or declare the collection it is for'
      )
    );
  });

  it('apps:storage:publish with only write "none" and private collections is refused', () => {
    expect(
      validate(
        manifest(
          {
            collections: {
              prefs: PREFS,
              plays: { visibility: 'shared', write: 'none', counters: ['plays'] },
            },
          },
          [STORAGE, PUBLISH],
          { scopeJustifications: JUSTIFIED }
        )
      )
    ).toEqual(
      refused(
        'scopes includes apps:storage:publish but no storage collection is shared with write "own" — remove the scope, or declare the collection it is for'
      )
    );
  });

  // Mixed: only the viewer-authored collection is named as needing the publish scope.
  it('names only the own/anyone collections when publish is missing', () => {
    expect(
      validate(
        manifest(
          {
            collections: {
              plays: { visibility: 'shared', write: 'none', counters: ['plays'] },
              requests: REQUESTS,
            },
          },
          [STORAGE]
        )
      )
    ).toEqual(
      refused(
        'storage collection requests lets viewers write documents other users read, which requires the apps:storage:publish scope — add it to scopes with a scopeJustifications entry'
      )
    );
  });

  it('apps:storage:publish is sensitive: it needs a justification', () => {
    expect(validate(manifest({ collections: { requests: REQUESTS } }, [STORAGE, PUBLISH]))).toEqual(
      refused(
        'sensitive scopes require a justification — add a non-empty scopeJustifications entry for: apps:storage:publish'
      )
    );
  });

  // An invalid declaration declares nothing, so a scope rule judged against it would add a
  // second, misleading error ("no collections") to the real one.
  it('scope rules stay silent while the declaration itself is invalid', () => {
    expect(
      validate(manifest({ collections: { prefs: { visibility: 'public' } } }, [STORAGE]))
    ).toEqual(
      refused('storage.collections.prefs.visibility is required and must be one of private, shared')
    );
  });

  it.each([
    [[STORAGE], { collections: { prefs: PREFS } }],
    [[STORAGE, PUBLISH], { collections: { requests: REQUESTS } }],
  ])('auth "oauth" is refused alongside %j', (scopes, storage) => {
    const result = validate(
      manifest(storage, scopes, {
        auth: 'oauth',
        ...(scopes.includes(PUBLISH) ? { scopeJustifications: JUSTIFIED } : {}),
      })
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(
        new RegExp(
          `^auth "oauth" cannot be combined with app storage: this manifest declares ${scopes.join(
            ', '
          )}\\. `
        )
      );
    }
  });
});
