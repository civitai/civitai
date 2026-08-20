import { describe, it, expect } from 'vitest';
import type * as z from 'zod';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { modelsEndpointSchema } from '~/pages/api/v1/models';

/**
 * /api/v1/models parses this schema straight off `req.query`, where every value is a
 * string. `z.coerce.boolean()` is JS `Boolean()` there, so `?earlyAccess=false` parsed
 * as `true` and switched the filter on — the caller got the opposite of what it asked
 * for, with no error.
 *
 * The keys are discovered from the schema rather than listed, because a hand-listed set
 * has the same blind spot as the bug: it cannot see the next field someone declares on
 * `z.coerce.boolean()`.
 *
 * BOTH schemas are checked. The endpoint parses `modelsEndpointSchema`, which extends
 * the shared one and overrides several fields — so an override reintroducing
 * `z.coerce.boolean()` at the endpoint is the same live bug, and it is invisible to a
 * test that only knows about the shared schema.
 */

// A `z.preprocess` field can THROW rather than return an issue (commaDelimitedNumberArray
// calls .map on whatever it is handed), and at module scope that would fail collection —
// zero tests, reported as a pass. Treat a throw as "does not accept this value".
function parseOne(schema: z.ZodObject, key: string, value: unknown) {
  try {
    const result = schema.safeParse({ [key]: value });
    return result.success ? { value: (result.data as Record<string, unknown>)[key] } : null;
  } catch {
    return null;
  }
}

function booleanKeys(schema: z.ZodObject) {
  return Object.keys(schema.shape).filter((key) => parseOne(schema, key, true) !== null);
}

/**
 * Every field that is meant to read a boolean OUT OF A QUERY STRING. Named, and only for
 * the non-vacuity guard below — the assertions themselves stay derived from the schema.
 */
const QUERY_STRING_BOOLEANS = [
  'favorites',
  'hidden',
  'needsReview',
  'earlyAccess',
  'paidAccess',
  'supportsGeneration',
  'fromPlatform',
  'followed',
  'newCreators',
  'archived',
];

function describeSchema(label: string, schema: z.ZodObject, expected: string[]) {
  describe(`${label} — boolean params over raw query strings`, () => {
    // Non-vacuity. Discovery also picks up keys that merely tolerate a boolean —
    // `Number(true) === 1` gets `limit`, `page` and `rating` in — so a bare count is
    // satisfied by fields this bug cannot touch. Name the ones that must be there.
    it('discovers every query-string boolean', () => {
      expect(booleanKeys(schema)).toEqual(expect.arrayContaining(expected));
    });

    it('never parses the STRING `false` as true, for any boolean param', () => {
      for (const key of booleanKeys(schema)) {
        const parsed = parseOne(schema, key, 'false');
        // Rejecting the string is fine — that fails closed with a 400. Accepting it as
        // `true` is the bug.
        const value = parsed ? parsed.value : '<rejected>';
        expect(value, `?${key}=false parsed as ${String(value)}`).not.toBe(true);
      }
    });

    // The other polarity: a field that rejected everything would satisfy the test above.
    it('still parses `true`, `false` and real booleans correctly', () => {
      for (const key of expected) {
        expect(parseOne(schema, key, 'true')?.value, `?${key}=true`).toBe(true);
        expect(parseOne(schema, key, 'false')?.value, `?${key}=false`).toBe(false);
        expect(parseOne(schema, key, true)?.value, `${key}: true`).toBe(true);
      }
    });
  });
}

describeSchema('getAllModelsSchema', getAllModelsSchema, QUERY_STRING_BOOLEANS);
describeSchema('modelsEndpointSchema (/api/v1/models)', modelsEndpointSchema, [
  ...QUERY_STRING_BOOLEANS,
  // The endpoint's own additions.
  'nsfw',
  'primaryFileOnly',
]);
