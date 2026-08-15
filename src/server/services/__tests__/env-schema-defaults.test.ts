import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { env } from '~/__tests__/mocks/env.mock';

/**
 * Every env var the schema gives a DEFAULT must read as something under test.
 *
 * 🔴 This guard reads the schema's SOURCE TEXT on purpose. The obvious check —
 * `expect(env[key]).toBe(serverSchema.shape[key].parse(undefined))` — re-runs the seeding code
 * and can only confirm that it agrees with itself, which is the shape that lets a dropped key
 * through. Static text and runtime parsing share no code path, so a seeding bug shows up here
 * as a MISSING KEY rather than as a matching pair of wrongs.
 *
 * It asserts PRESENCE, not equality. Equality would re-import the value from the thing under
 * test, and it would also fire wrongly whenever `TEST_ENV_DEFAULTS` deliberately overrides a
 * schema default with a test fixture — which is legal and should stay quiet.
 *
 * Why it matters: production `env` is the parsed object, so a defaulted key is never
 * `undefined` there. A test seeing `undefined` takes branches production never takes —
 * `db-lag-helpers.ts` gates on `env.REPLICATION_LAG_DELAY <= 0`, and `undefined <= 0` is false.
 */

const SCHEMA = path.join(process.cwd(), 'src/env/server-schema.ts');

/** Keys written as `KEY: <anything>.default(…)` on one line. Deliberately narrow: a key this
 * misses is a key the guard does not cover, which is a smaller failure than a false match. */
function defaultedKeysFromSource(): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const keys = new Set<string>();
  for (const line of src.split('\n')) {
    if (!line.includes('.default(')) continue;
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*:/.exec(line);
    if (m) keys.add(m[1]);
  }
  return [...keys].sort();
}

describe('TEST_ENV_DEFAULTS covers the schema defaults', () => {
  const keys = defaultedKeysFromSource();

  // Positive control for the extractor itself: an empty list would make every assertion below
  // vacuous and the suite would still be green.
  it('finds a plausible number of defaulted keys in the schema source', () => {
    expect(keys.length).toBeGreaterThan(50);
    expect(keys).toContain('REPLICATION_LAG_DELAY');
  });

  it.each(keys)('%s is not undefined under test', (key) => {
    expect(env[key]).not.toBeUndefined();
  });
});
