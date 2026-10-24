import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  APP_STORAGE_BUILTIN_MARKS,
  APP_STORAGE_COLLECTION_NAME_RE,
  APP_STORAGE_ENABLED_FEATURES,
  APP_STORAGE_INDEX_PATH_RE,
  APP_STORAGE_INDEX_TYPES,
  APP_STORAGE_KINDS,
  APP_STORAGE_LOG_MAX_ENTRIES,
  APP_STORAGE_MAX_COLLECTIONS,
  APP_STORAGE_MAX_COUNTERS,
  APP_STORAGE_MAX_DAILY_WRITES_PER_AUTHOR,
  APP_STORAGE_MAX_INDEXES,
  APP_STORAGE_MAX_MARKS,
  APP_STORAGE_MAX_OWNED_MODEL_VERSIONS,
  APP_STORAGE_OWNED_POINTER_PATTERN,
  APP_STORAGE_RESERVED_INDEX_NAMES,
  APP_STORAGE_TALLY_NAME_RE,
  APP_STORAGE_TTL_MAX_SECONDS,
  APP_STORAGE_TTL_MIN_SECONDS,
  APP_STORAGE_VISIBILITIES,
  APP_STORAGE_WRITE_POLICIES,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';
import { schemaAccepts } from './json-schema-subset.fixture';

/**
 * Drift guard — manifest `storage`.
 *
 * The canonical published schema `public/schemas/app-block/v1.json` is what the `civitai`
 * CLI and the SDK byte-mirror and what editors validate against; `parseManifestStorage`
 * (reached through `BlockManifestValidator.validate`) is what submit enforces.
 *
 *   1. Structural — every bound in the schema equals the exported constant.
 *   2. Behavioural — one table of `storage` values is evaluated by BOTH the schema and the
 *      parser. With every phased feature switched ON the verdicts must match exactly. With
 *      the production switch, the cases marked `phased` are the ONLY disagreement allowed,
 *      and in one direction: the schema accepts, the server refuses.
 *
 * The repo has no JSON Schema engine as a dependency, so (2) uses the shared evaluator in
 * `json-schema-subset.fixture.ts`, which THROWS on any keyword it does not implement.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

type SchemaObject = Record<string, unknown>;
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  required: string[];
  properties: Record<string, SchemaObject>;
};
const storageSchema = schema.properties.storage;

// Every key of the switch turned ON, derived so the agreement table runs with a new feature
// enabled too. This does NOT check that each feature has a row here: that each switch key
// has a refused-off / accepted-on control is asserted in `block-storage.constants.test.ts`.
const ALL_ON = Object.fromEntries(
  Object.keys(APP_STORAGE_ENABLED_FEATURES).map((feature) => [feature, true])
) as Record<keyof typeof APP_STORAGE_ENABLED_FEATURES, boolean>;
const parserAccepts = (storage: unknown, features = ALL_ON) =>
  parseManifestStorage({ storage }, features).errors.length === 0;

const one = (decl: unknown) => ({ collections: { c: decl } });
const priv = (extra: Record<string, unknown> = {}) => one({ visibility: 'private', ...extra });
const shared = (extra: Record<string, unknown> = {}) =>
  one({ visibility: 'shared', write: 'own', ...extra });
const names = (n: number, prefix = 'n') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/**
 * [label, storage, accepted with every phased feature ON, phased]. `phased` marks the cases
 * the production switch must refuse although the schema accepts them.
 */
const CASES: Array<[string, unknown, boolean, boolean?]> = [
  // accept
  ['private, minimal', priv(), true],
  ['shared own', shared(), true],
  ['shared anyone', shared({ write: 'anyone' }), true, true],
  [
    'design example',
    {
      collections: {
        prefs: { visibility: 'private' },
        requests: {
          visibility: 'shared',
          write: 'own',
          marks: ['vote'],
          indexes: { status: 'string' },
          showAuthor: true,
        },
      },
    },
    true,
  ],
  ['kind docs', priv({ kind: 'docs' }), true],
  ['private with indexes', priv({ indexes: { status: 'string', 'meta.a.b': 'time' } }), true],
  [
    '32-char collection name',
    { collections: { ['a'.repeat(32)]: { visibility: 'private' } } },
    true,
  ],
  [
    '16 collections',
    { collections: Object.fromEntries(names(16, 'c').map((n) => [n, { visibility: 'private' }])) },
    true,
  ],
  ['8 counters, 8 marks', shared({ counters: names(8, 'c'), marks: names(8, 'm') }), true],
  ['32-char segment index path', priv({ indexes: { ['A'.repeat(32)]: 'number' } }), true],
  ['showAuthor false on shared', shared({ showAuthor: false }), true],
  // `constructor` is the Object.prototype member the name pattern admits.
  ['`constructor` collection', { collections: { constructor: { visibility: 'private' } } }, true],
  ['write none with counters', shared({ write: 'none', counters: ['plays'] }), true],
  ['write none with marks only', shared({ write: 'none', marks: ['vote'] }), true],
  [
    'ownedModelVersions on shared own',
    shared({ ownedModelVersions: ['/workflow/modelVersionId'] }),
    true,
  ],
  [
    '4 ownedModelVersions pointers, 4 segments, 64-char segment',
    shared({ ownedModelVersions: ['/a', '/_b/c9', '/c/d/e/f', `/${'x'.repeat(64)}`] }),
    true,
  ],
  // accept, but phased
  ['dailyWritesPerAuthor 1', shared({ dailyWritesPerAuthor: 1 }), true, true],
  ['dailyWritesPerAuthor 1000', shared({ dailyWritesPerAuthor: 1000 }), true, true],
  ['kind log', priv({ kind: 'log' }), true, true],
  ['kind log with maxEntries 1', priv({ kind: 'log', maxEntries: 1 }), true, true],
  ['kind log with maxEntries 10000', priv({ kind: 'log', maxEntries: 10000 }), true, true],
  ['ttlSeconds 60', priv({ ttlSeconds: 60 }), true, true],
  ['ttlSeconds 31536000', priv({ ttlSeconds: 31536000 }), true, true],
  ['write owner', shared({ write: 'owner', counters: ['plays'] }), true, true],
  // reject — containers
  ['storage null', null, false],
  ['storage array', [], false],
  ['no collections key', {}, false],
  ['empty collections', { collections: {} }, false],
  ['unknown storage key', { collections: { c: { visibility: 'private' } }, quota: 1 }, false],
  [
    '17 collections',
    { collections: Object.fromEntries(names(17, 'c').map((n) => [n, { visibility: 'private' }])) },
    false,
  ],
  ['collection null', one(null), false],
  ['unknown collection key', priv({ label: 'x' }), false],
  ['`constructor` as an unknown collection key', priv({ constructor: 1 }), false],
  // reject — names
  ['uppercase collection', { collections: { Prefs: { visibility: 'private' } } }, false],
  ['leading digit collection', { collections: { '1x': { visibility: 'private' } } }, false],
  ['hyphen collection', { collections: { 'a-b': { visibility: 'private' } } }, false],
  [
    '33-char collection name',
    { collections: { ['a'.repeat(33)]: { visibility: 'private' } } },
    false,
  ],
  // reject — visibility / kind / write
  ['no visibility', one({}), false],
  ['visibility public', one({ visibility: 'public' }), false],
  ['kind table', priv({ kind: 'table' }), false],
  ['shared without write', one({ visibility: 'shared' }), false],
  ['write everyone', shared({ write: 'everyone' }), false],
  ['write on private', priv({ write: 'own' }), false],
  // reject — shared-only fields on a private collection
  ['counters on private', priv({ counters: ['plays'] }), false],
  ['marks on private', priv({ marks: ['vote'] }), false],
  ['showAuthor on private', priv({ showAuthor: true }), false],
  ['dailyWritesPerAuthor on private', priv({ dailyWritesPerAuthor: 5 }), false],
  // reject — tallies
  ['9 counters', shared({ counters: names(9, 'c') }), false],
  ['9 marks', shared({ marks: names(9, 'm') }), false],
  ['duplicate mark', shared({ marks: ['vote', 'vote'] }), false],
  ['report mark', shared({ marks: ['report'] }), false],
  ['report counter', shared({ counters: ['report'] }), false],
  ['uppercase mark', shared({ marks: ['Vote'] }), false],
  ['33-char counter', shared({ counters: ['c'.repeat(33)] }), false],
  ['counters not an array', shared({ counters: 'plays' }), false],
  // reject — indexes
  [
    '5 indexes',
    priv({ indexes: Object.fromEntries(names(5, 'i').map((n) => [n, 'string'])) }),
    false,
  ],
  ['4-segment path', priv({ indexes: { 'a.b.c.d': 'string' } }), false],
  ['empty segment', priv({ indexes: { 'a..b': 'string' } }), false],
  ['trailing dot', priv({ indexes: { 'a.': 'string' } }), false],
  ['33-char segment', priv({ indexes: { ['a'.repeat(33)]: 'string' } }), false],
  ['segment with hyphen', priv({ indexes: { 'a-b': 'string' } }), false],
  ['reserved key', priv({ indexes: { key: 'string' } }), false],
  ['reserved createdAt', priv({ indexes: { createdAt: 'time' } }), false],
  ['reserved updatedAt', priv({ indexes: { updatedAt: 'time' } }), false],
  ['type text', priv({ indexes: { a: 'text' } }), false],
  ['indexes array', priv({ indexes: ['a'] }), false],
  // reject — numbers
  ['ttlSeconds 59', priv({ ttlSeconds: 59 }), false],
  ['ttlSeconds 31536001', priv({ ttlSeconds: 31536001 }), false],
  ['ttlSeconds fractional', priv({ ttlSeconds: 60.5 }), false],
  ['maxEntries on docs', priv({ maxEntries: 5 }), false],
  ['maxEntries 10001', priv({ kind: 'log', maxEntries: 10001 }), false],
  ['maxEntries 0', priv({ kind: 'log', maxEntries: 0 }), false],
  ['dailyWritesPerAuthor 0', shared({ dailyWritesPerAuthor: 0 }), false],
  ['dailyWritesPerAuthor 1001', shared({ dailyWritesPerAuthor: 1001 }), false],
  [
    'dailyWritesPerAuthor with write owner',
    shared({ write: 'owner', dailyWritesPerAuthor: 5 }),
    false,
  ],
  // `write: "none"` is written only through tallies, so it must declare one (schema: anyOf).
  ['write none with neither', shared({ write: 'none' }), false],
  ['write none with empty lists', shared({ write: 'none', counters: [], marks: [] }), false],
  [
    'dailyWritesPerAuthor with write none',
    shared({ write: 'none', counters: ['plays'], dailyWritesPerAuthor: 5 }),
    false,
  ],
  ['showAuthor string', shared({ showAuthor: 'yes' }), false],
  // reject — ownedModelVersions
  ['ownedModelVersions not an array', shared({ ownedModelVersions: '/v' }), false],
  ['ownedModelVersions empty', shared({ ownedModelVersions: [] }), false],
  ['5 ownedModelVersions pointers', shared({ ownedModelVersions: names(5, '/p') }), false],
  ['duplicate pointer', shared({ ownedModelVersions: ['/v', '/v'] }), false],
  ['root pointer ""', shared({ ownedModelVersions: [''] }), false],
  ['pointer without leading slash', shared({ ownedModelVersions: ['workflow/id'] }), false],
  ['pointer "/"', shared({ ownedModelVersions: ['/'] }), false],
  ['empty segment', shared({ ownedModelVersions: ['/a//b'] }), false],
  ['trailing slash', shared({ ownedModelVersions: ['/a/'] }), false],
  ['ownedModelVersions on private', priv({ ownedModelVersions: ['/v'] }), false],
  ['escape ~0', shared({ ownedModelVersions: ['/a~0b'] }), false],
  ['escape ~1', shared({ ownedModelVersions: ['/a~1b'] }), false],
  ['bare ~', shared({ ownedModelVersions: ['/a~'] }), false],
  ['array index segment', shared({ ownedModelVersions: ['/picks/0/id'] }), false],
  ['digit-leading segment', shared({ ownedModelVersions: ['/a/1b'] }), false],
  ['non-ASCII segment', shared({ ownedModelVersions: ['/ワーク'] }), false],
  ['hyphen in segment', shared({ ownedModelVersions: ['/model-version'] }), false],
  ['dash segment', shared({ ownedModelVersions: ['/picks/-'] }), false],
  ['65-char segment', shared({ ownedModelVersions: [`/${'x'.repeat(65)}`] }), false],
  ['5 segments', shared({ ownedModelVersions: ['/a/b/c/d/e'] }), false],
  ['non-string pointer', shared({ ownedModelVersions: [1] }), false],
  [
    'ownedModelVersions with write none',
    shared({ write: 'none', counters: ['plays'], ownedModelVersions: ['/v'] }),
    false,
  ],
  [
    'ownedModelVersions with write owner',
    shared({ write: 'owner', counters: ['plays'], ownedModelVersions: ['/v'] }),
    false,
  ],
  [
    'ownedModelVersions with write anyone',
    shared({ write: 'anyone', ownedModelVersions: ['/v'] }),
    false,
  ],
];

/**
 * Cases ONLY the imperative parser can refuse: the schema accepts them, by design, because
 * the rule spans two fields of a shape JSON Schema does not compare. Kept apart so the
 * agreement table above stays exact, and so this list is the visible register of what the
 * schema under-states.
 */
const PARSER_ONLY: Array<[string, unknown]> = [
  ['one name as counter and mark', shared({ counters: ['vote'], marks: ['vote'] })],
];

describe('app-block v1 schema ⇄ storage parser drift guard', () => {
  it('declares storage as an OPTIONAL closed object', () => {
    expect(schema.required).not.toContain('storage');
    expect(storageSchema.type).toBe('object');
    expect(storageSchema.additionalProperties).toBe(false);
    expect(storageSchema.required).toEqual(['collections']);
  });

  it('pins every bound to the exported constants', () => {
    const collections = (storageSchema.properties as Record<string, SchemaObject>).collections;
    expect(collections.minProperties).toBe(1);
    expect(collections.maxProperties).toBe(APP_STORAGE_MAX_COLLECTIONS);
    expect(collections.additionalProperties).toBe(false);
    expect(collections.propertyNames).toBeUndefined();
    const entries = Object.entries(collections.patternProperties as Record<string, SchemaObject>);
    expect(entries.map(([re]) => re)).toEqual([APP_STORAGE_COLLECTION_NAME_RE.source]);
    const collection = entries[0][1];
    expect(collection.additionalProperties).toBe(false);
    expect(collection.required).toEqual(['visibility']);
    const p = collection.properties as Record<string, SchemaObject>;

    expect(p.kind.enum).toEqual([...APP_STORAGE_KINDS]);
    expect(p.visibility.enum).toEqual([...APP_STORAGE_VISIBILITIES]);
    expect(p.write.enum).toEqual([...APP_STORAGE_WRITE_POLICIES]);

    for (const [field, max] of [
      ['counters', APP_STORAGE_MAX_COUNTERS],
      ['marks', APP_STORAGE_MAX_MARKS],
    ] as const) {
      expect(p[field].maxItems).toBe(max);
      expect(p[field].uniqueItems).toBe(true);
      const items = p[field].items as SchemaObject;
      expect(items.pattern).toBe(APP_STORAGE_TALLY_NAME_RE.source);
      expect((items.not as SchemaObject).enum).toEqual([...APP_STORAGE_BUILTIN_MARKS]);
    }

    expect(p.indexes.maxProperties).toBe(APP_STORAGE_MAX_INDEXES);
    expect(p.indexes.additionalProperties).toBe(false);
    const indexEntries = Object.entries(
      p.indexes.patternProperties as Record<string, SchemaObject>
    );
    expect(indexEntries.map(([re]) => re)).toEqual([APP_STORAGE_INDEX_PATH_RE.source]);
    expect(indexEntries[0][1].enum).toEqual([...APP_STORAGE_INDEX_TYPES]);
    expect(p.indexes.properties).toEqual(
      Object.fromEntries(APP_STORAGE_RESERVED_INDEX_NAMES.map((n) => [n, false]))
    );

    expect([p.ttlSeconds.minimum, p.ttlSeconds.maximum]).toEqual([
      APP_STORAGE_TTL_MIN_SECONDS,
      APP_STORAGE_TTL_MAX_SECONDS,
    ]);
    expect([p.maxEntries.minimum, p.maxEntries.maximum]).toEqual([1, APP_STORAGE_LOG_MAX_ENTRIES]);
    expect([p.dailyWritesPerAuthor.minimum, p.dailyWritesPerAuthor.maximum]).toEqual([
      1,
      APP_STORAGE_MAX_DAILY_WRITES_PER_AUTHOR,
    ]);
    expect(p.ownedModelVersions.type).toBe('array');
    expect([p.ownedModelVersions.minItems, p.ownedModelVersions.maxItems]).toEqual([
      1,
      APP_STORAGE_MAX_OWNED_MODEL_VERSIONS,
    ]);
    expect(p.ownedModelVersions.uniqueItems).toBe(true);
    expect((p.ownedModelVersions.items as SchemaObject).pattern).toBe(
      APP_STORAGE_OWNED_POINTER_PATTERN
    );
  });

  it('the evaluator refuses a keyword it does not implement', () => {
    expect(() => schemaAccepts({ exclusiveMinimum: 1 }, 2)).toThrow(
      /does not implement "exclusiveMinimum"/
    );
  });

  it.each(CASES)('%s → schema and parser agree (accept=%s)', (_label, storage, expected) => {
    expect(schemaAccepts(storageSchema, storage)).toBe(expected);
    expect(parserAccepts(storage)).toBe(expected);
  });

  // The production switch: the phased cases above are refused, and nothing else changes.
  it.each(CASES.filter(([, , accepted]) => accepted))(
    '%s → under the production feature switch',
    (_label, storage, _accepted, phased) => {
      expect(parseManifestStorage({ storage }).errors.length === 0).toBe(!phased);
    }
  );

  it.each(PARSER_ONLY)('%s → schema accepts, parser refuses (parser-only rule)', (_l, storage) => {
    expect(schemaAccepts(storageSchema, storage)).toBe(true);
    expect(parserAccepts(storage)).toBe(false);
  });
});
