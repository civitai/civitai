import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same mocked surface as stickerPlacementAccepted.reward.test.ts: base.reward builds a ClickHouse
// client and buzz.service at import time.
const h = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert: (...args: unknown[]) => h.insert(...(args as [])) },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => h.createBuzzTransactionMany(...(args as [])),
  getMultipliersForUser: (...args: unknown[]) => h.getMultipliersForUser(...(args as [])),
  getTransactionByExternalId: vi.fn(async () => null),
}));

import { reportAcceptedReward } from '~/server/rewards/passive/reportAccepted.reward';

/** The buzzEvents rows written, as `toUserId:forId`. A pending row is what process-rewards pays. */
const written = () =>
  h.insert.mock.calls.flatMap((call) => {
    const [{ values }] = call as unknown as [{ values: { toUserId: number; forId: number }[] }];
    return values.map((v) => `${v.toUserId}:${v.forId}`);
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the report accepted reward', () => {
  // Literal -1 rather than the constant: a fixture following a changed constant would keep passing
  // while the system account's real reports started paying again.
  it('records no reward for a report filed by the system account', async () => {
    await reportAcceptedReward.apply({ userId: -1, reportId: 9 });
    await reportAcceptedReward.apply({ userId: 42, reportId: 10 });

    // The person's report is the control: it shows a write would have been seen.
    expect(written()).toEqual(['42:10']);
  });
});
