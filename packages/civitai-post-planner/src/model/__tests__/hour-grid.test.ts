import { describe, expect, it } from 'vitest';
import type { PlannerPost } from '../../host';
import {
  ALL_HOURS_BAND,
  bandHeight,
  CHIP_HEIGHT_PX,
  countOutsideBand,
  DEFAULT_BAND,
  fittedBand,
  HOUR_HEIGHT_PX,
  hourBand,
  hourRows,
  layoutColumn,
  placeInBand,
  timeAtOffset,
  topOf,
} from '../hour-grid';

const post = (date: Date, id = 1): PlannerPost => ({
  id,
  title: null,
  publishedAt: date.toISOString(),
  modelVersionId: null,
  nsfwLevel: 1,
  imageCount: 1,
  cover: null,
  release: null,
  model: null,
});

describe('hourRows / bandHeight', () => {
  it('runs 6 AM to 2 AM by default and midnight to midnight with every hour', () => {
    const rows = hourRows(DEFAULT_BAND, 'en-US');
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual({ hour: 6, label: '6 AM', top: 0 });
    expect(rows[18]).toEqual({ hour: 24, label: '12 AM', top: 18 * HOUR_HEIGHT_PX });
    expect(rows[19].label).toBe('1 AM');
    expect(bandHeight(DEFAULT_BAND)).toBe(20 * HOUR_HEIGHT_PX);
    expect(hourRows(ALL_HOURS_BAND, 'en-US').map((r) => r.hour)).toEqual(
      Array.from({ length: 24 }, (_, i) => i)
    );
    expect(hourBand(true, [], ['2026-10-10'])).toBe(ALL_HOURS_BAND);
    expect(hourBand(false, [], ['2026-10-10'])).toEqual(DEFAULT_BAND);
  });
});

describe('fittedBand', () => {
  it('stays at the default when every post on the grid days already has a column', () => {
    const posts = [post(new Date(2026, 9, 10, 9, 0), 1), post(new Date(2026, 9, 11, 1, 30), 2)];
    expect(fittedBand(posts, ['2026-10-10', '2026-10-11'])).toEqual(DEFAULT_BAND);
  });

  it('opens early enough for a 3 AM post without changing the hour range by hand', () => {
    const band = fittedBand([post(new Date(2026, 9, 10, 3, 0), 1)], ['2026-10-10']);
    expect(band).toEqual({ startHour: 3, endHour: 26 });
    expect(placeInBand(new Date(2026, 9, 10, 3, 0), band)).toEqual({
      dayKey: '2026-10-10',
      minutes: 180,
    });
    expect(countOutsideBand([post(new Date(2026, 9, 10, 3, 0), 1)], ['2026-10-10'], band)).toBe(0);
  });

  it('gives a 1 AM post on the first grid day its own column and drops the duplicate late rows', () => {
    const early = post(new Date(2026, 9, 10, 1, 10), 1);
    const band = fittedBand([early], ['2026-10-10']);
    expect(band).toEqual({ startHour: 1, endHour: 25 });
    expect(hourRows(band).map((r) => r.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(layoutColumn([early], '2026-10-10', band)).toHaveLength(1);
  });

  it('ignores posts outside the grid days', () => {
    expect(fittedBand([post(new Date(2026, 9, 20, 3, 0), 1)], ['2026-10-10'])).toEqual(
      DEFAULT_BAND
    );
  });
});

describe('placeInBand / topOf', () => {
  it('keeps a daytime post on its own day', () => {
    const place = placeInBand(new Date(2026, 9, 10, 15, 5), DEFAULT_BAND);
    expect(place).toEqual({ dayKey: '2026-10-10', minutes: 15 * 60 + 5 });
    expect(topOf(place!.minutes, DEFAULT_BAND)).toBe((9 + 5 / 60) * HOUR_HEIGHT_PX);
  });

  it('puts 1:30 AM at the foot of the previous day and hides 3 AM', () => {
    expect(placeInBand(new Date(2026, 9, 11, 1, 30), DEFAULT_BAND)).toEqual({
      dayKey: '2026-10-10',
      minutes: 1440 + 90,
    });
    expect(placeInBand(new Date(2026, 9, 11, 3, 0), DEFAULT_BAND)).toBeNull();
    expect(placeInBand(new Date(2026, 9, 11, 3, 0), ALL_HOURS_BAND)).toEqual({
      dayKey: '2026-10-11',
      minutes: 180,
    });
  });
});

describe('timeAtOffset', () => {
  it('maps pixels to a five-minute mark, rounding down', () => {
    const at = timeAtOffset('2026-10-10', 2 * HOUR_HEIGHT_PX + 23, DEFAULT_BAND);
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([10, 8, 25]);
  });

  it('clamps to the band and crosses midnight for the late hours', () => {
    const early = timeAtOffset('2026-10-10', -40, DEFAULT_BAND);
    expect([early.getHours(), early.getMinutes()]).toEqual([6, 0]);
    const late = timeAtOffset('2026-10-10', 10_000, DEFAULT_BAND);
    expect([late.getDate(), late.getHours(), late.getMinutes()]).toEqual([11, 1, 55]);
  });
});

describe('layoutColumn', () => {
  const at = (hour: number, minute: number, id: number) =>
    post(new Date(2026, 9, 10, hour, minute), id);

  it('positions chips by time and lanes only the ones that collide', () => {
    const chips = layoutColumn(
      [at(10, 5, 1), at(10, 15, 2), at(12, 5, 3), at(1, 10, 4), at(3, 0, 5)],
      '2026-10-10',
      DEFAULT_BAND
    );
    expect(chips.map((c) => c.post.id)).toEqual([1, 2, 3]);
    expect(chips[0]).toMatchObject({ lane: 0, lanes: 2, top: topOf(605, DEFAULT_BAND) });
    expect(chips[1]).toMatchObject({ lane: 1, lanes: 2 });
    expect(chips[2]).toMatchObject({ lane: 0, lanes: 1 });
    expect(chips[1].top - chips[0].top).toBeLessThan(CHIP_HEIGHT_PX);
  });

  it("shows the next day's small hours at the foot of this column", () => {
    const chips = layoutColumn([post(new Date(2026, 9, 11, 1, 10), 4)], '2026-10-10', DEFAULT_BAND);
    expect(chips).toHaveLength(1);
    expect(chips[0].top).toBe(topOf(1440 + 70, DEFAULT_BAND));
    expect(
      layoutColumn([post(new Date(2026, 9, 11, 1, 10), 4)], '2026-10-11', DEFAULT_BAND)
    ).toEqual([]);
  });
});

describe('countOutsideBand', () => {
  it('counts posts on the grid days the band hides, and none once every hour shows', () => {
    const posts = [
      post(new Date(2026, 9, 10, 3, 0), 1),
      post(new Date(2026, 9, 10, 1, 0), 2),
      post(new Date(2026, 9, 11, 1, 0), 3),
      post(new Date(2026, 9, 10, 9, 0), 4),
      post(new Date(2026, 9, 20, 3, 0), 5),
    ];
    expect(countOutsideBand(posts, ['2026-10-10'], DEFAULT_BAND)).toBe(2);
    expect(countOutsideBand(posts, ['2026-10-10', '2026-10-11'], DEFAULT_BAND)).toBe(2);
    expect(countOutsideBand(posts, ['2026-10-10', '2026-10-11'], ALL_HOURS_BAND)).toBe(0);
  });
});
