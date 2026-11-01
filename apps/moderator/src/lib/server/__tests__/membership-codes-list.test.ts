import { describe, expect, it, vi } from 'vitest';

/**
 * The support panel's list of codes minted for one account, and the status each is shown with.
 *
 * The query is correct only in its emitted SQL: keyed on `userId` so it rides the
 * (userId, createdAt) index rather than scanning RedeemableCode's metadata, and filtered to support
 * codes so a customer's shop or gift codes never appear in a list that offers Revoke.
 */

const captured = vi.hoisted(() => [] as string[]);
const capturedParams = vi.hoisted(() => [] as unknown[][]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured, [], capturedParams);
  // dbRead throws: the list must read the primary, or a just-revoked code shows as open.
  const replica = new Proxy(
    {},
    {
      get: () => {
        throw new Error('membership codes must be read from the primary');
      },
    }
  );
  return { dbRead: replica, dbWrite: db };
});

const { listSupportMembershipCodes } = await import('../membership-code.service');
const { membershipCodeStatus } = await import('$lib/membership-code');

const compile = async () => {
  captured.length = 0;
  capturedParams.length = 0;
  await listSupportMembershipCodes(8675309);
  expect(captured).toHaveLength(1);
  return { sql: captured[0], params: capturedParams[0] };
};

describe('listSupportMembershipCodes SQL', () => {
  it('reads the main database by the indexed userId', async () => {
    const { sql, params } = await compile();
    expect(sql).toContain('from "RedeemableCode"');
    const user = /"userId" = \$(\d+)/.exec(sql);
    expect(user).not.toBeNull();
    expect(params[Number(user![1]) - 1]).toBe(8675309);
  });

  it('only support codes', async () => {
    const { sql, params } = await compile();
    const source = /metadata ->> 'source' = \$(\d+)/.exec(sql);
    expect(source).not.toBeNull();
    expect(params[Number(source![1]) - 1]).toBe('moderator-membership-code');
  });

  it('newest first, capped', async () => {
    const { sql, params } = await compile();
    expect(sql).toMatch(/order by "createdAt" desc/);
    const limit = /limit \$(\d+)/.exec(sql);
    expect(limit).not.toBeNull();
    expect(params[Number(limit![1]) - 1]).toBe(25);
  });
});

describe('membershipCodeStatus', () => {
  const now = new Date('2026-10-13T12:00:00.000Z');
  const base = {
    redeemedAt: null as string | null,
    expiresAt: '2026-11-12T12:00:00.000Z' as string | null,
    revokedAt: null as string | null,
  };

  it.each([
    ['open', base, 'open'],
    [
      'redeemed wins over everything',
      { ...base, redeemedAt: '2026-10-01T00:00:00.000Z' },
      'redeemed',
    ],
    [
      'revoked',
      { ...base, revokedAt: '2026-10-12T00:00:00.000Z', expiresAt: '2026-10-12T00:00:00.000Z' },
      'revoked',
    ],
    ['expired', { ...base, expiresAt: '2026-10-12T00:00:00.000Z' }, 'expired'],
    [
      'expiring exactly now counts as expired',
      { ...base, expiresAt: now.toISOString() },
      'expired',
    ],
  ])('%s', (_l, row, expected) => {
    expect(membershipCodeStatus(row, now)).toBe(expected);
  });
});
