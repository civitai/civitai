import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mockDbRead = dbMock.dbRead;
void loggingMock;

const { resolveDailyPlan } = await import('~/server/games/daily-challenge/daily-plan');
const { pickDailyRubricSet } = await import('~/server/games/daily-challenge/daily-schedule');

const defaultJudge = {
  judgeId: 1,
  userId: 100,
  sourceCollectionId: null,
  prompts: { systemMessage: '', collection: '', content: '', article: '', review: '', winner: '' },
  reviewTemplate: null,
};
const holidayJudgeRow = {
  id: 7,
  userId: 100,
  sourceCollectionId: null,
  systemPrompt: 'jolly',
  collectionPrompt: null,
  contentPrompt: null,
  reviewPrompt: null,
  reviewTemplate: null,
  winnerSelectionPrompt: null,
};
const dec1 = new Date('2026-12-01T00:00:00Z');
const withFlags = (schedule: boolean, rotation: boolean) => ({
  defaultJudge,
  flags: { schedule, rotation },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.challengeCategory.findMany.mockResolvedValue([]);
});

describe('resolveDailyPlan', () => {
  it('judges a scheduled day with its holiday judge and rubric set', async () => {
    mockDbRead.challengeJudge.findFirst.mockResolvedValue({ id: 7 });
    mockDbRead.challengeJudge.findUnique.mockResolvedValue(holidayJudgeRow);

    const plan = await resolveDailyPlan(dec1, withFlags(true, true));

    expect(plan.judgeId).toBe(7);
    expect(plan.judgingConfig.prompts.systemMessage).toBe('jolly');
    expect(plan.judgingCategories?.map((c) => [c.key, c.weight])).toEqual([
      ['theme', 50],
      ['storytelling', 25],
      ['creativity', 15],
      ['aesthetic', 10],
    ]);
    expect(plan.occasion).toMatchObject({
      name: 'Advent opens',
      judgedOn: ['Storytelling', 'Creativity', 'Aesthetic'],
    });
    expect(plan.record).toEqual({
      setKey: 'story',
      source: 'schedule',
      judgeName: 'Jolly CivBot',
      occasion: 'Advent opens',
    });
  });

  it('keeps the day on the default judge when the scheduled judge does not exist', async () => {
    mockDbRead.challengeJudge.findFirst.mockResolvedValue(null);

    const plan = await resolveDailyPlan(dec1, withFlags(true, true));

    expect(plan.judgeId).toBe(1);
    expect(plan.judgingConfig).toBe(defaultJudge);
    expect(plan.record?.judgeName).toBe('default');
    expect(plan.record?.setKey).toBe('story');
  });

  it('with the schedule flag off, a scheduled date takes the rotation', async () => {
    const plan = await resolveDailyPlan(dec1, withFlags(false, true));

    expect(plan.record).toEqual({
      setKey: pickDailyRubricSet(dec1),
      source: 'rotation',
      judgeName: 'default',
    });
    expect(plan.occasion).toBeUndefined();
    expect(mockDbRead.challengeJudge.findFirst).not.toHaveBeenCalled();
  });

  it('with both flags off, every day is the fixed rubric and default judge', async () => {
    expect(await resolveDailyPlan(dec1, withFlags(false, false))).toEqual({
      judgeId: 1,
      judgingConfig: defaultJudge,
    });
    expect(
      await resolveDailyPlan(new Date('2027-01-05T00:00:00Z'), withFlags(false, false))
    ).toEqual({ judgeId: 1, judgingConfig: defaultJudge });
  });

  it('with only the schedule flag on, an unscheduled date is the fixed rubric', async () => {
    expect(
      await resolveDailyPlan(new Date('2027-01-05T00:00:00Z'), withFlags(true, false))
    ).toEqual({ judgeId: 1, judgingConfig: defaultJudge });
  });
});
