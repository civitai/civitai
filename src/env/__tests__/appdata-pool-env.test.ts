import { describe, expect, it } from 'vitest';
import { dbEnvSchema } from '@civitai/db';
import { serverSchema } from '~/env/server-schema';

/**
 * The document store's pool settings are validated twice: by the app's `serverSchema` at boot and by
 * `@civitai/db`'s own schema when `getClient` first loads its config. Every case runs against BOTH,
 * so the two cannot drift into accepting different values (a value one accepts and the other
 * rejects would pass boot and then fail on the first document-store call).
 */
const schemas = [
  ['app server schema', serverSchema.shape],
  ['@civitai/db schema', dbEnvSchema.shape],
] as const;

type Field =
  | 'APPDATA_POOL_MAX'
  | 'APPDATA_POOL_IDLE_TIMEOUT'
  | 'APPDATA_DATABASE_HOST'
  | 'APPDATA_DATABASE_PORT';

const cases: Record<Field, { unset: unknown; valid: [string, unknown][]; invalid: string[] }> = {
  // Defaults to a small pool of its own: unset must NOT inherit DATABASE_POOL_MAX (20).
  APPDATA_POOL_MAX: {
    unset: 4,
    valid: [['7', 7]],
    invalid: ['', '0', '-1', 'abc', '2.5', ' 3'],
  },
  APPDATA_POOL_IDLE_TIMEOUT: {
    unset: undefined,
    valid: [
      ['15000', 15000],
      ['0', 0],
    ],
    invalid: ['', '-5', 'abc', '1.5'],
  },
  APPDATA_DATABASE_HOST: {
    unset: undefined,
    valid: [
      ['pooler.example.internal', 'pooler.example.internal'],
      ['pooler', 'pooler'],
      ['10.1.2.3', '10.1.2.3'],
    ],
    // Each of these would otherwise be silently truncated or misparsed by the URL host setter.
    invalid: [
      '',
      'host:6432',
      'postgres://host',
      'a/b',
      'user@host',
      'has space',
      '-leading',
      '[::1]',
    ],
  },
  APPDATA_DATABASE_PORT: {
    unset: undefined,
    valid: [['6432', 6432]],
    invalid: ['', '0', '65536', 'abc', '64.5', '-1'],
  },
};

describe.each(schemas)('document-store pool env (%s)', (_name, shape) => {
  describe.each(Object.keys(cases) as Field[])('%s', (key) => {
    const field = shape[key];
    const { unset, valid, invalid } = cases[key];

    it('is declared', () => {
      expect(field).toBeDefined();
    });

    it('resolves the documented value when unset', () => {
      expect(field.parse(undefined)).toBe(unset);
    });

    it.each(valid)('accepts %j', (input, expected) => {
      expect(field.parse(input)).toBe(expected);
    });

    it.each(invalid)('rejects %j', (input) => {
      expect(field.safeParse(input).success).toBe(false);
    });
  });
});
