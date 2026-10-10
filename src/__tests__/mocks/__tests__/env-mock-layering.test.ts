import { describe, expect, it } from 'vitest';

import { env } from '~/env/server';
import { TEST_ENV_DEFAULTS } from '~/__tests__/mocks';

// The schema's defaults load when `~/env/server` is first imported, after the test table is set,
// and go under it.
describe('the canonical env mock', () => {
  it('answers a key only the schema defaults', () => {
    expect(TEST_ENV_DEFAULTS).not.toHaveProperty('REPLICATION_LAG_DELAY');
    expect(env.REPLICATION_LAG_DELAY).toBe(0);
  });

  it('lets the test table win over the schema', () => {
    // Schema defaults: true and 20.
    expect(env.DATABASE_SSL).toBe(false);
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });
});
