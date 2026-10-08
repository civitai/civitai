import { describe, expect, it } from 'vitest';
import type { PlannerPost } from '../../host';
import {
  addMonths,
  bucketByLocalDay,
  countByUtcDay,
  defaultView,
  formatRangeLabel,
  monthGrid,
  moveToDay,
  snapToFiveMinutes,
  stepAnchor,
  visibleRange,
  weekDays,
  weekStart,
} from '../calendar';

const post = (iso: string, id = 1): PlannerPost => ({
  id,
  title: null,
  publishedAt: iso,
  modelVersionId: null,
  nsfwLevel: 1,
  imageCount: 1,
  cover: null,
  release: null,
});

describe('monthGrid', () => {
  it('starts on the Sunday before the 1st and marks the month and today', () => {
    const grid = monthGrid('2026-10-15', '2026-10-06');
    expect(grid).toHaveLength(42);
    expect(grid[0].key).toBe('2026-09-27');
    expect(grid[4]).toMatchObject({ key: '2026-10-01', day: 1, inMonth: true });
    expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
    expect(grid.find((d) => d.isToday)?.key).toBe('2026-10-06');
  });
});

describe('weekDays / weekStart', () => {
  it('is Sunday-first', () => {
    expect(weekStart('2026-10-08')).toBe('2026-10-04');
    expect(weekDays('2026-10-08', '2026-10-08').map((d) => d.day)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('addMonths', () => {
  it('clamps to the end of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-10-31', -1)).toBe('2026-09-30');
  });
});

describe('stepAnchor', () => {
  it('moves by the view size', () => {
    expect(stepAnchor('day', '2026-10-31', 1)).toBe('2026-11-01');
    expect(stepAnchor('week', '2026-10-08', -1)).toBe('2026-10-01');
    expect(stepAnchor('month', '2026-10-15', 1)).toBe('2026-11-01');
    expect(stepAnchor('agenda', '2026-10-01', 1)).toBe('2026-10-15');
  });
});

describe('visibleRange', () => {
  it('pads a day either side of the grid', () => {
    const { from, to } = visibleRange('month', '2026-10-15');
    expect(from).toEqual(new Date(2026, 8, 26));
    expect(to).toEqual(new Date(2026, 10, 9));
  });

  it('covers exactly the day plus padding for the day view', () => {
    const { from, to } = visibleRange('day', '2026-10-08');
    expect(from).toEqual(new Date(2026, 9, 7));
    expect(to).toEqual(new Date(2026, 9, 10));
  });
});

describe('bucketByLocalDay', () => {
  it('groups in local days and sorts within a day', () => {
    const late = new Date(2026, 9, 8, 23, 30).toISOString();
    const early = new Date(2026, 9, 8, 9, 5).toISOString();
    const next = new Date(2026, 9, 9, 0, 10).toISOString();
    const map = bucketByLocalDay([post(late, 1), post(next, 2), post(early, 3)]);
    expect([...map.keys()]).toEqual(['2026-10-08', '2026-10-09']);
    expect(map.get('2026-10-08')?.map((p) => p.id)).toEqual([3, 1]);
  });
});

describe('countByUtcDay', () => {
  it('counts on the UTC day even when the local day differs', () => {
    // 23:30 local on the 8th: in any zone east of UTC this is already the 9th in UTC, west of
    // UTC it is still the 8th; either way the UTC key differs from the local key for one of the two.
    const local = new Date(2026, 9, 8, 23, 30);
    const utc = new Date(Date.UTC(2026, 9, 8, 23, 30));
    const map = countByUtcDay([post(local.toISOString(), 1), post(utc.toISOString(), 2)]);
    expect(map.get('2026-10-08')).toBe(local.getTimezoneOffset() === 0 ? 2 : 1);
    expect([...map.values()].reduce((a, b) => a + b, 0)).toBe(2);
    expect(map.get(utc.toISOString().slice(0, 10))).toBeGreaterThanOrEqual(1);
  });
});

describe('moveToDay / snapToFiveMinutes', () => {
  it('keeps the time of day when moving', () => {
    const moved = moveToDay(new Date(2026, 9, 8, 21, 7), '2026-10-12');
    expect([moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([12, 21, 7]);
  });

  it('snaps down to five minutes and clears seconds, so 23:57 stays on its day', () => {
    const snapped = snapToFiveMinutes(new Date(2026, 9, 8, 21, 7, 42));
    expect([snapped.getMinutes(), snapped.getSeconds()]).toEqual([5, 0]);
    expect(snapToFiveMinutes(new Date(2026, 9, 8, 21, 10, 0)).getMinutes()).toBe(10);
    const late = snapToFiveMinutes(new Date(2026, 9, 8, 23, 57));
    expect([late.getDate(), late.getHours(), late.getMinutes()]).toEqual([8, 23, 55]);
  });
});

describe('defaultView', () => {
  const now = new Date(2026, 9, 6, 12);
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

  it('is month for a steady poster', () => {
    const posts = [7, 8, 9].flatMap((d) => [at(d, 9), at(d, 13), at(d, 17), at(d, 22)]).map(post);
    expect(defaultView(posts, now)).toBe('month');
  });

  it('is week for a burst poster', () => {
    const posts = [7, 8]
      .flatMap((d) => Array.from({ length: 8 }, (_, h) => at(d, 12 + h)))
      .map(post);
    expect(defaultView(posts, now)).toBe('week');
  });

  it('is week exactly at the density threshold', () => {
    const posts = [7, 8]
      .flatMap((d) => Array.from({ length: 6 }, (_, h) => at(d, 12 + h)))
      .map(post);
    expect(defaultView(posts, now)).toBe('week');
  });

  it('is agenda on a phone whatever the density', () => {
    expect(defaultView([post(at(7, 9))], now, { narrow: true })).toBe('agenda');
  });

  it('ignores published posts and is month when nothing is scheduled', () => {
    expect(defaultView([post(at(1, 9)), post(at(2, 9))], now)).toBe('month');
  });
});

describe('hostLink', () => {
  it('keeps relative links in-tab, opens http(s) in a new tab and drops other schemes', async () => {
    const { hostLink } = await import('../../host');
    expect(hostLink('/posts/1/edit')).toEqual({ href: '/posts/1/edit' });
    expect(hostLink('https://civitai.com/posts/1')).toEqual({
      href: 'https://civitai.com/posts/1',
      target: '_blank',
      rel: 'noreferrer',
    });
    expect(hostLink('//evil.example/x').href).toBe('#');
    expect(hostLink('javascript:alert(1)').href).toBe('#');
  });
});

describe('formatRangeLabel', () => {
  it('names the month and the week span', () => {
    expect(formatRangeLabel('month', '2026-10-15', 'en-US')).toBe('October 2026');
    expect(formatRangeLabel('week', '2026-10-08', 'en-US')).toBe('Oct 4 – 10, 2026');
  });
});

describe('shouldBlur', () => {
  it('never blurs PG media and always honours a per-item unblur', async () => {
    const { shouldBlur, PG_LEVEL } = await import('../../parts/media');
    expect(shouldBlur(PG_LEVEL, 1, false, false)).toBe(false);
    expect(shouldBlur(32, 1, false, true)).toBe(false);
  });

  it('blurs everything above PG while Show mature is off, and above the browsing level while on', async () => {
    const { shouldBlur } = await import('../../parts/media');
    expect(shouldBlur(4, 32, false, false)).toBe(true);
    expect(shouldBlur(4, 32, true, false)).toBe(false);
    expect(shouldBlur(32, 4, true, false)).toBe(true);
  });
});
