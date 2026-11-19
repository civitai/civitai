import { describe, expect, it } from 'vitest';
import { validateDocAgainstCollectionSchema } from '~/server/services/apps/doc-store-schema';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { DocStoreError } from '~/server/services/apps/doc-store.types';

/**
 * The collection-schema evaluator's SEMANTICS, which every other evaluator of the subset (the
 * CLI's offline check) must share. The store-level behaviour (which writes are checked, what is
 * stored) is in `doc-store.functional.ts`. Expected pointers, keywords and messages are literals.
 */

const coll = (schema?: Record<string, unknown>, name = 'cards'): DocCollection => ({
  name,
  config: {
    kind: 'docs',
    visibility: 'private',
    counters: [],
    marks: [],
    indexes: new Map(),
    showAuthor: false,
    ...(schema ? { schema } : {}),
  },
});
const APP = { appId: 'ab_SCHEMAUNIT' };

/** The refusal as `{ pointer, keyword }`, or null when the body matches. */
function verdict(schema: Record<string, unknown>, data: unknown) {
  try {
    validateDocAgainstCollectionSchema(APP, coll(schema), data);
    return null;
  } catch (err) {
    if (!(err instanceof DocStoreError) || err.code !== 'schema_violation') throw err;
    const { pointer, keyword } = err.details as { pointer: string; keyword: string };
    return { pointer, keyword };
  }
}
const at = (pointer: string, keyword: string) => ({ pointer, keyword });

describe('validateDocAgainstCollectionSchema', () => {
  it('a collection without a schema accepts anything', () => {
    expect(() =>
      validateDocAgainstCollectionSchema(APP, coll(), { anything: [1, { at: null }] })
    ).not.toThrow();
  });

  it.each<[string, Record<string, unknown>, unknown, ReturnType<typeof at> | null]>([
    // type
    ['integer accepts 4', { properties: { n: { type: 'integer' } } }, { n: 4 }, null],
    [
      'integer refuses 4.5',
      { properties: { n: { type: 'integer' } } },
      { n: 4.5 },
      at('/n', 'type'),
    ],
    ['number includes integers', { properties: { n: { type: 'number' } } }, { n: 4 }, null],
    [
      'null is its own type',
      { properties: { n: { type: 'object' } } },
      { n: null },
      at('/n', 'type'),
    ],
    [
      'an array is not an object',
      { properties: { n: { type: 'object' } } },
      { n: [] },
      at('/n', 'type'),
    ],
    ['a type list', { properties: { n: { type: ['string', 'null'] } } }, { n: null }, null],
    ['root type', { type: 'array' }, {}, at('', 'type')],
    // keywords for another type are ignored
    ['minLength ignores a number', { properties: { n: { minLength: 3 } } }, { n: 1 }, null],
    ['maximum ignores a string', { properties: { n: { maximum: 3 } } }, { n: 'zzzz' }, null],
    // const / enum compare JSON values, any key order
    [
      'const with an object',
      { properties: { n: { const: { a: 1, b: [2] } } } },
      { n: { b: [2], a: 1 } },
      null,
    ],
    [
      'const extra key',
      { properties: { n: { const: { a: 1 } } } },
      { n: { a: 1, c: 0 } },
      at('/n', 'const'),
    ],
    ['enum with null', { properties: { n: { enum: ['p', null] } } }, { n: null }, null],
    ['enum is not loose', { properties: { n: { enum: [1] } } }, { n: '1' }, at('/n', 'enum')],
    // strings: code points, unanchored pattern
    ['3 emoji are 3 characters', { properties: { s: { maxLength: 3 } } }, { s: '😀😀😀' }, null],
    [
      '4 emoji are not',
      { properties: { s: { maxLength: 3 } } },
      { s: '😀😀😀😀' },
      at('/s', 'maxLength'),
    ],
    [
      'pattern is unanchored',
      { properties: { s: { pattern: 'b+', maxLength: 9 } } },
      { s: 'abbc' },
      null,
    ],
    [
      'pattern refuses',
      { properties: { s: { pattern: '^b+$', maxLength: 9 } } },
      { s: 'abbc' },
      at('/s', 'pattern'),
    ],
    // maxLength runs before pattern
    [
      'maxLength is reported before pattern',
      { properties: { s: { pattern: '^b+$', maxLength: 2 } } },
      { s: 'abbc' },
      at('/s', 'maxLength'),
    ],
    // numbers and arrays
    ['minimum is inclusive', { properties: { n: { minimum: 2 } } }, { n: 2 }, null],
    ['below minimum', { properties: { n: { minimum: 2 } } }, { n: 1.9 }, at('/n', 'minimum')],
    ['minItems', { properties: { l: { minItems: 2 } } }, { l: [1] }, at('/l', 'minItems')],
    ['maxItems', { properties: { l: { maxItems: 1 } } }, { l: [1, 2] }, at('/l', 'maxItems')],
    [
      'items: the first failing element',
      { properties: { l: { items: { type: 'string' } } } },
      { l: ['a', 'b', 3, 4] },
      at('/l/2', 'type'),
    ],
    // objects
    ['required in declared order', { required: ['zeta', 'alpha'] }, {}, at('/zeta', 'required')],
    [
      'additionalProperties schema checks only undeclared keys',
      { properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } },
      { a: 'x', b: 'y' },
      at('/b', 'type'),
    ],
    ['additionalProperties true', { properties: {}, additionalProperties: true }, { q: 1 }, null],
    [
      'a property named constructor is declared, not inherited',
      { properties: { constructor: { type: 'string' } }, additionalProperties: false },
      { constructor: 'x' },
      null,
    ],
    [
      'an undeclared constructor key is extra',
      { properties: { a: {} }, additionalProperties: false },
      { constructor: 'x' },
      at('/constructor', 'additionalProperties'),
    ],
    [
      'a nested pointer escapes ~ and /',
      { properties: { 'm~/n': { properties: { 'p/q': { type: 'boolean' } } } } },
      { 'm~/n': { 'p/q': 0 } },
      at('/m~0~1n/p~1q', 'type'),
    ],
  ])('%s', (_label, schema, data, expected) => {
    expect(verdict(schema, data)).toEqual(expected);
  });

  it('names the collection and a root failure in the message', () => {
    expect(() =>
      validateDocAgainstCollectionSchema(APP, coll({ type: 'array' }, 'decks'), {})
    ).toThrow(
      'document does not match the schema of collection decks at "" (the document root): expected array, got object'
    );
  });

  it('bounds a long pointer in the message but keeps it whole in details', () => {
    const key = 'k'.repeat(300);
    const schema = { properties: { [key]: { type: 'string' } } };
    try {
      validateDocAgainstCollectionSchema(APP, coll(schema), { [key]: 1 });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(DocStoreError);
      const e = err as DocStoreError;
      expect(e.details?.pointer).toBe(`/${key}`);
      expect(e.message).toBe(
        `document does not match the schema of collection cards at "/${'k'.repeat(
          199
        )}…": expected string, got number`
      );
    }
  });

  it('a schema changed under the same app and collection takes effect (the cache is per schema)', () => {
    expect(verdict({ properties: { n: { maximum: 10 } } }, { n: 7 })).toBeNull();
    expect(verdict({ properties: { n: { maximum: 5 } } }, { n: 7 })).toEqual(at('/n', 'maximum'));
    expect(verdict({ properties: { n: { maximum: 10 } } }, { n: 7 })).toBeNull();
  });
});
