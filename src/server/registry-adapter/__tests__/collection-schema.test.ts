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
 * Collection majors. Every expectation is a literal: the majors, the transition reasons and the
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
  // Each pair is one the store's own diff flags. The first assertion is the precondition (the
  // store does flag it), so a pair that stops being store-breaking fails here, not silently.
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
  it('a widening mints @v2 although the store does not call it breaking', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { cards: coll(SEED_WIDER) }),
    ]);
    expect(cards).toEqual({
      declared: true,
      majors: [SEED, SEED_WIDER],
      transitions: [{ stepId: 'pubreq_b', from: 1, to: 2, reasons: ['not-additive'] }],
    });
    expect(d.invariantViolations).toEqual([]);
  });

  it('a narrowing covered only by acknowledge mints, and says so', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { cards: coll(SEED_NARROWER, ACK_STARS) }),
    ]);
    expect(cards?.transitions).toEqual([
      {
        stepId: 'pubreq_b',
        from: 1,
        to: 2,
        reasons: ['not-additive', 'store-breaking', 'acknowledge-only'],
      },
    ]);
    expect(d.invariantViolations).toEqual([]);
  });

  it('a narrowing covered by a mutation op mints, but is not acknowledge-only', () => {
    const required = obj(
      { title: { type: 'string', maxLength: 80 }, stars: { type: 'integer', maximum: 10 } },
      { required: ['title'] }
    );
    const { cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', {
        cards: coll(required, [{ op: 'default', path: '/title', value: 'untitled-card' }]),
      }),
    ]);
    expect(cards?.transitions).toEqual([
      { stepId: 'pubreq_b', from: 1, to: 2, reasons: ['not-additive', 'store-breaking'] },
    ]);
  });

  it('a new optional property stays @v1, which now carries it', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { cards: coll(SEED_PLUS_MOOD) }),
    ]);
    expect(cards).toEqual({ declared: true, majors: [SEED_PLUS_MOOD], transitions: [] });
    expect([...d.stepMajors]).toEqual([
      ['pubreq_a', new Map([['cards', 1]])],
      ['pubreq_b', new Map([['cards', 1]])],
    ]);
  });

  it('a collection with no schema is {} at @v1, so adding a schema mints @v2', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll() }),
      step('pubreq_b', { cards: coll(SEED) }),
    ]);
    expect(cards).toEqual({
      declared: true,
      majors: [undefined, SEED],
      transitions: [
        { stepId: 'pubreq_b', from: 1, to: 2, reasons: ['not-additive', 'store-breaking'] },
      ],
    });
    expect(collectionSchemaDocuments('pixel-garden', d)).toEqual([
      {
        urn: 'urn:schema:civitai-apps:pixel-garden/cards@v1',
        body: {
          $schema: DIALECT,
          $id: 'urn:schema:civitai-apps:pixel-garden/cards@v1',
          'x-successor': 'urn:schema:civitai-apps:pixel-garden/cards@v2',
        },
      },
      {
        urn: 'urn:schema:civitai-apps:pixel-garden/cards@v2',
        body: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 80 },
            stars: { type: 'integer', maximum: 10 },
          },
          $schema: DIALECT,
          $id: 'urn:schema:civitai-apps:pixel-garden/cards@v2',
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
    expect(cards).toEqual({ declared: true, majors: [SEED], transitions: [] });
    expect(d.stepMajors.get('pubreq_b')).toEqual(new Map([['notes', 1]]));
  });

  it('removed then declared again narrower: mints against the last declaration', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('pubreq_b', { notes: coll() }),
      step('pubreq_c', { cards: coll(SEED_NARROWER, ACK_STARS), notes: coll() }),
    ]);
    expect(cards?.transitions).toEqual([
      {
        stepId: 'pubreq_c',
        from: 1,
        to: 2,
        reasons: ['not-additive', 'store-breaking', 'acknowledge-only'],
      },
    ]);
    expect(d.invariantViolations).toEqual([]);
  });

  it('a collection the newest manifest no longer declares serves no schema', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED), notes: coll() }),
      step('head', { notes: coll() }),
    ]);
    expect(cards?.declared).toBe(false);
    expect(collectionSchemaDocuments('pixel-garden', d).map((x) => x.urn)).toEqual([
      'urn:schema:civitai-apps:pixel-garden/notes@v1',
    ]);
  });

  it('the enforced manifest is the last step: a divergent head mints on its own', () => {
    const { cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      step('head', { cards: coll(SEED_WIDER) }),
    ]);
    expect(cards?.transitions).toEqual([
      { stepId: 'head', from: 1, to: 2, reasons: ['not-additive'] },
    ]);
  });

  it('a manifest whose storage does not parse is skipped', () => {
    const { d, cards } = cardsOf([
      step('pubreq_a', { cards: coll(SEED) }),
      { id: 'pubreq_bad', manifest: { storage: { collections: { cards: { visibility: 9 } } } } },
      step('pubreq_c', { cards: coll(SEED) }),
    ]);
    expect(cards).toEqual({ declared: true, majors: [SEED], transitions: [] });
    expect(d.stepMajors.get('pubreq_bad')).toEqual(new Map());
  });
});

describe('synthesizeCollectionSchema', () => {
  it('is the declared schema with $schema and $id = the URN', () => {
    expect(
      synthesizeCollectionSchema({
        urn: 'urn:schema:civitai-apps:pixel-garden/cards@v1',
        declared: { type: 'object', properties: { title: { type: 'string' } } },
      })
    ).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      $schema: DIALECT,
      $id: 'urn:schema:civitai-apps:pixel-garden/cards@v1',
    });
  });

  it('a declared $id never replaces the URN', () => {
    expect(
      synthesizeCollectionSchema({
        urn: 'urn:schema:civitai-apps:pixel-garden/cards@v4',
        declared: { $id: 'https://elsewhere.example/schema-q2' },
      }).$id
    ).toBe('urn:schema:civitai-apps:pixel-garden/cards@v4');
  });
});
