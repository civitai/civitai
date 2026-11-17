import { describe, expect, it } from 'vitest';
import type { BreakingChange } from '~/server/services/apps/storage-schema-migrations';
import {
  applyMigrationOps,
  collectionStorageKey,
  assertStorageMigrationsCover,
  checkStorageMigrations,
  diffCollectionSchemas,
  StorageMigrationRefusal,
} from '~/server/services/apps/storage-schema-migrations';
import type { StorageMigrationOp } from '~/shared/constants/block-storage.constants';
import { parseManifestStorage } from '~/shared/constants/block-storage.constants';

/**
 * App Storage schema migrations, the static half: the breaking-change diff, coverage, the
 * declaration's validation and op application. Every expectation is a literal: a change is
 * `[pointer, keyword]` (or with its old → new values), never derived from the diff under test.
 */

type S = Record<string, unknown>;
const at = (c: BreakingChange) => [c.pointer, c.keyword];
const diff = (oldSchema: S | undefined, newSchema: S | undefined) =>
  diffCollectionSchemas('cards', oldSchema, newSchema).map(at);
const obj = (properties: S, extra: S = {}): S => ({ type: 'object', properties, ...extra });

describe('diffCollectionSchemas — every narrowing keyword is breaking', () => {
  it.each<[string, S, S, [string, string][]]>([
    ['newly required', obj({ a: {} }), obj({ a: {} }, { required: ['a'] }), [['/a', 'required']]],
    [
      'a declared property removed under additionalProperties false',
      obj({ a: {}, b: {} }, { additionalProperties: false }),
      obj({ a: {} }, { additionalProperties: false }),
      [['/b', 'properties']],
    ],
    [
      'additionalProperties newly false',
      obj({ a: {} }),
      obj({ a: {} }, { additionalProperties: false }),
      [['', 'additionalProperties']],
    ],
    [
      'additionalProperties newly a schema',
      obj({ a: {} }),
      obj({ a: {} }, { additionalProperties: { type: 'string' } }),
      [['/*', 'type']],
    ],
    [
      'type removed',
      obj({ a: { type: ['string', 'null'] } }),
      obj({ a: { type: 'string' } }),
      [['/a', 'type']],
    ],
    [
      'number narrowed to integer',
      obj({ a: { type: 'number' } }),
      obj({ a: { type: 'integer' } }),
      [['/a', 'type']],
    ],
    ['type added', obj({ a: {} }), obj({ a: { type: 'string' } }), [['/a', 'type']]],
    [
      'enum value removed',
      obj({ a: { enum: ['x', 'y'] } }),
      obj({ a: { enum: ['x'] } }),
      [['/a', 'enum']],
    ],
    ['enum added', obj({ a: {} }), obj({ a: { enum: ['x'] } }), [['/a', 'enum']]],
    ['const added', obj({ a: {} }), obj({ a: { const: 1 } }), [['/a', 'const']]],
    ['const changed', obj({ a: { const: 1 } }), obj({ a: { const: 2 } }), [['/a', 'const']]],
    ['minimum raised', obj({ a: { minimum: 1 } }), obj({ a: { minimum: 2 } }), [['/a', 'minimum']]],
    [
      'maximum lowered',
      obj({ a: { maximum: 10 } }),
      obj({ a: { maximum: 5 } }),
      [['/a', 'maximum']],
    ],
    ['maximum added', obj({ a: {} }), obj({ a: { maximum: 5 } }), [['/a', 'maximum']]],
    [
      'minLength raised',
      obj({ a: { minLength: 0 } }),
      obj({ a: { minLength: 3 } }),
      [['/a', 'minLength']],
    ],
    [
      'maxLength lowered',
      obj({ a: { maxLength: 9 } }),
      obj({ a: { maxLength: 8 } }),
      [['/a', 'maxLength']],
    ],
    [
      'minItems raised',
      obj({ a: { minItems: 1 } }),
      obj({ a: { minItems: 2 } }),
      [['/a', 'minItems']],
    ],
    [
      'maxItems lowered',
      obj({ a: { maxItems: 4 } }),
      obj({ a: { maxItems: 3 } }),
      [['/a', 'maxItems']],
    ],
    [
      'pattern added',
      obj({ a: { maxLength: 9 } }),
      obj({ a: { maxLength: 9, pattern: '^x' } }),
      [['/a', 'pattern']],
    ],
    [
      'pattern changed',
      obj({ a: { maxLength: 9, pattern: '^x' } }),
      obj({ a: { maxLength: 9, pattern: '^y' } }),
      [['/a', 'pattern']],
    ],
    [
      'items narrowed (recursing)',
      obj({ tags: { type: 'array', items: { type: 'string', maxLength: 20 } } }),
      obj({ tags: { type: 'array', items: { type: 'string', maxLength: 10 } } }),
      [['/tags/*', 'maxLength']],
    ],
    [
      'nested object (recursing)',
      obj({ meta: obj({ n: { maximum: 10 } }) }),
      obj({ meta: obj({ n: { maximum: 5 } }, { required: ['n'] }) }),
      [
        ['/meta/n', 'required'],
        ['/meta/n', 'maximum'],
      ],
    ],
  ])('%s', (_label, oldSchema, newSchema, want) => {
    expect(diff(oldSchema, newSchema)).toEqual(want);
  });

  it('reports old → new values', () => {
    expect(
      diffCollectionSchemas('cards', obj({ n: { maximum: 10 } }), obj({ n: { maximum: 5 } }))
    ).toEqual([{ collection: 'cards', pointer: '/n', keyword: 'maximum', old: 10, new: 5 }]);
  });

  it('escapes ~ and / in a property name (RFC 6901)', () => {
    expect(diff(obj({ 'a/b~c': {} }), obj({ 'a/b~c': {} }, { required: ['a/b~c'] }))).toEqual([
      ['/a~1b~0c', 'required'],
    ]);
  });

  it('a schema added to a collection that had none: each constraint is its own change (the root is always an object)', () => {
    expect(
      diff(undefined, obj({ title: { type: 'string', maxLength: 60 } }, { required: ['title'] }))
    ).toEqual([
      ['/title', 'required'],
      ['/title', 'type'],
      ['/title', 'maxLength'],
    ]);
  });
});

describe('diffCollectionSchemas — widenings and unchanged schemas are NOT breaking', () => {
  it.each<[string, S | undefined, S | undefined]>([
    ['identical', obj({ a: { maximum: 5 } }), obj({ a: { maximum: 5 } })],
    ['maximum raised', obj({ a: { maximum: 5 } }), obj({ a: { maximum: 10 } })],
    ['minimum lowered', obj({ a: { minimum: 5 } }), obj({ a: { minimum: 1 } })],
    ['maximum removed', obj({ a: { maximum: 5 } }), obj({ a: {} })],
    ['maxLength raised', obj({ a: { maxLength: 5 } }), obj({ a: { maxLength: 6 } })],
    ['minItems lowered', obj({ a: { minItems: 3 } }), obj({ a: { minItems: 0 } })],
    ['enum value added', obj({ a: { enum: ['x'] } }), obj({ a: { enum: ['x', 'y'] } })],
    [
      'const widened to an enum holding it',
      obj({ a: { const: 'x' } }),
      obj({ a: { enum: ['x', 'y'] } }),
    ],
    [
      'type added to a list',
      obj({ a: { type: 'string' } }),
      obj({ a: { type: ['string', 'null'] } }),
    ],
    ['integer widened to number', obj({ a: { type: 'integer' } }), obj({ a: { type: 'number' } })],
    [
      'a new optional property',
      obj({ a: {} }),
      obj({ a: {}, b: { type: 'string', maxLength: 3 } }),
    ],
    ['required dropped', obj({ a: {} }, { required: ['a'] }), obj({ a: {} })],
    [
      'additionalProperties opened',
      obj({ a: {} }, { additionalProperties: false }),
      obj({ a: {} }),
    ],
    [
      'a property newly declared where additionalProperties was false',
      obj({ a: {} }, { additionalProperties: false }),
      obj({ a: {}, b: { type: 'string' } }, { additionalProperties: false }),
    ],
    ['schema removed', obj({ a: { maximum: 5 } }), undefined],
    ['pattern removed', obj({ a: { maxLength: 9, pattern: '^x' } }), obj({ a: { maxLength: 9 } })],
    // A keyword for a type the old schema never let through narrows nothing.
    [
      'maxLength on a field already held to numbers',
      obj({ n: { type: 'number' } }),
      obj({ n: { type: 'number', maxLength: 3 } }),
    ],
    [
      'items on a field already held to strings',
      obj({ s: { type: 'string' } }),
      obj({ s: { type: 'string', items: { type: 'number' } } }),
    ],
  ])('%s', (_label, oldSchema, newSchema) => {
    expect(diff(oldSchema, newSchema)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The whole check: coverage, warnings, plans, refusals
// ---------------------------------------------------------------------------

const manifest = (collections: S, extra: S = {}) => ({
  blockId: 'cards-app',
  storage: { collections, ...extra },
});
const cards = (schema: S | undefined, migrations?: StorageMigrationOp[]) => ({
  visibility: 'private',
  ...(schema ? { schema } : {}),
  ...(migrations ? { migrations } : {}),
});
const V1 = obj(
  { title: { type: 'string' }, stars: { type: 'integer', maximum: 10 }, legacy: {} },
  { additionalProperties: false }
);
/** V1 narrowed every way an op can cover. */
const V2 = obj(
  {
    title: { type: 'string' },
    stars: { type: 'integer', maximum: 5 },
    status: { enum: ['draft', 'live'] },
  },
  { additionalProperties: false, required: ['status'] }
);

describe('checkStorageMigrations — coverage', () => {
  it('🔴 an uncovered breaking change is listed and refused', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(V1) }),
      manifest({ cards: cards(V2) })
    );
    expect(check.uncovered.map(at)).toEqual([
      ['/status', 'required'],
      ['/stars', 'maximum'],
      ['/legacy', 'properties'],
    ]);
    expect(() => assertStorageMigrationsCover(check)).toThrow(StorageMigrationRefusal);
  });

  it('every breaking change covered: nothing refused, the mutation ops are the plan', () => {
    const ops: StorageMigrationOp[] = [
      { op: 'default', path: '/status', value: 'draft' },
      { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
      { op: 'remove', path: '/legacy' },
    ];
    const check = checkStorageMigrations(
      manifest({ cards: cards(V1) }),
      manifest({ cards: cards(V2, ops) })
    );
    expect(check.uncovered).toEqual([]);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect([...check.plans]).toEqual([
      [
        'cards',
        [
          { op: 'default', path: '/status', value: 'draft' },
          { op: 'remove', path: '/legacy' },
        ],
      ],
    ]);
    expect(() => assertStorageMigrationsCover(check)).not.toThrow();
  });

  it('rename covers a removed property at `from`; acknowledge covers its one (path, keyword)', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(V1) }),
      manifest({
        cards: cards(
          obj(
            { title: { type: 'string' }, stars: { type: 'integer', maximum: 5 }, old: {} },
            { additionalProperties: false }
          ),
          [
            { op: 'rename', from: '/legacy', to: '/old' },
            { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
          ]
        ),
      })
    );
    expect(check.uncovered).toEqual([]);
    expect([...check.plans]).toEqual([['cards', [{ op: 'rename', from: '/legacy', to: '/old' }]]]);
  });

  it('🔴 an acknowledge covers nothing but its exact path: not a parent, not a child', () => {
    const prev = manifest({ cards: cards(obj({ meta: obj({ n: { maximum: 10 } }) })) });
    const narrowed = obj({ meta: obj({ n: { maximum: 5 } }) });
    for (const path of ['/meta', '/meta/n/x']) {
      const check = checkStorageMigrations(
        prev,
        manifest({ cards: cards(narrowed, [{ op: 'acknowledge', path, keyword: 'maximum' }]) })
      );
      expect({ path, uncovered: check.uncovered.map(at) }).toEqual({
        path,
        uncovered: [['/meta/n', 'maximum']],
      });
    }
  });

  it('a keyword-scoped acknowledge does not cover another keyword at the same path', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ n: { maximum: 10 } })) }),
      manifest({
        cards: cards(obj({ n: { maximum: 5, minimum: 1 } }), [
          { op: 'acknowledge', path: '/n', keyword: 'maximum' },
        ]),
      })
    );
    expect(check.uncovered.map(at)).toEqual([['/n', 'minimum']]);
  });

  it('remove does not cover a field the new schema requires', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ n: { maximum: 10 } })) }),
      manifest({
        cards: cards(obj({ n: { maximum: 5 } }, { required: ['n'] }), [
          { op: 'remove', path: '/n' },
        ]),
      })
    );
    expect(check.uncovered.map(at)).toEqual([
      ['/n', 'required'],
      ['/n', 'maximum'],
    ]);
  });

  it('a default does not cover a narrowing that is not `required`', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ n: { maximum: 10 } })) }),
      manifest({
        cards: cards(obj({ n: { maximum: 5 } }), [{ op: 'default', path: '/n', value: 1 }]),
      })
    );
    expect(check.uncovered.map(at)).toEqual([['/n', 'maximum']]);
  });

  it('a removed collection is not refused: it is a warning, and its documents are kept', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(undefined), notes: cards(undefined) }),
      manifest({ cards: cards(undefined) })
    );
    expect(check.uncovered).toEqual([]);
    expect(check.warnings).toEqual([
      'storage: collection notes is no longer declared; its stored documents are kept and become reachable again if it is re-declared',
    ]);
  });

  it('a schema newly added to a collection that had none: refused until each constraint is covered, one by one', () => {
    const next = obj({ title: { type: 'string', maxLength: 60 } }, { required: ['title'] });
    const prev = manifest({ cards: cards(undefined) });
    expect(
      checkStorageMigrations(prev, manifest({ cards: cards(next) })).uncovered.map(at)
    ).toEqual([
      ['/title', 'required'],
      ['/title', 'type'],
      ['/title', 'maxLength'],
    ]);
    // The required field needs a default; the narrowings are acknowledged by (path, keyword).
    const covered = checkStorageMigrations(
      prev,
      manifest({
        cards: cards(next, [
          { op: 'default', path: '/title', value: '' },
          { op: 'acknowledge', path: '/title', keyword: 'type' },
          { op: 'acknowledge', path: '/title', keyword: 'maxLength' },
        ]),
      })
    );
    expect([covered.uncovered, covered.errors, covered.warnings]).toEqual([[], [], []]);
    expect([...covered.plans]).toEqual([['cards', [{ op: 'default', path: '/title', value: '' }]]]);
  });

  it('🔴 an exact "" + additionalProperties acknowledge covers the root newly closed', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ a: {} })) }),
      manifest({
        cards: cards(obj({ a: {} }, { additionalProperties: false }), [
          { op: 'acknowledge', path: '', keyword: 'additionalProperties' },
        ]),
      })
    );
    expect([check.uncovered, check.warnings]).toEqual([[], []]);
  });

  it('🔴 an exact "/tags/*" + maximum acknowledge covers an items narrowing', () => {
    const tags = (maximum: number) =>
      obj({ tags: { type: 'array', items: { type: 'number', maximum } } }, { required: ['tags'] });
    const check = checkStorageMigrations(
      manifest({ cards: cards(tags(10)) }),
      manifest({
        cards: cards(tags(5), [{ op: 'acknowledge', path: '/tags/*', keyword: 'maximum' }]),
      })
    );
    expect([check.uncovered, check.warnings]).toEqual([[], []]);
  });

  it('🔴 "" covers no non-root pointer', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ n: { maximum: 10 } }, { additionalProperties: false })) }),
      manifest({
        cards: cards(obj({ n: { maximum: 5 } }, { additionalProperties: false }), [
          { op: 'acknowledge', path: '', keyword: 'maximum' },
        ]),
      })
    );
    expect(check.uncovered.map(at)).toEqual([['/n', 'maximum']]);
  });

  it('🔴 "/tags/*" covers neither "/tags/*/x" nor "/tags"', () => {
    const before = obj({
      tags: {
        type: 'array',
        maxItems: 10,
        items: obj({ x: { maximum: 10 } }),
      },
    });
    const after = obj({
      tags: {
        type: 'array',
        maxItems: 5,
        items: obj({ x: { maximum: 5 } }),
      },
    });
    const check = checkStorageMigrations(
      manifest({ cards: cards(before) }),
      manifest({
        cards: cards(after, [
          { op: 'acknowledge', path: '/tags/*', keyword: 'maximum' },
          { op: 'acknowledge', path: '/tags/*', keyword: 'maxItems' },
        ]),
      })
    );
    expect(check.uncovered.map(at)).toEqual([
      ['/tags', 'maxItems'],
      ['/tags/*/x', 'maximum'],
    ]);
  });

  it('🔴 a first schema with a root additionalProperties:false is coverable end to end', () => {
    const next = obj(
      { title: { type: 'string', maxLength: 60 } },
      { required: ['title'], additionalProperties: false }
    );
    const prev = manifest({ cards: cards(undefined) });
    expect(
      checkStorageMigrations(prev, manifest({ cards: cards(next) })).uncovered.map(at)
    ).toEqual([
      ['/title', 'required'],
      ['', 'additionalProperties'],
      ['/title', 'type'],
      ['/title', 'maxLength'],
    ]);
    const covered = checkStorageMigrations(
      prev,
      manifest({
        cards: cards(next, [
          { op: 'default', path: '/title', value: '' },
          { op: 'acknowledge', path: '', keyword: 'additionalProperties' },
          { op: 'acknowledge', path: '/title', keyword: 'type' },
          { op: 'acknowledge', path: '/title', keyword: 'maxLength' },
        ]),
      })
    );
    expect([covered.uncovered, covered.errors, covered.warnings]).toEqual([[], [], []]);
  });

  it('🔴 a collection dropped and declared again is diffed against the last version that declared it', () => {
    const v1 = manifest({ cards: cards(undefined), notes: cards(undefined) });
    const v2 = manifest({ notes: cards(undefined) });
    const v3 = manifest({
      notes: cards(undefined),
      cards: cards(obj({ title: {} }, { required: ['title'] })),
    });
    // Without history the re-declared collection would read as new and nothing would be refused.
    expect(checkStorageMigrations(v2, v3).uncovered).toEqual([]);
    expect(checkStorageMigrations(v2, v3, [v2, v1]).uncovered.map(at)).toEqual([
      ['/title', 'required'],
    ]);
  });

  it('the newest earlier declaration wins, and an unparseable history entry is skipped', () => {
    const older = manifest({ cards: cards(obj({ n: { maximum: 100 } })) });
    const newer = manifest({ cards: cards(obj({ n: { maximum: 10 } })) });
    const broken = { storage: { collections: { cards: { visibility: 'nope' } } } };
    const v = manifest({ cards: cards(obj({ n: { maximum: 50 } })) });
    // Against `newer` (max 10) a max of 50 is a widening; against `older` it would be a narrowing.
    expect(
      checkStorageMigrations(manifest({ other: cards(undefined) }), v, [broken, newer, older])
        .uncovered
    ).toEqual([]);
  });

  it('a first version has nothing to break', () => {
    expect(checkStorageMigrations(null, manifest({ cards: cards(V2) })).uncovered).toEqual([]);
  });
});

describe('checkStorageMigrations — stale blocks, warnings and op errors', () => {
  it('🔴 a migration block left in a LATER manifest refuses nothing and never runs', () => {
    const ops: StorageMigrationOp[] = [
      { op: 'default', path: '/status', value: 'draft' },
      { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
      { op: 'remove', path: '/legacy' },
    ];
    // v2 → v3 with the same schema and the v1 → v2 block still in the manifest.
    const check = checkStorageMigrations(
      manifest({ cards: cards(V2, ops) }),
      manifest({ cards: cards(V2, ops) })
    );
    expect(check.uncovered).toEqual([]);
    expect(check.plans.size).toBe(0);
    expect(check.warnings).toEqual([
      'storage.collections.cards.migrations[0] (default) covers no breaking change between the previous approved version and this one, so it will not run — remove it from the manifest',
      'storage.collections.cards.migrations[1] (acknowledge) covers no breaking change between the previous approved version and this one, so it will not run — remove it from the manifest',
      'storage.collections.cards.migrations[2] (remove) covers no breaking change between the previous approved version and this one, so it will not run — remove it from the manifest',
    ]);
  });

  it('🔴 a newly declared optional property on an open schema is not refused, but is a warning naming it', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ a: {} })) }),
      manifest({ cards: cards(obj({ a: {}, b: { type: 'string' } })) })
    );
    expect(check.uncovered).toEqual([]);
    expect(check.warnings).toEqual([
      'storage.collections.cards: "/b" is newly declared on a schema that left undeclared properties open — stored documents may already hold this key with another type, and those are refused on their next write',
    ]);
  });

  it('a property newly declared where additionalProperties was false is not a warning (nothing could hold it)', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ a: {} }, { additionalProperties: false })) }),
      manifest({
        cards: cards(obj({ a: {}, b: { type: 'string' } }, { additionalProperties: false })),
      })
    );
    expect([check.uncovered, check.warnings]).toEqual([[], []]);
  });

  it('a default value must match the new schema at its path', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(V1) }),
      manifest({
        cards: cards(V2, [
          { op: 'default', path: '/status', value: 'archived' },
          { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
          { op: 'remove', path: '/legacy' },
        ]),
      })
    );
    expect(check.errors).toEqual([
      'storage.collections.cards.migrations[0].value does not match the new schema at "/status": must be one of the schema\'s enum values',
    ]);
    expect(() => assertStorageMigrationsCover(check)).toThrow(StorageMigrationRefusal);
  });

  it('a default or rename into a field the new schema refuses is an error', () => {
    const closed = obj({ a: {} }, { additionalProperties: false });
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ a: {}, b: {} }, { additionalProperties: false })) }),
      manifest({
        cards: cards(closed, [
          { op: 'rename', from: '/b', to: '/c' },
          { op: 'default', path: '/d', value: 1 },
        ]),
      })
    );
    expect(check.errors).toEqual([
      'storage.collections.cards.migrations[0].to "/c" is a field the new schema does not allow, so the rename would make every document it moves invalid',
      'storage.collections.cards.migrations[1].path "/d" is a field the new schema does not allow, so the default would make every document it fills invalid',
    ]);
  });
});

describe('StorageMigrationRefusal — the structured list and the message', () => {
  it('carries collection, pointer, keyword and old → new for each uncovered change', () => {
    const check = checkStorageMigrations(
      manifest({ cards: cards(obj({ n: { maximum: 10 } })) }),
      manifest({ cards: cards(obj({ n: { maximum: 5 } })) })
    );
    const err = new StorageMigrationRefusal(check);
    expect(err.breaking).toEqual([
      { collection: 'cards', pointer: '/n', keyword: 'maximum', old: 10, new: 5 },
    ]);
    expect(err.message).toBe(
      'storage: 1 breaking schema change(s) since the previous approved version can leave documents already stored unwritable, and no migration covers them: cards "/n" maximum: 10 → 5. For each, declare an op under storage.collections.<name>.migrations — "default" for a newly required field, "rename" or "remove" for a removed one, or "acknowledge" with the change\'s exact path and keyword to accept that stored documents violating it are refused on their next write until reshaped (a newly required field needs a "default"). A newly required object together with a newly required field inside it takes two versions: first require the object with a "default" whose value already holds the field, then require the field with its own "default". A newly required field inside an array element or an additionalProperties schema ("…/*/…") cannot be filled by any op: declare it optional, or "remove" the whole optional array or object'
    );
  });
});

// ---------------------------------------------------------------------------
// Declaration validation (the parser; shape only)
// ---------------------------------------------------------------------------

const parseErrors = (migrations: unknown, extra: S = {}) =>
  parseManifestStorage(manifest({ cards: { visibility: 'private', migrations } }, extra)).errors;

describe('parseManifestStorage — migrations', () => {
  it('accepts one op of every kind and keeps them in order', () => {
    const ops = [
      { op: 'default', path: '/status', value: { nested: [1] } },
      { op: 'rename', from: '/name', to: '/title' },
      { op: 'remove', path: '/legacy' },
      { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
    ];
    const parsed = parseManifestStorage(
      manifest({ cards: { visibility: 'private', migrations: ops } })
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.collections.get('cards')?.migrations).toEqual(ops);
  });

  it.each<[string, unknown, string]>([
    [
      'not an array',
      { op: 'remove', path: '/a' },
      'storage.collections.cards.migrations must be an array of migration ops',
    ],
    [
      'empty',
      [],
      'storage.collections.cards.migrations must declare 1 to 32 ops (found 0) — omit it when there is nothing to migrate',
    ],
    [
      'unknown op',
      [{ op: 'copy' }],
      'storage.collections.cards.migrations[0].op must be one of default, rename, remove, acknowledge',
    ],
    [
      'unknown key',
      [{ op: 'remove', path: '/a', value: 1 }],
      'storage.collections.cards.migrations[0].value is not allowed on a "remove" op',
    ],
    [
      'default without value',
      [{ op: 'default', path: '/a' }],
      'storage.collections.cards.migrations[0].value is required on a "default" op',
    ],
    [
      'root path on a mutation op',
      [{ op: 'remove', path: '' }],
      'storage.collections.cards.migrations[0].path must be a JSON pointer to one field of the document\'s data: 1 to 15 non-empty segments such as "/meta/title", no "*" segment (~0 and ~1 escape ~ and /), at most 512 characters',
    ],
    [
      '"*" on a mutation op',
      [{ op: 'remove', path: '/tags/*' }],
      'storage.collections.cards.migrations[0].path must be a JSON pointer to one field of the document\'s data: 1 to 15 non-empty segments such as "/meta/title", no "*" segment (~0 and ~1 escape ~ and /), at most 512 characters',
    ],
    [
      'unknown acknowledge keyword',
      [{ op: 'acknowledge', path: '/a', keyword: 'format' }],
      'storage.collections.cards.migrations[0].keyword is required and must be one of type, const, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, pattern, additionalProperties, properties — an acknowledge covers exactly one breaking change, named by its path and keyword',
    ],
    [
      'acknowledge without a keyword',
      [{ op: 'acknowledge', path: '/a' }],
      'storage.collections.cards.migrations[0].keyword is required and must be one of type, const, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, pattern, additionalProperties, properties — an acknowledge covers exactly one breaking change, named by its path and keyword',
    ],
    [
      '🔴 acknowledge of a newly required field',
      [{ op: 'acknowledge', path: '/status', keyword: 'required' }],
      'storage.collections.cards.migrations[0] acknowledges a newly required field, which cannot be waived — documents already stored without it could never be written again; cover it with { "op": "default", "path": "/status", "value": … } instead',
    ],
    [
      'an acknowledge path without a leading slash',
      [{ op: 'acknowledge', path: 'tags/*', keyword: 'maxLength' }],
      'storage.collections.cards.migrations[0].path must be the JSON pointer of one breaking change: "" for the document root, or up to 15 non-empty segments such as "/meta/title" or "/tags/*" (~0 and ~1 escape ~ and /), at most 512 characters',
    ],
    [
      'two mutation ops on one field',
      [
        { op: 'remove', path: '/b' },
        { op: 'rename', from: '/a', to: '/b' },
      ],
      'storage.collections.cards.migrations[1] touches "/b", which overlaps "/b" touched by storage.collections.cards.migrations[0] — default, rename and remove ops must touch disjoint fields, so re-running them changes nothing',
    ],
    [
      'a mutation op inside another',
      [
        { op: 'remove', path: '/meta' },
        { op: 'default', path: '/meta/x', value: 1 },
      ],
      'storage.collections.cards.migrations[1] touches "/meta/x", which overlaps "/meta" touched by storage.collections.cards.migrations[0] — default, rename and remove ops must touch disjoint fields, so re-running them changes nothing',
    ],
    [
      'a rename onto itself',
      [{ op: 'rename', from: '/a', to: '/a' }],
      'storage.collections.cards.migrations[0] renames "/a" onto "/a", which overlap — rename a field to a place outside itself',
    ],
  ])('%s → refused', (_label, migrations, want) => {
    expect(parseErrors(migrations)).toEqual([want]);
  });

  it('ops whose paths only share a prefix STRING are disjoint fields', () => {
    expect(
      parseErrors([
        { op: 'remove', path: '/p1' },
        { op: 'remove', path: '/p10' },
      ])
    ).toEqual([]);
  });

  it('refuses migrations on a write "none" collection', () => {
    expect(
      parseManifestStorage(
        manifest({
          tallies: {
            visibility: 'shared',
            write: 'none',
            counters: ['plays'],
            migrations: [{ op: 'remove', path: '/a' }],
          },
        })
      ).errors
    ).toEqual([
      'storage.collections.tallies.migrations does not apply to write "none" — no document body is ever written to that collection, so there is nothing to migrate',
    ]);
  });

  it('storage.retiredCollections is not a key (a removed collection is only a warning)', () => {
    expect(
      parseManifestStorage(
        manifest({ cards: { visibility: 'private' } }, { retiredCollections: ['old'] })
      ).errors
    ).toEqual([
      'storage.retiredCollections is not allowed (storage takes only collections and imports)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Applying ops: idempotent, and never through the prototype
// ---------------------------------------------------------------------------

describe('applyMigrationOps', () => {
  const OPS = [
    { op: 'default', path: '/status', value: 'draft' },
    { op: 'rename', from: '/name', to: '/title' },
    { op: 'remove', path: '/legacy' },
    { op: 'default', path: '/meta/round', value: 1 },
  ] as const;
  /** The new schema the ops were written for: `legacy` (and `name`) are no longer allowed. */
  const NEW = obj(
    { status: {}, title: {}, meta: { type: 'object' }, other: {} },
    { additionalProperties: false }
  );

  it('applies each op where its precondition holds', () => {
    expect(applyMigrationOps({ name: 'n', legacy: true, meta: {} }, OPS, NEW)).toEqual({
      title: 'n',
      status: 'draft',
      meta: { round: 1 },
    });
  });

  it('returns null when nothing changes (and never mutates its input)', () => {
    const doc = { status: 'live', title: 't', meta: { round: 3 } };
    const copy = structuredClone(doc);
    expect(applyMigrationOps(doc, OPS, NEW)).toBeNull();
    expect(doc).toEqual(copy);
  });

  it('a missing or non-object parent is a no-op, not a created object', () => {
    expect(applyMigrationOps({ status: 'x', meta: 'flat' }, OPS, NEW)).toBeNull();
    expect(applyMigrationOps({ status: 'x' }, OPS, NEW)).toBeNull();
  });

  it('rename does not overwrite a present target', () => {
    expect(applyMigrationOps({ name: 'old', title: 'kept', status: 'x' }, OPS, NEW)).toBeNull();
  });

  // Pairwise-distinct fixtures covering every precondition branch of every op.
  const DOCS: Record<string, unknown>[] = [
    {},
    { name: 'a' },
    { name: 'a', title: 'b' },
    { title: 'b', legacy: 0 },
    { legacy: null, status: 'live' },
    { meta: {} },
    { meta: { round: 9 } },
    { meta: [1] },
    { name: { deep: [1, { x: 2 }] }, legacy: [3], meta: { other: true } },
  ];
  it.each(DOCS.map((d) => [JSON.stringify(d), d]))('apply twice == apply once: %s', (_l, doc) => {
    const once = applyMigrationOps(doc as Record<string, unknown>, OPS, NEW) ?? doc;
    const twice = applyMigrationOps(once as Record<string, unknown>, OPS, NEW);
    expect(twice).toBeNull();
  });

  it('a field named __proto__ is an own property, never the prototype', () => {
    const out = applyMigrationOps(
      {},
      [{ op: 'default', path: '/__proto__', value: { polluted: true } }],
      undefined
    );
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out as object, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('unescapes ~1 and ~0 in paths', () => {
    expect(
      applyMigrationOps({ 'a/b': 1 }, [{ op: 'rename', from: '/a~1b', to: '/c~0d' }], undefined)
    ).toEqual({ 'c~d': 1 });
  });
});

describe('applyMigrationOps — never undoes a write made under the new schema', () => {
  // v2 narrows `stars` (string → integer ≤ 5) and keeps it optional; `remove /stars` covers it.
  const NEW = obj({ stars: { type: 'integer', maximum: 5 }, title: { type: 'string' } });
  const REMOVE = [{ op: 'remove', path: '/stars' }] as const;

  it('🔴 RACE: a value written under the new schema before the run reaches the document is kept', () => {
    // The new build (or an old client writing a value valid under both) wrote this after approve.
    expect(applyMigrationOps({ stars: 4, title: 't' }, REMOVE, NEW)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['the old type', 'four'],
    ['over the new maximum', 9],
  ])('removes a value the new schema refuses: %s', (_l, stars) => {
    expect(applyMigrationOps({ stars, title: 't' }, REMOVE, NEW)).toEqual({ title: 't' });
  });

  it('removes a key the new schema no longer allows at all', () => {
    const closed = obj({ title: { type: 'string' } }, { additionalProperties: false });
    expect(
      applyMigrationOps({ legacy: 'x', title: 't' }, [{ op: 'remove', path: '/legacy' }], closed)
    ).toEqual({ title: 't' });
  });

  it('removes a nested object only when it fails its new schema', () => {
    const nested = obj({ meta: obj({ n: { maximum: 5 } }) });
    const op = [{ op: 'remove', path: '/meta' }] as const;
    expect(applyMigrationOps({ meta: { n: 3 } }, op, nested)).toBeNull();
    expect(applyMigrationOps({ meta: { n: 8 } }, op, nested)).toEqual({});
  });

  it('a default never overwrites a present field, and a rename never overwrites its target', () => {
    // The same class of race for the other two ops: both act only on the old shape.
    expect(
      applyMigrationOps(
        { status: 'live' },
        [{ op: 'default', path: '/status', value: 'draft' }],
        NEW
      )
    ).toBeNull();
    expect(
      applyMigrationOps(
        { name: 'old', title: 'new' },
        [{ op: 'rename', from: '/name', to: '/title' }],
        NEW
      )
    ).toBeNull();
  });
});

describe('collectionStorageKey — what the approve gate and the runner compare', () => {
  const m = (cards: unknown) => ({ storage: { collections: { cards } } });
  it('ignores key order, and fields outside schema/migrations/visibility/write/exportable', () => {
    expect(
      collectionStorageKey(
        m({ visibility: 'private', schema: { type: 'object', maxProperties: 1 } }),
        'cards'
      )
    ).toBe(
      collectionStorageKey(
        m({
          schema: { maxProperties: 1, type: 'object' },
          indexes: { a: 'string' },
          visibility: 'private',
        }),
        'cards'
      )
    );
  });
  it.each<[string, unknown]>([
    ['schema', { visibility: 'private', schema: { type: 'object' } }],
    ['migrations', { visibility: 'private', migrations: [{ op: 'remove', path: '/a' }] }],
    ['visibility', { visibility: 'shared', write: 'own' }],
    ['exportable', { visibility: 'private', exportable: false }],
  ])('differs when %s differs', (_l, other) => {
    expect(collectionStorageKey(m(other), 'cards')).not.toBe(
      collectionStorageKey(m({ visibility: 'private' }), 'cards')
    );
  });
  it('is null for a collection the manifest does not declare', () => {
    expect(collectionStorageKey(m({ visibility: 'private' }), 'notes')).toBeNull();
    expect(collectionStorageKey(null, 'cards')).toBeNull();
  });
});
