import { describe, expect, it, vi } from 'vitest';

/**
 * What `listSupportMembershipCodes` hands the panel. `revokedAt` matters most: without it a revoked
 * code (its expiresAt is the epoch) would show as merely "expired".
 */

const row = vi.hoisted(() => ({
  code: 'MB-ABCD-EF12',
  unitValue: 2,
  priceId: 'silver-monthly',
  createdAt: new Date('2026-10-13T00:00:00.000Z'),
  expiresAt: new Date(0),
  redeemedAt: null,
  reason: 'Ticket 9',
  mintedBy: '990000007',
  revokedAt: '2026-10-13T01:00:00.000Z',
}));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb([], [row]);
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

describe('listSupportMembershipCodes row shape', () => {
  it('maps a row to what the panel reads', async () => {
    const [mapped] = await listSupportMembershipCodes(8675309);
    expect(mapped).toEqual({
      code: 'MB-ABCD-EF12',
      months: 2,
      tier: 'silver',
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      redeemedAt: null,
      revokedAt: '2026-10-13T01:00:00.000Z',
      reason: 'Ticket 9',
      mintedBy: 990000007,
    });
  });

  it('a revoked code reads as revoked, not expired', async () => {
    const [mapped] = await listSupportMembershipCodes(8675309);
    expect(
      membershipCodeStatus({
        redeemedAt: null,
        expiresAt: mapped.expiresAt?.toISOString() ?? null,
        revokedAt: mapped.revokedAt,
      })
    ).toBe('revoked');
  });
});
