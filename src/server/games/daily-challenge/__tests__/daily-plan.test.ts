import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mockDbRead = dbMock.dbRead;
void loggingMock;

const { resolveDailyPlan } = await import('~/server/games/daily-challenge/daily-plan');
const { DAILY_CHALLENGE_SCHEDULE, pickDailyRubricSet } = await import(
  '~/server/games/daily-challenge/daily-schedule'
);
const { dailyRubricSetRows } = await import('~/shared/constants/challenge.constants');
const { clearChallengeCategoryCache } = await import(
  '~/server/services/challenge-category.service'
);
const { FRESHNESS_CRITERIA_SUFFIX } = await import('~/server/games/daily-challenge/recent-winners');

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
const [scheduledDate, entry] = Object.entries(DAILY_CHALLENGE_SCHEDULE)[0];
const dec1 = new Date(`${scheduledDate}T00:00:00Z`);
const setRows = () => dailyRubricSetRows(entry.set).map((c) => [c.key, c.weight]);
const withFlags = (schedule: boolean, rotation: boolean) => ({
  defaultJudge,
  flags: { schedule, rotation },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearChallengeCategoryCache();
  mockDbRead.challengeCategory.findMany.mockResolvedValue([]);
});

describe('resolveDailyPlan', () => {
  it('judges a scheduled day with its holiday judge and rubric set', async () => {
    mockDbRead.challengeJudge.findFirst.mockResolvedValue({ id: 7 });
    mockDbRead.challengeJudge.findUnique.mockResolvedValue(holidayJudgeRow);

    const plan = await resolveDailyPlan(dec1, withFlags(true, true));

    expect(plan.judgeId).toBe(7);
    expect(plan.judgingConfig.prompts.systemMessage).toBe('jolly');
    expect(plan.judgingCategories?.map((c) => [c.key, c.weight])).toEqual(setRows());
    expect(
      plan.judgingCategories
        ?.filter((c) => c.criteria.endsWith(FRESHNESS_CRITERIA_SUFFIX))
        .map((c) => c.key)
    ).toEqual(
      setRows()
        .map(([key]) => key)
        .filter((key) => key === 'creativity' || key === 'wordplay')
    );
    expect(plan.occasion?.name).toBe(entry.occasion);
    expect(plan.occasion?.judgedOn).not.toContain('Theme');
    expect(plan.record).toEqual({
      setKey: entry.set,
      source: 'schedule',
      judgeName: entry.judge,
      occasion: entry.occasion,
    });
  });

  it('uses the preset rows when the category library refuses a key', async () => {
    mockDbRead.challengeJudge.findFirst.mockResolvedValue(null);
    // An inactive row makes resolveJudgingCategories throw for that key.
    const [, inactiveKey] = dailyRubricSetRows(entry.set).map((c) => c.key);
    mockDbRead.challengeCategory.findMany.mockResolvedValue([
      {
        key: inactiveKey,
        label: inactiveKey,
        group: 'Universal',
        criteria: 'x',
        rubric: null,
        rubricNsfw: null,
        sortOrder: 0,
        active: false,
      },
    ]);

    const plan = await resolveDailyPlan(dec1, withFlags(true, true));

    expect(plan.judgingCategories?.map((c) => [c.key, c.weight])).toEqual(setRows());
  });

  it('keeps the day on the default judge when the scheduled judge does not exist', async () => {
    mockDbRead.challengeJudge.findFirst.mockResolvedValue(null);

    const plan = await resolveDailyPlan(dec1, withFlags(true, true));

    expect(plan.judgeId).toBe(1);
    expect(plan.judgingConfig).toBe(defaultJudge);
    expect(plan.record?.judgeName).toBe('default');
    expect(plan.record?.setKey).toBe(entry.set);
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
