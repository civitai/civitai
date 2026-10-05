import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getCreatorJourney,
  getCreatorScoreLadder,
  maskUnearnedMilestone,
} from '~/server/services/creator-journey.service';

const definition = (overrides: Partial<Parameters<typeof maskUnearnedMilestone>[0]> = {}) => ({
  key: 'hidden:remix',
  track: 'hidden',
  threshold: null,
  hidden: true,
  hint: 'Someone builds on your work',
  name: 'Remixed',
  description: 'Someone remixed your model.',
  ...overrides,
});

describe('maskUnearnedMilestone', () => {
  it('masks a hidden milestone the viewer has not earned, keeping only its hint', () => {
    expect(maskUnearnedMilestone(definition(), false)).toMatchObject({
      name: '???',
      description: null,
      hint: 'Someone builds on your work',
    });
  });

  it('reveals it once earned', () => {
    expect(maskUnearnedMilestone(definition(), true).name).toBe('Remixed');
  });

  // The `hidden` TRACK is a grouping label; only the per-row flag masks.
  it('does not mask a row in the hidden track whose flag is off', () => {
    expect(maskUnearnedMilestone(definition({ hidden: false }), false).name).toBe('Remixed');
  });

  it('masks a flagged row in any track', () => {
    expect(maskUnearnedMilestone(definition({ track: 'score', threshold: 500 }), false).name).toBe(
      '???'
    );
  });
});

describe('getCreatorJourney', () => {
  it('tolerates zero milestone rows and a user with no scores', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ meta: {} } as never);

    const journey = await getCreatorJourney(1);

    expect(journey.scores).toBeNull();
    expect(journey.tiers).toEqual([]);
    expect(journey.earned).toEqual([]);
    expect(journey.unlocks.length).toBeGreaterThan(0);
  });

  it('reads only the viewer’s own achievements', async () => {
    await getCreatorJourney(42);

    expect(dbMock.dbRead.userCreatorMilestone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42 } })
    );
    expect(dbMock.dbRead.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    );
  });

  it('compares aggregate gates against the larger of the category sum and the total', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      meta: { scores: { total: 100, models: 300, images: 50, reportsAgainst: -20 } },
    } as never);

    const { scores } = await getCreatorJourney(1);

    expect(scores).toMatchObject({ total: 100, aggregate: 330, articles: 0 });
  });

  it('masks an unearned hidden tier and reveals an earned one', async () => {
    const hiddenTier = { ...definition({ key: 'score:secret', track: 'score', threshold: 777 }) };
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([hiddenTier] as never);

    expect((await getCreatorJourney(1)).tiers[0].name).toBe('???');

    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([
      { achievedAt: new Date('2026-10-01'), milestone: hiddenTier },
    ] as never);

    const journey = await getCreatorJourney(1);
    expect(journey.tiers[0].name).toBe('Remixed');
    expect(journey.earned).toEqual([
      expect.objectContaining({ key: 'score:secret', achievedAt: new Date('2026-10-01') }),
    ]);
  });
});

describe('getCreatorScoreLadder', () => {
  it('masks every hidden tier, since nobody has earned anything here', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([
      definition({ key: 'score:secret', track: 'score', threshold: 777 }),
    ] as never);

    expect((await getCreatorScoreLadder()).tiers).toEqual([
      { key: 'score:secret', name: '???', threshold: 777, hint: 'Someone builds on your work' },
    ]);
  });
});
