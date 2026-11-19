import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { getSettlementHolds } from '~/server/services/creator-program-prepayout-review/hold';
import {
  settlementState,
  type SettlementRow,
} from '../../../../../apps/moderator/src/lib/payout-review';

// The moderator Payout Reviews page marks rows with its own copy of settlement's hold rule. Every
// one- and two-period combination of status and hold flag must come out as settlement sees it.
const STATUSES = ['open', 'escalated', 'withheld', 'cleared'];
const VARIANTS = STATUSES.flatMap((status) => [true, false].map((hold) => ({ status, hold })));

function everyCombination(): SettlementRow[] {
  const rows: SettlementRow[] = [];
  let userId = 990300000;
  for (const latest of VARIANTS) {
    rows.push({ userId: ++userId, period: '2026-10', ...latest });
    for (const older of VARIANTS) {
      userId++;
      rows.push({ userId, period: '2026-09', ...older }, { userId, period: '2026-10', ...latest });
    }
  }
  return rows;
}

describe('the moderator Payout Reviews page', () => {
  it('holds and pays exactly the creators settlement holds and pays', async () => {
    const rows = everyCombination();
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue(rows as never);
    dbMock.dbWrite.creatorProgramPayoutReviewRun.findFirst.mockResolvedValue({ id: 1 } as never);
    dbMock.dbWrite.user.findMany.mockImplementation((({
      where,
    }: {
      where: { id: { in: number[] } };
    }) => Promise.resolve(where.id.in.map((id) => ({ id, onboarding: 0 })))) as never);

    const settlement = await getSettlementHolds('2026-10');
    const spoke = settlementState(rows);
    const spokePaid = rows
      .filter(
        (r) => r.status === 'cleared' && spoke.isLatest(r) && !spoke.heldUserIds.has(r.userId)
      )
      .map((r) => r.userId);

    expect(settlement.heldUserIds.size).toBeGreaterThan(0);
    expect(settlement.clearedUserIds.length).toBeGreaterThan(0);
    expect([...spoke.heldUserIds].sort()).toEqual([...settlement.heldUserIds].sort());
    expect(spokePaid.sort()).toEqual([...settlement.clearedUserIds].sort());
  });
});
