// Pure date helpers for the planner. Days are the VIEWER's local days (posts are scheduled in local
// time and read in local time); the publish sweep's UTC day only matters for the cap badge, which is
// labelled as such. Keys are `YYYY-MM-DD` strings so they survive serialisation and map lookups.
import type { PlannerPost, PlannerView } from '../host.js';

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Local midnight of a `YYYY-MM-DD` key. */
export function dayStart(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(key: string, delta: number): string {
  const d = dayStart(key);
  d.setDate(d.getDate() + delta);
  return localDayKey(d);
}

export function addMonths(key: string, delta: number): string {
  const d = dayStart(key);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return localDayKey(d);
}

/** Sunday-first week containing `key`. */
export function weekStart(key: string): string {
  const d = dayStart(key);
  return addDays(key, -d.getDay());
}

export function monthStart(key: string): string {
  return key.slice(0, 8) + '01';
}

export type CalendarDay = { key: string; day: number; inMonth: boolean; isToday: boolean };

/** Six Sunday-first weeks covering the month that holds `anchor`. */
export function monthGrid(anchor: string, today: string): CalendarDay[] {
  const first = monthStart(anchor);
  const month = dayStart(first).getMonth();
  const start = weekStart(first);
  return Array.from({ length: 42 }, (_, i) => {
    const key = addDays(start, i);
    const d = dayStart(key);
    return { key, day: d.getDate(), inMonth: d.getMonth() === month, isToday: key === today };
  });
}

/** Sunday-first week holding `anchor`. */
export function weekDays(anchor: string, today: string): CalendarDay[] {
  const start = weekStart(anchor);
  return Array.from({ length: 7 }, (_, i) => {
    const key = addDays(start, i);
    return { key, day: dayStart(key).getDate(), inMonth: true, isToday: key === today };
  });
}

/**
 * The instants a view needs, padded a day either side so a post that sits near midnight in the
 * viewer's zone is never missing from its local day. Agenda loads a rolling six weeks.
 */
export function visibleRange(view: PlannerView, anchor: string): { from: Date; to: Date } {
  let first: string;
  let days: number;
  switch (view) {
    case 'day':
      first = anchor;
      days = 1;
      break;
    case 'week':
      first = weekStart(anchor);
      days = 7;
      break;
    case 'month':
      first = weekStart(monthStart(anchor));
      days = 42;
      break;
    case 'agenda':
      first = anchor;
      days = 42;
      break;
  }
  return {
    from: new Date(dayStart(first).getTime() - DAY_MS),
    to: new Date(dayStart(first).getTime() + (days + 1) * DAY_MS),
  };
}

export function stepAnchor(view: PlannerView, anchor: string, delta: 1 | -1): string {
  switch (view) {
    case 'day':
      return addDays(anchor, delta);
    case 'week':
      return addDays(anchor, 7 * delta);
    case 'month':
      return addMonths(monthStart(anchor), delta);
    case 'agenda':
      return addDays(anchor, 14 * delta);
  }
}

export function bucketByLocalDay(posts: PlannerPost[]): Map<string, PlannerPost[]> {
  const map = new Map<string, PlannerPost[]>();
  const sorted = [...posts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  for (const post of sorted) {
    const key = localDayKey(new Date(post.publishedAt));
    const bucket = map.get(key);
    if (bucket) bucket.push(post);
    else map.set(key, [post]);
  }
  return map;
}

/** Posts per UTC day, which is what the server's daily cap counts. */
export function countByUtcDay(posts: PlannerPost[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const post of posts) {
    const key = utcDayKey(new Date(post.publishedAt));
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** `date` moved onto local day `dayKey`, keeping its local time of day. */
export function moveToDay(date: Date, dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  const moved = new Date(date);
  moved.setFullYear(year, month - 1, day);
  return moved;
}

/** Floors `date` to the nearest five-minute mark, seconds cleared. */
export function snapToFiveMinutes(date: Date): Date {
  const snapped = new Date(date);
  snapped.setSeconds(0, 0);
  snapped.setMinutes(snapped.getMinutes() - (snapped.getMinutes() % 5));
  return snapped;
}

export const DENSE_POSTS_PER_DAY = 6;

/**
 * The view a creator lands on when they have not chosen one: Agenda on a phone, otherwise Week when
 * the loaded range averages `DENSE_POSTS_PER_DAY` or more scheduled posts per day with posts and
 * Month otherwise. A burst scheduler's month is a wall; a steady four-a-day poster's month is fine.
 */
export function defaultView(
  posts: PlannerPost[],
  now: Date,
  opts: { narrow?: boolean } = {}
): Exclude<PlannerView, 'day'> {
  if (opts.narrow) return 'agenda';
  const future = posts.filter((p) => new Date(p.publishedAt) > now);
  if (future.length === 0) return 'month';
  const days = new Set(future.map((p) => localDayKey(new Date(p.publishedAt)))).size;
  return future.length / days >= DENSE_POSTS_PER_DAY ? 'week' : 'month';
}

export function formatTime(date: Date, locale?: string): string {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(date: Date, locale?: string): string {
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatRangeLabel(view: PlannerView, anchor: string, locale?: string): string {
  const start = dayStart(anchor);
  switch (view) {
    case 'month':
      return start.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
    case 'day':
      return start.toLocaleDateString(locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
    case 'week': {
      const first = dayStart(weekStart(anchor));
      const last = dayStart(addDays(weekStart(anchor), 6));
      const sameMonth = first.getMonth() === last.getMonth();
      const a = first.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
      const b = sameMonth
        ? `${last.getDate()}, ${last.getFullYear()}`
        : last.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
      return `${a} – ${b}`;
    }
    case 'agenda':
      return `From ${start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`;
  }
}
