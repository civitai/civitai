import { describe, it, expect } from 'vitest';
import { getAllModelsSchema } from '~/server/schema/model.schema';

/**
 * /api/v1/models parses this schema straight off `req.query`, where every value is a
 * string. `z.coerce.boolean()` is JS `Boolean()` there, so `?earlyAccess=false` parsed
 * as `true` and switched the filter on — the caller got the opposite of what it asked
 * for, with no error.
 *
 * The keys are discovered from the schema rather than listed, because a hand-listed set
 * has the same blind spot as the bug: it cannot see the next field someone declares on
 * `z.coerce.boolean()`.
 */

// A `z.preprocess` field can THROW rather than return an issue (commaDelimitedNumberArray
// calls .map on whatever it is handed), and at module scope that would fail collection —
// zero tests, reported as a pass. Treat a throw as "does not accept this value".
function parseOne(key: string, value: unknown) {
  try {
    const result = getAllModelsSchema.safeParse({ [key]: value });
    return result.success ? { ok: true as const, value: (result.data as Record<string, unknown>)[key] } : null;
  } catch {
    return null;
  }
}

function booleanKeys() {
  return Object.keys(getAllModelsSchema.shape).filter((key) => parseOne(key, true) !== null);
}

describe('getAllModelsSchema — boolean params over raw query strings', () => {
  // Non-vacuity: if discovery silently returned nothing, or stopped reaching the fields
  // this is about, every assertion below would pass over an empty list.
  it('discovers the boolean params, including the ones this bug was found on', () => {
    expect(booleanKeys()).toEqual(expect.arrayContaining(['earlyAccess', 'paidAccess']));
    expect(booleanKeys().length).toBeGreaterThanOrEqual(8);
  });

  it('never parses the STRING `false` as true, for any boolean param', () => {
    for (const key of booleanKeys()) {
      const parsed = parseOne(key, 'false');
      // Rejecting the string is fine — that fails closed with a 400. Accepting it as
      // `true` is the bug.
      const value = parsed ? parsed.value : '<rejected>';
      expect(value, `?${key}=false parsed as ${String(value)}`).not.toBe(true);
    }
  });

  it('still parses `true` and real booleans as true', () => {
    expect(getAllModelsSchema.parse({ earlyAccess: 'true' }).earlyAccess).toBe(true);
    expect(getAllModelsSchema.parse({ earlyAccess: true }).earlyAccess).toBe(true);
    expect(getAllModelsSchema.parse({ earlyAccess: 'false' }).earlyAccess).toBe(false);
  });
});
