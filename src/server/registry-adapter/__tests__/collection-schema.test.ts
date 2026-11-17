import { describe, expect, it } from 'vitest';
import type { ManifestStep } from '~/server/registry-adapter/collection-schema';
import {
  collectionSchemaDocuments,
  deriveCollectionMajors,
  isAdditive,
  synthesizeCollectionSchema,
} from '~/server/registry-adapter/collection-schema';
import { diffCollectionSchemas } from '~/server/services/apps/storage-schema-migrations';
import type { StorageMigrationOp } from '~/shared/constants/block-storage.constants';

/**
 * Collection majors. Every expectation is a literal: the majors, the major each step declared and the
 * schema documents are written out, never computed from the code under test.
 */

type S = Record<string, unknown>;
const obj = (properties: S, extra: S = {}): S => ({ type: 'object', properties, ...extra });
const coll = (schema?: S, migrations?: StorageMigrationOp[]) => ({
  visibility: 'private',
  ...(schema ? { schema } : {}),
  ...(migrations ? { migrations } : {}),
});
const manifest = (collections: S) => ({ blockId: 'pixel-garden', storage: { collections } });
const step = (id: string, collections: S) => ({ id, manifest: manifest(collections) });

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SEED = obj({
  title: { type: 'string', maxLength: 80 },
  stars: { type: 'integer', maximum: 10 },
});
const SEED_WIDER = obj({
  title: { type: 'string', maxLength: 80 },
  stars: { type: 'integer', maximum: 20 },
});
const SEED_NARROWER = obj({
  title: { type: 'string', maxLength: 80 },
  stars: { type: 'integer', maximum: 5 },
});
const SEED_PLUS_MOOD = obj({
  title: { type: 'string', maxLength: 80 },
  stars: { type: 'integer', maximum: 10 },
  mood: { type: 'string' },
});
const ACK_STARS: StorageMigrationOp[] = [{ op: 'acknowledge', path: '/stars', keyword: 'maximum' }];

const cardsOf = (steps: ManifestStep[]) => {
  const d = deriveCollectionMajors(steps);
  return { d, cards: d.collections.get('cards') };
};

describe('isAdditive — the letter of "annotations and new optional properties"', () => {
  it.each<[string, S | undefined, S | undefined, boolean]>([
    [
      'an annotation changed',
      obj({ a: { type: 'string', description: 'old words' } }),
      obj({ a: { type: 'string', description: 'new words' } }),
      true,
    ],
    [
      'a new optional property',
      obj({ a: { type: 'string' } }),
      obj({ a: { type: 'string' }, b: { type: 'number' } }),
      true,
    ],
    [
      'a new optional property, nested',
      obj({ a: obj({ x: {} }) }),
      obj({ a: obj({ x: {}, y: { type: 'boolean' } }) }),
      true,
    ],
    [
      'a new property on a closed schema',
      obj({ a: {} }, { additionalProperties: false }),
      obj({ a: {}, b: {} }, { additionalProperties: false }),
      true,
    ],
    ['enum reordered', obj({ a: { enum: ['r', 'g'] } }), obj({ a: { enum: ['g', 'r'] } }), true],
    [
      'type list reordered',
      obj({ a: { type: ['string', 'null'] } }),
      obj({ a: { type: ['null', 'string'] } }),
      true,
    ],
    [
      'a new property that is required',
      obj({ a: {} }),
      obj({ a: {}, b: {} }, { required: ['b'] }),
      false,
    ],
    ['required dropped (a widening)', obj({ a: {} }, { required: ['a'] }), obj({ a: {} }), false],
    [
      'an enum value added (a widening)',
      obj({ a: { enum: ['r', 'g'] } }),
      obj({ a: { enum: ['r', 'g', 'b'] } }),
      false,
    ],
    [
      'maximum raised (a widening)',
      obj({ a: { maximum: 10 } }),
      obj({ a: { maximum: 20 } }),
      false,
    ],
    [
      'a type added (a widening)',
      obj({ a: { type: 'string' } }),
      obj({ a: { type: ['string', 'null'] } }),
      false,
    ],
    ['a property removed', obj({ a: {}, b: {} }), obj({ a: {} }), false],
    [
      'items narrowed',
      obj({ a: { type: 'array', items: { type: 'string' } } }),
      obj({ a: { type: 'array', items: { type: 'string', maxLength: 3 } } }),
      false,
    ],
    [
      'a new property an additionalProperties schema already held',
      obj({ a: {} }, { additionalProperties: { type: 'string' } }),
      obj({ a: {}, b: { type: 'string' } }, { additionalProperties: { type: 'string' } }),
      false,
    ],
    ['no schema, still none', undefined, undefined, true],
    ['no schema, then annotations only', undefined, { description: 'just words' }, true],
    ['no schema, then any constraint', undefined, { type: 'object' }, false],
    ['a schema, then none', obj({ a: {} }), undefined, false],
  ])('%s → %s', (_name, before, after, expected) => {
    expect(isAdditive(before, after)).toBe(expected);
  });
});

describe('store-breaking ⇒ not additive', () => {
  // THE PIN for `deriveCollectionMajors`, which mints on `!isAdditive` alone: every change the
  // store calls breaking must be non-additive, or a store-breaking transition would keep its
  // major. Each pair is one the store's own diff flags; the first assertion is that precondition,
  // so a pair that stops being store-breaking fails here rather than silently.
  it.each<[string, S | undefined, S]>([
    ['newly required', obj({ a: {} }), obj({ a: {} }, { required: ['a'] })],
    [
      'property removed under additionalProperties false',
      obj({ a: {}, b: {} }, { additionalProperties: false }),
      obj({ a: {} }, { additionalProperties: false }),
    ],
    [
      'additionalProperties newly false',
      obj({ a: {} }),
      obj({ a: {} }, { additionalProperties: false }),
    ],
    [
      'additionalProperties newly a schema',
      obj({ a: {} }),
      obj({ a: {} }, { additionalProperties: { type: 'string' } }),
    ],
    ['type narrowed', obj({ a: { type: ['string', 'null'] } }), obj({ a: { type: 'string' } })],
    ['enum narrowed', obj({ a: { enum: ['r', 'g'] } }), obj({ a: { enum: ['r'] } })],
    ['const added', obj({ a: {} }), obj({ a: { const: 'fixed-value-7' } })],
    ['minimum raised', obj({ a: { minimum: 1 } }), obj({ a: { minimum: 4 } })],
    ['maxLength lowered', obj({ a: { maxLength: 40 } }), obj({ a: { maxLength: 12 } })],
    [
      'pattern added',
      obj({ a: { type: 'string' } }),
      obj({ a: { type: 'string', pattern: '^q' } }),
    ],
    [
      'nested items narrowed',
      obj({ a: { type: 'array', items: obj({ n: { maximum: 9 } }) } }),
      obj({ a: { type: 'array', items: obj({ n: { maximum: 3 } }) } }),
    ],
    [
      'a new property narrower than the additionalProperties schema that held it',
      obj({ a: {} }, { additionalProperties: { type: 'string' } }),
      obj({ a: {}, b: { type: 'number' } }, { additionalProperties: { type: 'string' } }),
    ],
    ['a schema given to a collection that had none', undefined, SEED],
  ])('%s', (_name, before, after) => {
    expect(diffCollectionSchemas('cards', before, after).length).toBeGreaterThan(0);
    expect(isAdditive(before, after)).toBe(false);
  });

  it('positive control: the store exemption (a new optional property on an open schema) is additive and not store-breaking', () => {
    expect(diffCollectionSchemas('cards', SEED, SEED_PLUS_MOOD)).toEqual([]);
    expect(isAdditive(SEED, SEED_PLUS_MOOD)).toBe(true);
  });
});

describe('deriveCollectionMajors', () => {
  // Where a mint happened is pinned by `stepMajors`: the major each step declared the
  // collection under, which is what releases publish.
  const majorsByStep = (d: ReturnType<typeof deriveCollectionMajors>) =>
    [...d.stepMajors].map(([id, m]) => [id, m.get('cards') ?? null]);

  it('a widening mints @v2 although the store does not call it breaking', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { cards: coll(SEED_WIDER) }),
    ]);
    expect(cards).toEqual({ declared: true, majors: [SEED, SEED_WIDER], migrations: [null, []] });
    expect(majorsByStep(d)).toEqual([
      ['pubreq_a', 1],
      ['pubreq_b', 2],
    ]);
  });

  it('🔴 a narrowing covered only by acknowledge still mints', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { cards: coll(SEED_NARROWER, ACK_STARS) }),
    ]);
    expect(cards).toEqual({
      declared: true,
      majors: [SEED, SEED_NARROWER],
      migrations: [null, []],
    });
    expect(majorsByStep(d)).toEqual([
      ['pubreq_a', 1],
      ['pubreq_b', 2],
    ]);
  });

  it('a new optional property stays @v1, which now carries it', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { cards: coll(SEED_PLUS_MOOD) }),
    ]);
    expect(cards).toEqual({ declared: true, majors: [SEED_PLUS_MOOD], migrations: [null] });
    expect(majorsByStep(d)).toEqual([
      ['pubreq_a', 1],
      ['pubreq_b', 1],
    ]);
  });

  it('a collection with no schema is {} at @v1, so adding a schema mints @v2', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll() }),
      step('pubreq_b', { cards: coll(SEED) }),
    ]);
    expect(cards).toEqual({ declared: true, majors: [undefined, SEED], migrations: [null, []] });
    expect(collectionSchemaDocuments('pixel-garden', d)).toEqual([
      {
        urn: 'urn:schema:apps.civitai.com:pixel-garden/cards@v1',
        body: {
          $schema: DIALECT,
          $id: 'urn:schema:apps.civitai.com:pixel-garden/cards@v1',
          deprecated: true,
        },
      },
      {
        urn: 'urn:schema:apps.civitai.com:pixel-garden/cards@v2',
        body: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 80 },
            stars: { type: 'integer', maximum: 10 },
          },
          $schema: DIALECT,
          $id: 'urn:schema:apps.civitai.com:pixel-garden/cards@v2',
          'x-migrateFrom': {
            schema: 'urn:schema:apps.civitai.com:pixel-garden/cards@v1',
            steps: [],
          },
        },
      },
    ]);
  });

  it('removed then declared again unchanged: compared with its last declaration, no mint', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { notes: coll() }),
      step('pubreq_c', { cards: coll(SEED), notes: coll() }),
    ]);
    expect(cards).toEqual({ declared: true, majors: [SEED], migrations: [null] });
    expect(majorsByStep(d)).toEqual([
      ['pubreq_a', 1],
      ['pubreq_b', null],
      ['pubreq_c', 1],
    ]);
  });

  it('removed then declared again narrower: mints against the last declaration', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { notes: coll() }),
      step('pubreq_c', { cards: coll(SEED_NARROWER, ACK_STARS), notes: coll() }),
    ]);
    expect(cards).toEqual({
      declared: true,
      majors: [SEED, SEED_NARROWER],
      migrations: [null, []],
    });
    expect(majorsByStep(d)).toEqual([
      ['pubreq_a', 1],
      ['pubreq_b', null],
      ['pubreq_c', 2],
    ]);
  });

  it('a collection the newest manifest no longer declares serves no schema', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED), notes: coll() }),
      step('head', { notes: coll() }),
    ]);
    expect(cards?.declared).toBe(false);
    expect(collectionSchemaDocuments('pixel-garden', d).map((x) => x.urn)).toEqual([
      'urn:schema:apps.civitai.com:pixel-garden/notes@v1',
    ]);
  });

  it('the enforced manifest is the last step: a divergent head mints on its own', () => {
    const { d } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('head', { cards: coll(SEED_WIDER) }),
    ]);
    expect(majorsByStep(d)).toEqual([
      ['pubreq_a', 1],
      ['head', 2],
    ]);
  });

  it('a manifest whose storage does not parse is skipped', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      { id: 'pubreq_bad', manifest: { storage: { collections: { cards: { visibility: 9 } } } } },
      step('pubreq_c', { cards: coll(SEED) }),
    ]);
    expect(cards).toEqual({ declared: true, majors: [SEED], migrations: [null] });
    expect(d.stepMajors.get('pubreq_bad')).toEqual(new Map());
  });
});

describe('x-migrateFrom on a new major', () => {
  const V = (n: number) => `urn:schema:apps.civitai.com:pixel-garden/cards@v${n}`;
  const docOf = (steps: ManifestStep[], major: number) =>
    collectionSchemaDocuments('pixel-garden', deriveCollectionMajors(steps)).find(
      (d) => d.urn === V(major)
    )?.body;

  // @v1 → @v2 with one op of each kind. `legacy` and `old` leave a closed schema, `status` is
  // newly required, `stars` and `bio` are narrowed.
  const CLOSED = { additionalProperties: false };
  const BEFORE = obj(
    {
      title: { type: 'string' },
      legacy: { type: 'string' },
      old: { type: 'string' },
      stars: { type: 'integer', maximum: 10 },
      bio: { type: 'string', maxLength: 500 },
    },
    CLOSED
  );
  const AFTER = obj(
    {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      status: { enum: ['published', 'draft'] },
      stars: { type: 'integer', maximum: 5 },
      bio: { type: 'string', maxLength: 100 },
    },
    { ...CLOSED, required: ['status'] }
  );
  const OPS: StorageMigrationOp[] = [
    { op: 'default', path: '/status', value: 'published' },
    { op: 'rename', from: '/legacy', to: '/subtitle' },
    { op: 'remove', path: '/old' },
    { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
    { op: 'remove', path: '/bio' },
  ];
  const MINT = [
    step('pubreq_a', { cards: coll(BEFORE) }),
    step('pubreq_b', { cards: coll(AFTER, OPS) }),
  ];

  it('🔴 translates the ops of the minting transition, in order; acknowledge and a narrowing remove have no step', () => {
    expect(docOf(MINT, 2)?.['x-migrateFrom']).toEqual({
      schema: V(1),
      steps: [
        { op: 'default', path: '/status', value: 'published' },
        { op: 'rename', from: '/legacy', to: '/subtitle' },
        { op: 'remove', path: '/old' },
      ],
    });
  });

  it('@v1 carries none', () => {
    expect(docOf(MINT, 1)).not.toHaveProperty('x-migrateFrom');
  });

  it('🔴 a mint changes the old major only by the annotation deprecated: true', () => {
    const before = docOf(MINT.slice(0, 1), 1);
    expect(before).toEqual({ ...BEFORE, $schema: DIALECT, $id: V(1) });
    expect(docOf(MINT, 1)).toEqual({ ...before, deprecated: true });
    expect(docOf(MINT, 2)).not.toHaveProperty('deprecated');
  });

  it('🔴 fixed at the mint: a later additive step of the same major keeps the steps', () => {
    const later = obj(
      { ...(AFTER.properties as S), mood: { type: 'string' } },
      {
        ...CLOSED,
        required: ['status'],
      }
    );
    const steps = [...MINT, step('pubreq_c', { cards: coll(later, OPS) })];
    expect(deriveCollectionMajors(steps).stepMajors.get('pubreq_c')?.get('cards')).toBe(2);
    expect(docOf(steps, 2)?.['x-migrateFrom']).toEqual(docOf(MINT, 2)?.['x-migrateFrom']);
  });

  it("🔴 ops left over in a later manifest are not the next mint's steps", () => {
    const wider = obj(
      { ...(AFTER.properties as S), stars: { type: 'integer', maximum: 50 } },
      {
        ...CLOSED,
        required: ['status'],
      }
    );
    const steps = [...MINT, step('pubreq_c', { cards: coll(wider, OPS) })];
    expect(docOf(steps, 3)?.['x-migrateFrom']).toEqual({ schema: V(2), steps: [] });
  });
});

describe('synthesizeCollectionSchema', () => {
  it('is the declared schema with $schema and $id = the URN', () => {
    expect(
      synthesizeCollectionSchema({
        urn: 'urn:schema:apps.civitai.com:pixel-garden/cards@v1',
        declared: { type: 'object', properties: { title: { type: 'string' } } },
      })
    ).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      $schema: DIALECT,
      $id: 'urn:schema:apps.civitai.com:pixel-garden/cards@v1',
    });
  });

  it('a declared $id never replaces the URN', () => {
    expect(
      synthesizeCollectionSchema({
        urn: 'urn:schema:apps.civitai.com:pixel-garden/cards@v4',
        declared: { $id: 'https://elsewhere.example/schema-q2' },
      }).$id
    ).toBe('urn:schema:apps.civitai.com:pixel-garden/cards@v4');
  });
});
