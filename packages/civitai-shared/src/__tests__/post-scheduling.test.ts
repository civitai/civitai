import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  applyJitter,
  generateEverySchedule,
  generateSpreadSchedule,
  getPostScheduleError,
  getPostScheduleScope,
  POST_BATCH_MIN_EVERY_MINUTES,
  POST_BATCH_MIN_GAP_MINUTES,
  POST_BATCH_MIN_SPREAD_SLOT_MINUTES,
  POST_MAXIMUM_SCHEDULE_MONTHS,
  POST_MINIMUM_SCHEDULE_MINUTES,
  POST_SCHEDULE_JITTER_MAX_MINUTES,
  scheduleWindow,
  seededRng,
  utcDayKey,
  validateBatchSchedule,
} from '../post-scheduling';

const now = new Date('2026-10-06T12:00:00Z');
const inMinutes = (m: number, from = now) => new Date(from.getTime() + m * 60_000);
const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

const fixed = (value: number) => () => value;

describe('addMonthsClamped', () => {
  it('clamps to the end of a shorter target month, like dayjs', () => {
    // Local-time construction on purpose: the helper mirrors increaseDate, which is local too.
    const nov30 = new Date(2026, 10, 30, 12, 0, 0);
    const result = addMonthsClamped(nov30, 3);
    expect([result.getFullYear(), result.getMonth(), result.getDate(), result.getHours()]).toEqual([
      2027, 1, 28, 12,
    ]);
  });

  it('keeps the day when the target month has it', () => {
    const result = addMonthsClamped(new Date(2026, 0, 15, 9, 30), 3);
    expect([result.getMonth(), result.getDate(), result.getHours(), result.getMinutes()]).toEqual([
      3, 15, 9, 30,
    ]);
  });
});

describe('scheduleWindow', () => {
  it('spans the minimum lead to the maximum months', () => {
    const { min, max } = scheduleWindow(now);
    expect(min).toEqual(inMinutes(POST_MINIMUM_SCHEDULE_MINUTES));
    expect(max).toEqual(addMonthsClamped(now, POST_MAXIMUM_SCHEDULE_MONTHS));
  });
});

describe('utcDayKey', () => {
  it('is the UTC calendar date, not the local one', () => {
    expect(utcDayKey(new Date('2026-10-06T23:59:00Z'))).toBe('2026-10-06');
    expect(utcDayKey(new Date('2026-10-07T00:01:00Z'))).toBe('2026-10-07');
  });
});

describe('getPostScheduleError', () => {
  const scheduled = { publishedAt: inMinutes(60 * 24) };

  it('allows moving a scheduled post inside the window', () => {
    expect(getPostScheduleError(scheduled, inMinutes(60 * 48), now)).toBeNull();
    expect(getPostScheduleError(scheduled, inMinutes(10), now)).toBeNull();
  });

  it('allows publishing a scheduled post now', () => {
    expect(getPostScheduleError(scheduled, 'now', now)).toBeNull();
  });

  it('refuses posts that are not scheduled, either way', () => {
    for (const target of [inMinutes(60), 'now'] as const) {
      expect(getPostScheduleError({ publishedAt: null }, target, now)).toMatch(/Only scheduled/);
      expect(getPostScheduleError({ publishedAt: inMinutes(-1) }, target, now)).toMatch(
        /Only scheduled/
      );
    }
  });

  it('refuses dates outside the scheduling window instead of publishing now', () => {
    expect(getPostScheduleError(scheduled, inMinutes(9), now)).toMatch(/at least 10 minutes/);
    expect(getPostScheduleError(scheduled, inMinutes(-60), now)).toMatch(/at least 10 minutes/);
    const cap = addMonthsClamped(now, POST_MAXIMUM_SCHEDULE_MONTHS);
    expect(getPostScheduleError(scheduled, cap, now)).toBeNull();
    expect(getPostScheduleError(scheduled, new Date(cap.getTime() + 1), now)).toMatch(
      /more than 3 months/
    );
  });
});

describe('getPostScheduleScope', () => {
  const onVersion = (
    versionStatus: 'Scheduled' | 'Published' | 'Draft',
    modelStatus: 'Scheduled' | 'Published' | 'Draft',
    modelOwner = 7
  ) => ({
    userId: 7,
    modelVersion: { status: versionStatus, model: { userId: modelOwner, status: modelStatus } },
  });

  it('is the post itself when it has no version', () => {
    expect(getPostScheduleScope({ userId: 7, modelVersion: null })).toBe('post');
  });

  it('is the post itself when its version is not waiting on a release', () => {
    expect(getPostScheduleScope(onVersion('Published', 'Published'))).toBe('post');
    expect(getPostScheduleScope(onVersion('Draft', 'Draft'))).toBe('post');
  });

  it('is the version when the model is already live', () => {
    expect(getPostScheduleScope(onVersion('Scheduled', 'Published'))).toBe('version');
  });

  it('is the whole model when the model has not gone live', () => {
    expect(getPostScheduleScope(onVersion('Scheduled', 'Scheduled'))).toBe('model');
  });

  it('is the post itself when the release belongs to someone else', () => {
    expect(getPostScheduleScope(onVersion('Scheduled', 'Scheduled', 99))).toBe('post');
  });
});

describe('seededRng', () => {
  it('is deterministic for a seed and stays in [0, 1)', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const values = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(values);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(values).size).toBeGreaterThan(40);
  });
});

describe('applyJitter', () => {
  it('never lands on the hour, for every base minute and every rng value', () => {
    for (let minute = 0; minute < 60; minute++) {
      const base = new Date(Date.UTC(2026, 9, 6, 12, minute, 17));
      for (const value of [0, 0.5, 0.999]) {
        const moved = applyJitter(base, fixed(value));
        expect(moved.getUTCMinutes()).not.toBe(0);
        expect(moved.getUTCSeconds()).toBe(0);
        const delta = minutesBetween(base, moved);
        // 1..9 from the rng; the :00 nudge adds one more.
        expect(delta).toBeGreaterThanOrEqual(1 - 17 / 60);
        expect(delta).toBeLessThanOrEqual(POST_SCHEDULE_JITTER_MAX_MINUTES + 1);
      }
    }
  });

  it('nudges a result that would land on :00 forward by one minute', () => {
    const base = new Date(Date.UTC(2026, 9, 6, 12, 59, 0));
    expect(applyJitter(base, fixed(0)).getUTCMinutes()).toBe(1);
  });
});

describe('generateEverySchedule', () => {
  const start = new Date('2026-10-07T15:00:00Z');

  it('produces count dates, in order, spaced by the interval plus or minus the jitter', () => {
    const result = generateEverySchedule({
      start,
      everyMinutes: 240,
      count: 30,
      rng: seededRng(1),
    });
    if (!result.ok) throw new Error(result.issue);
    expect(result.dates).toHaveLength(30);
    expect(result.dates[0].getTime()).toBeGreaterThanOrEqual(start.getTime());
    for (let i = 1; i < result.dates.length; i++) {
      const spacing = minutesBetween(result.dates[i - 1], result.dates[i]);
      expect(spacing).toBeGreaterThanOrEqual(240 - POST_SCHEDULE_JITTER_MAX_MINUTES);
      expect(spacing).toBeLessThanOrEqual(240 + POST_SCHEDULE_JITTER_MAX_MINUTES + 1);
    }
    for (const date of result.dates) expect(date.getUTCMinutes()).not.toBe(0);
  });

  it('is reproducible from the seed', () => {
    const a = generateEverySchedule({ start, everyMinutes: 60, count: 5, rng: seededRng(9) });
    const b = generateEverySchedule({ start, everyMinutes: 60, count: 5, rng: seededRng(9) });
    expect(a).toEqual(b);
  });

  it('keeps the gap even at the minimum interval', () => {
    const result = generateEverySchedule({
      start,
      everyMinutes: POST_BATCH_MIN_EVERY_MINUTES,
      count: 200,
      rng: seededRng(3),
    });
    if (!result.ok) throw new Error(result.issue);
    for (let i = 1; i < result.dates.length; i++)
      expect(minutesBetween(result.dates[i - 1], result.dates[i])).toBeGreaterThanOrEqual(
        POST_BATCH_MIN_GAP_MINUTES
      );
  });

  it('refuses an interval the jitter could collapse below the gap', () => {
    const result = generateEverySchedule({ start, everyMinutes: 45, count: 3, rng: seededRng(1) });
    expect(result).toEqual({ ok: false, issue: expect.stringMatching(/at least 1 hour/) });
  });

  it('refuses an empty batch', () => {
    expect(generateEverySchedule({ start, everyMinutes: 60, count: 0, rng: seededRng(1) }).ok).toBe(
      false
    );
  });
});

describe('generateSpreadSchedule', () => {
  const from = new Date('2026-10-07T15:00:00Z');
  const to = new Date('2026-11-06T15:00:00Z');

  it('starts on from, never passes to, and spaces posts evenly', () => {
    const result = generateSpreadSchedule({ from, to, count: 200, rng: seededRng(5) });
    if (!result.ok) throw new Error(result.issue);
    expect(result.dates).toHaveLength(200);
    expect(minutesBetween(from, result.dates[0])).toBeLessThanOrEqual(
      POST_SCHEDULE_JITTER_MAX_MINUTES + 1
    );
    expect(result.dates[199].getTime()).toBeLessThanOrEqual(to.getTime());
    const expectedSlot = minutesBetween(from, to) / 199;
    for (let i = 1; i < result.dates.length; i++) {
      const spacing = minutesBetween(result.dates[i - 1], result.dates[i]);
      expect(Math.abs(spacing - expectedSlot)).toBeLessThanOrEqual(
        POST_SCHEDULE_JITTER_MAX_MINUTES + 2
      );
      expect(spacing).toBeGreaterThanOrEqual(POST_BATCH_MIN_GAP_MINUTES);
    }
  });

  it('refuses a range too tight for the count', () => {
    const tight = inMinutes((POST_BATCH_MIN_SPREAD_SLOT_MINUTES - 1) * 9, from);
    const result = generateSpreadSchedule({ from, to: tight, count: 10, rng: seededRng(1) });
    expect(result).toEqual({ ok: false, issue: expect.stringMatching(/don't fit/) });
  });

  it('refuses an inverted or empty range', () => {
    expect(generateSpreadSchedule({ from, to: from, count: 2, rng: seededRng(1) }).ok).toBe(false);
    expect(
      generateSpreadSchedule({ from, to: inMinutes(-60, from), count: 2, rng: seededRng(1) }).ok
    ).toBe(false);
  });

  it('places a single post at the start', () => {
    const result = generateSpreadSchedule({ from, to, count: 1, rng: fixed(0) });
    if (!result.ok) throw new Error(result.issue);
    expect(result.dates).toEqual([inMinutes(1, from)]);
  });
});

describe('validateBatchSchedule', () => {
  const base = { now, existingPublishedAts: [] as Date[], dailyLimit: 6 };
  // Off the hour so only the rule under test fires.
  const at = (iso: string) => new Date(iso);

  it('passes a well-formed batch and reports its days', () => {
    const result = validateBatchSchedule({
      ...base,
      publishedAts: [
        at('2026-10-07T15:07:00Z'),
        at('2026-10-07T19:04:00Z'),
        at('2026-10-08T01:09:00Z'),
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.perDay).toEqual([
      { day: '2026-10-07', existing: 0, incoming: 2 },
      { day: '2026-10-08', existing: 0, incoming: 1 },
    ]);
  });

  it('refuses an empty batch and one over the batch size', () => {
    expect(validateBatchSchedule({ ...base, publishedAts: [] }).issues).toEqual([
      expect.objectContaining({ code: 'shape' }),
    ]);
    const many = Array.from({ length: 3 }, (_, i) => at(`2026-10-0${7 + i}T15:07:00Z`));
    expect(
      validateBatchSchedule({ ...base, publishedAts: many, maxPosts: 2 }).issues.map((i) => i.code)
    ).toEqual(['shape']);
  });

  it('refuses a post inside the minimum lead and one past the maximum window', () => {
    const cap = addMonthsClamped(now, POST_MAXIMUM_SCHEDULE_MONTHS);
    const result = validateBatchSchedule({
      ...base,
      publishedAts: [inMinutes(9), inMinutes(1, cap)],
    });
    expect(result.issues.map((i) => [i.code, i.index])).toEqual([
      ['lead', 0],
      ['window', 1],
    ]);
  });

  it('refuses a post exactly on the hour', () => {
    const result = validateBatchSchedule({ ...base, publishedAts: [at('2026-10-07T15:00:00Z')] });
    expect(result.issues).toEqual([expect.objectContaining({ code: 'onTheHour', index: 0 })]);
  });

  it('enforces the gap between incoming posts, reporting the later one', () => {
    const result = validateBatchSchedule({
      ...base,
      publishedAts: [at('2026-10-07T15:07:00Z'), at('2026-10-07T15:36:00Z')],
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'gap',
        index: 1,
        message: expect.stringMatching(/29 minutes/),
      }),
    ]);
    const okResult = validateBatchSchedule({
      ...base,
      publishedAts: [at('2026-10-07T15:07:00Z'), at('2026-10-07T15:37:00Z')],
    });
    expect(okResult.ok).toBe(true);
  });

  it('enforces the gap against posts the creator already has scheduled', () => {
    const existing = at('2026-10-07T15:07:00Z');
    const tooClose = validateBatchSchedule({
      ...base,
      existingPublishedAts: [existing],
      publishedAts: [inMinutes(29, existing)],
    });
    expect(tooClose.issues).toEqual([
      expect.objectContaining({
        code: 'gap',
        index: 0,
        message: expect.stringMatching(/already have/),
      }),
    ]);
    const farEnough = validateBatchSchedule({
      ...base,
      existingPublishedAts: [existing],
      publishedAts: [inMinutes(30, existing)],
    });
    expect(farEnough.ok).toBe(true);
  });

  it('ignores two existing posts that are close to each other', () => {
    const result = validateBatchSchedule({
      ...base,
      existingPublishedAts: [at('2026-10-07T15:07:00Z'), at('2026-10-07T15:10:00Z')],
      publishedAts: [at('2026-10-08T15:07:00Z')],
    });
    expect(result.ok).toBe(true);
  });

  it('counts the cap per UTC day, existing posts included', () => {
    const existing = Array.from({ length: 5 }, (_, i) => at(`2026-10-07T0${i}:07:00Z`));
    const result = validateBatchSchedule({
      ...base,
      existingPublishedAts: existing,
      publishedAts: [at('2026-10-07T12:07:00Z'), at('2026-10-07T13:07:00Z')],
    });
    expect(result.perDay).toEqual([{ day: '2026-10-07', existing: 5, incoming: 2 }]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'cap',
        day: '2026-10-07',
        message: expect.stringMatching(/7 posts/),
      }),
    ]);
  });

  it('treats the UTC midnight boundary as two days', () => {
    const result = validateBatchSchedule({
      ...base,
      dailyLimit: 1,
      publishedAts: [at('2026-10-07T23:55:00Z'), at('2026-10-08T00:35:00Z')],
    });
    expect(result.ok).toBe(true);
    expect(result.perDay.map((d) => d.day)).toEqual(['2026-10-07', '2026-10-08']);
  });
});
