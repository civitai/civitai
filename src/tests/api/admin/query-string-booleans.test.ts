import { describe, it, expect } from 'vitest';
import { schema as deliverPrepaidBuzzSchema } from '~/pages/api/admin/deliver-prepaid-buzz';
import { schema as permissionSchema } from '~/pages/api/admin/permission';
import { schema as giftMembershipSchema } from '~/pages/api/testing/gift-membership';
import { schema as referralsSchema } from '~/pages/api/testing/referrals';

/**
 * These four endpoints parse their schema against `req.query` (two of them against
 * `{...req.query, ...req.body}`), where every value is a string. `z.coerce.boolean()` is
 * JS `Boolean()` there, so `=false` read as `true` and the endpoint did the opposite of
 * what the operator asked for.
 *
 * Two of them are not filters but GUARDS — `confirm` gates a destructive action — so
 * under coercion `?confirm=false` SATISFIED the guard rather than declining it.
 *
 * Keys are discovered from each schema rather than listed, so a boolean added later on
 * `z.coerce.boolean()` fails here too. Discovery stays inside the `it` bodies: a
 * `z.preprocess` field can throw rather than return an issue, and at module scope that
 * throw fails COLLECTION — a file reporting as a pass with zero tests.
 */

type AnySchema = { safeParse: (value: unknown) => { success: boolean; data?: unknown } };

function shapeOf(schema: unknown) {
  // superRefine wraps the object, so the shape can sit one level down.
  const s = schema as {
    shape?: object;
    innerType?: () => { shape?: object };
    def?: { schema?: { shape?: object } };
  };
  return s.shape ?? s.def?.schema?.shape ?? {};
}

/**
 * A schema here may reject the whole object for unrelated reasons (a required field, a
 * superRefine rule), so a key is judged by what IT parsed to, read out of a successful
 * parse where possible and by direct field parse otherwise.
 */
function fieldParse(schema: unknown, key: string, value: unknown) {
  const field = (shapeOf(schema) as Record<string, AnySchema | undefined>)[key];
  if (!field) return null;
  try {
    const wrapped = field as unknown as {
      safeParse: (v: unknown) => { success: boolean; data?: unknown };
    };
    const result = wrapped.safeParse(value);
    return result.success ? { value: result.data } : null;
  } catch {
    return null;
  }
}

// Every key whose field accepts a real `true`. That is wider than "boolean": a
// z.coerce.number() field takes it too, since Number(true) === 1, so some iterations of the
// 'false' loop below are over fields this bug cannot reach. Harmless — the loop is a net,
// not an enumeration — but it is not a list of the booleans.
function booleanKeys(schema: unknown) {
  return Object.keys(shapeOf(schema)).filter((key) => fieldParse(schema, key, true) !== null);
}

const SCHEMAS: Array<{ label: string; schema: unknown; expected: string[] }> = [
  {
    label: 'admin/deliver-prepaid-buzz',
    schema: deliverPrepaidBuzzSchema,
    expected: ['force'],
  },
  { label: 'admin/permission', schema: permissionSchema, expected: ['revoke'] },
  {
    label: 'testing/gift-membership',
    schema: giftMembershipSchema,
    expected: ['anonymous', 'confirm'],
  },
  {
    label: 'testing/referrals',
    schema: referralsSchema,
    expected: ['settleImmediately', 'confirm'],
  },
];

describe.each(SCHEMAS)('$label — boolean params over raw query strings', ({ schema, expected }) => {
  // Non-vacuity: discovery returning nothing would make every assertion below pass over
  // an empty list.
  it('discovers the boolean params', () => {
    expect(booleanKeys(schema)).toEqual(expect.arrayContaining(expected));
  });

  it('never parses the STRING `false` as true', () => {
    for (const key of booleanKeys(schema)) {
      const parsed = fieldParse(schema, key, 'false');
      const value = parsed ? parsed.value : '<rejected>';
      expect(value, `?${key}=false parsed as ${String(value)}`).not.toBe(true);
    }
  });

  // The other polarity: a field rejecting everything would satisfy the test above.
  it('still parses `true`, `false` and real booleans correctly', () => {
    for (const key of expected) {
      expect(fieldParse(schema, key, 'true')?.value, `?${key}=true`).toBe(true);
      expect(fieldParse(schema, key, 'false')?.value, `?${key}=false`).toBe(false);
      expect(fieldParse(schema, key, true)?.value, `${key}: true`).toBe(true);
    }
  });
});

/**
 * `confirm` is not a filter — it GUARDS a destructive action, and both schemas enforce it
 * in a superRefine. That is the difference that made these two the worst instances of this
 * bug: under `z.coerce.boolean()` an operator writing `?confirm=false` to DECLINE the
 * action satisfied the guard instead, and the reset ran.
 *
 * Asserted through the whole schema, not the field, because the field parsing correctly is
 * not the same claim as the guard refusing.
 */
describe('confirm guards decline a query-string `false`', () => {
  const cases = [
    {
      label: 'testing/gift-membership',
      schema: giftMembershipSchema as AnySchema,
      base: { action: 'reset', userId: '1' },
    },
    {
      label: 'testing/referrals',
      schema: referralsSchema as AnySchema,
      base: { action: 'reset', userId: '1' },
    },
  ];

  it.each(cases)('$label refuses `?confirm=false`', ({ schema, base }) => {
    expect(
      schema.safeParse({ ...base, confirm: 'false' }).success,
      '?confirm=false SATISFIED the reset guard — the destructive action would run'
    ).toBe(false);
  });

  // Positive control: without it, a schema that refused every reset would pass above.
  it.each(cases)('$label still accepts `?confirm=true`', ({ schema, base }) => {
    expect(
      schema.safeParse({ ...base, confirm: 'true' }).success,
      '?confirm=true was refused — the guard now declines everything'
    ).toBe(true);
  });
});

/**
 * The guard should be satisfiable ONLY by an affirmative value, whatever shape the request
 * arrives in. Coercion is not the only way a guard gets satisfied by accident — a repeated
 * query param arrives as an array, and `{...req.query, ...req.body}` means the body can
 * supply the field instead of the query string. Both are pinned here rather than reasoned
 * about, because both are ways `false` could still become "yes" after this fix.
 */
describe.each([
  { label: 'testing/gift-membership', schema: giftMembershipSchema as AnySchema },
  { label: 'testing/referrals', schema: referralsSchema as AnySchema },
])('$label — the reset guard is satisfied only by an affirmative value', ({ schema }) => {
  const base = { action: 'reset', userId: '1' };

  const declines: Array<[string, unknown]> = [
    ['the string false', 'false'],
    ['0', '0'],
    ['no', 'no'],
    ['off', 'off'],
    ['an empty value', ''],
    ['a repeated param, one of them true', ['false', 'true']],
    ['a real boolean false', false],
    ['the number 0', 0],
    ['a junk value', 'banana'],
    ['an object', {}],
    // A real behaviour change from z.coerce.boolean(), which accepted a padded value.
    ['a padded true', ' true '],
  ];

  it.each(declines)('declines %s', (_label, confirm) => {
    expect(schema.safeParse({ ...base, confirm }).success).toBe(false);
  });

  // zod's stringbool truthy set, case-insensitive. `on` is what an HTML checkbox submits,
  // so it is listed rather than left to be discovered next to a tested `off`.
  it.each([['true'], ['TRUE'], ['yes'], ['y'], ['1'], ['on'], ['enabled']])(
    'accepts the affirmative %s',
    (confirm) => {
      expect(schema.safeParse({ ...base, confirm }).success).toBe(true);
    }
  );
});
