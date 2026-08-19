import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The review found this service entirely untested, which is how `Number(score)` shipped:
// `getCreatorRequirements` returns `score` as `{ min, current }`, `Number({...})` is NaN,
// and `NaN >= minScore` is false — so every creator was refused, forever, with a message
// naming a threshold they may well have cleared. Nothing typechecked wrong about it.

vi.mock('~/server/services/creator-program.service', () => ({
  getCreatorRequirements: vi.fn(),
}));

import { getCreatorRequirements } from '~/server/services/creator-program.service';
import { getAnnouncementAllowance } from '../announcement-allowance.service';

const USER = 42;

function requirements({ current = 50_000, membership }: { current?: number; membership?: string }) {
  return {
    score: { min: 40_000, current },
    membership,
    validMembership: false,
    membershipLapsed: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null as never);
  dbMock.dbRead.announcementSpend.findMany.mockResolvedValue([] as never);
  vi.mocked(getCreatorRequirements).mockResolvedValue(requirements({}) as never);
});

describe('the score floor', () => {
  it('reads score.current, not the score object', async () => {
    vi.mocked(getCreatorRequirements).mockResolvedValue(requirements({ current: 12_345 }) as never);

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.score).toBe(12_345);
    expect(allowance.eligible).toBe(true);
  });

  it('refuses below the floor, and reports the number it compared against', async () => {
    vi.mocked(getCreatorRequirements).mockResolvedValue(requirements({ current: 9_999 }) as never);

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.eligible).toBe(false);
    expect(allowance.minScore).toBe(10_000);
  });

  it('is not eligible when the score is absent rather than accidentally passing', async () => {
    vi.mocked(getCreatorRequirements).mockResolvedValue(undefined as never);

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.score).toBe(0);
    expect(allowance.eligible).toBe(false);
  });
});

describe('the tier caps Justin set', () => {
  it.each([
    [undefined, 'free', 1, 30],
    ['bronze', 'bronze', 1, 14],
    ['silver', 'silver', 1, 7],
    ['gold', 'gold', 2, 7],
  ])('%s membership gets %s: %i per %i days', async (membership, tier, limit, windowDays) => {
    vi.mocked(getCreatorRequirements).mockResolvedValue(
      requirements({ membership: membership as string }) as never
    );

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.tier).toBe(tier);
    expect(allowance.limit).toBe(limit);
    expect(allowance.windowDays).toBe(windowDays);
  });

  it('treats an unrecognised membership as free rather than as a tier with no cap', async () => {
    vi.mocked(getCreatorRequirements).mockResolvedValue(
      requirements({ membership: 'founder' }) as never
    );

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.tier).toBe('free');
    expect(allowance.limit).toBe(1);
  });
});

describe('the KeyValue override', () => {
  it('takes the stored floor and caps over the compiled defaults', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      key: 'announcements:config',
      value: { minScore: 500, caps: { free: { days: 1, count: 9 } } },
    } as never);
    vi.mocked(getCreatorRequirements).mockResolvedValue(requirements({ current: 600 }) as never);

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.minScore).toBe(500);
    expect(allowance.eligible).toBe(true);
    expect(allowance.limit).toBe(9);
    expect(allowance.windowDays).toBe(1);
  });

  it('falls back to the defaults on a malformed row instead of throwing the feature off', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      key: 'announcements:config',
      value: { minScore: 'lots', caps: { free: { days: -4 } } },
    } as never);

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.minScore).toBe(10_000);
    expect(allowance.limit).toBe(1);
    expect(allowance.windowDays).toBe(30);
  });

  it('keeps the compiled caps for tiers the row does not mention', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      key: 'announcements:config',
      value: { caps: { free: { days: 3, count: 3 } } },
    } as never);
    vi.mocked(getCreatorRequirements).mockResolvedValue(
      requirements({ membership: 'gold' }) as never
    );

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.limit).toBe(2);
    expect(allowance.windowDays).toBe(7);
  });
});

describe('spend counting', () => {
  it('counts spends in the window, not live announcements', async () => {
    await getAnnouncementAllowance(USER);

    const where = (
      dbMock.dbRead.announcementSpend.findMany.mock.calls[0][0] as {
        where: { userId: number; createdAt: { gte: Date } };
      }
    ).where;

    expect(where.userId).toBe(USER);
    // 30 days back for free, give or take the moment the clock was read.
    const daysBack = (Date.now() - where.createdAt.gte.getTime()) / 86_400_000;
    expect(daysBack).toBeGreaterThan(29.9);
    expect(daysBack).toBeLessThan(30.1);
    expect(dbMock.dbRead.announcement.findMany).not.toHaveBeenCalled();
  });

  it('reports when the next slot returns, one window after the oldest spend', async () => {
    const oldest = new Date(Date.now() - 10 * 86_400_000);
    dbMock.dbRead.announcementSpend.findMany.mockResolvedValue([{ createdAt: oldest }] as never);

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.used).toBe(1);
    expect(allowance.nextAvailableAt?.getTime()).toBe(oldest.getTime() + 30 * 86_400_000);
  });

  it('leaves nextAvailableAt null while a slot is free', async () => {
    vi.mocked(getCreatorRequirements).mockResolvedValue(
      requirements({ membership: 'gold' }) as never
    );
    dbMock.dbRead.announcementSpend.findMany.mockResolvedValue([
      { createdAt: new Date() },
    ] as never);

    const allowance = await getAnnouncementAllowance(USER);

    expect(allowance.used).toBe(1);
    expect(allowance.limit).toBe(2);
    expect(allowance.nextAvailableAt).toBeNull();
  });
});
