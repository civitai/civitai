import { describe, it, expect } from 'vitest';

/**
 * Regression test for OC-317: REPLICATION_LAG_DELAY is a zod .default(0) key
 * that was absent from the hand-enumerated TEST_ENV_DEFAULTS. Under test the
 * canonical env read undefined, and `undefined <= 0` is false where `0 <= 0` is
 * true — so every test reaching getDbWithoutLag without stubbing db-lag-helpers
 * took a replication-staleness branch that production never takes.
 *
 * This test proves the specific defect is closed:
 * 1. The env default is 0 (not undefined) — the direct fix
 * 2. getDbWithoutLag returns dbRead via the short-circuit path
 *
 * Red at 312a91ad7c: env.REPLICATION_LAG_DELAY was undefined, so
 * expect(undefined).toBe(0) failed.
 *
 * Green at HEAD: TEST_ENV_DEFAULTS now derives REPLICATION_LAG_DELAY: 0 from
 * the env schema, so expect(0).toBe(0) passes and getDbWithoutLag short-circuits.
 */

// Uses the CANONICAL shared redis mock, not a hand-rolled one. Mocking the redis
// client specifier directly here would add a new entry to the canonical allowlist,
// and the migration ratchet then refuses to regenerate — so this file's own mock
// would have blocked the two conversions it ships alongside.
//
// Note for anyone editing this comment: the ratchet detects violations with a plain
// regex over the file's TEXT, so spelling the forbidden call out literally — even
// inside a comment — re-triggers it. Describe it, do not quote it.
import '~/__tests__/mocks/redis.mock';

import { env } from '~/env/server';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { dbRead } from '~/server/db/client';

describe('OC-317: REPLICATION_LAG_DELAY defaults to 0 in test env', () => {
  it('env.REPLICATION_LAG_DELAY is 0, not undefined', () => {
    expect(env.REPLICATION_LAG_DELAY).toBe(0);
  });

  it('getDbWithoutLag returns dbRead without consulting the lag tracker', async () => {
    const result = await getDbWithoutLag('model', 123);
    expect(result).toBe(dbRead);
  });

  it('getDbWithoutLag returns dbRead even without type/id args', async () => {
    const result = await getDbWithoutLag();
    expect(result).toBe(dbRead);
  });
});
