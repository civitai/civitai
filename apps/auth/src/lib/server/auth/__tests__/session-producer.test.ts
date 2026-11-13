import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The account that owns workload clients resolves to no session, whichever path asks for one. */

const h = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }));

vi.mock('../../db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.where = () => qb;
      qb.select = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(h.row);
      return qb;
    },
  },
}));
vi.mock('../../redis', () => ({ getRedis: () => null, getSysRedis: () => null }));

import { produceSessionUser } from '../session-producer';

function userRow(roles: string[]) {
  return {
    id: 900,
    username: 'system_workers',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    showNsfw: false,
    blurNsfw: true,
    browsingLevel: 1,
    onboarding: 0,
    muted: false,
    subscriptionRows: [],
    roleRows: roles.map((role) => ({ role })),
    membershipOverride: null,
  };
}

beforeEach(() => {
  h.row = undefined;
});

describe('produceSessionUser', () => {
  it('produces no session for a holder of the system:workload role', async () => {
    h.row = userRow(['system:workload']);
    expect(await produceSessionUser(900)).toBeNull();
  });

  it('produces the session for the same row without that role (positive control)', async () => {
    h.row = userRow(['tester']);
    expect(await produceSessionUser(900)).toMatchObject({ id: 900, username: 'system_workers' });
  });
});
