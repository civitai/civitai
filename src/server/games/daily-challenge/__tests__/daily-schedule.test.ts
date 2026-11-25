import { describe, expect, it } from 'vitest';
import {
  DAILY_CHALLENGE_SCHEDULE,
  getDailyPlan,
  pickDailyRubricSet,
} from '~/server/games/daily-challenge/daily-schedule';
import { challengeJudgingCategoriesSchema } from '~/server/schema/challenge.schema';
import { DAILY_RUBRIC_SETS, dailyRubricSetRows } from '~/shared/constants/challenge.constants';
import dayjs from '~/shared/utils/dayjs';

const utc = (date: string) => dayjs.utc(date).toDate();

describe('DAILY_RUBRIC_SETS', () => {
  it.each(Object.keys(DAILY_RUBRIC_SETS) as (keyof typeof DAILY_RUBRIC_SETS)[])(
    '%s is a valid stored rubric',
    (setKey) => {
      expect(challengeJudgingCategoriesSchema.safeParse(dailyRubricSetRows(setKey)).success).toBe(
        true
      );
    }
  );
});

describe('pickDailyRubricSet', () => {
  const days = Array.from({ length: 400 }, (_, i) =>
    dayjs.utc('2027-01-01').add(i, 'day').toDate()
  );

  it('never gives two days running the same set', () => {
    const repeats = days
      .slice(1)
      .filter((day, i) => pickDailyRubricSet(day) === pickDailyRubricSet(days[i]));
    expect(repeats).toEqual([]);
  });

  it('gives comedy on Fridays and only Fridays', () => {
    const misplaced = days.filter(
      (day) => (pickDailyRubricSet(day) === 'comedy') !== (dayjs.utc(day).day() === 5)
    );
    expect(misplaced).toEqual([]);
  });
});

describe('getDailyPlan', () => {
  it('uses the schedule entry for a scheduled date', () => {
    const [date, entry] = Object.entries(DAILY_CHALLENGE_SCHEDULE)[0];
    expect(getDailyPlan(utc(date))).toEqual({
      source: 'schedule',
      setKey: entry.set,
      occasion: { name: entry.occasion, brief: entry.brief },
      judgeName: entry.judge,
    });
  });

  it('falls back to the rotation with the default judge off the schedule', () => {
    const date = utc('2027-01-05');
    expect(getDailyPlan(date)).toEqual({
      source: 'rotation',
      setKey: pickDailyRubricSet(date),
      judgeName: null,
    });
  });

  // docs/features/challenge-platform.md §3 Daily plan: comedy once a week.
  it('schedules comedy once in each December week', () => {
    const comedyByWeek = new Map<number, number>();
    for (const [date, entry] of Object.entries(DAILY_CHALLENGE_SCHEDULE)) {
      if (entry.set !== 'comedy') continue;
      // Monday-start weeks: 1970-01-01 was a Thursday.
      const week = Math.floor((dayjs.utc(date).valueOf() / 86_400_000 + 3) / 7);
      comedyByWeek.set(week, (comedyByWeek.get(week) ?? 0) + 1);
    }
    expect([...comedyByWeek.values()]).toEqual([1, 1, 1, 1, 1]);
  });
});
