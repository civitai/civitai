// Time-to-pixel math for the Day and Week hour grids. A column is one local day; a band is the
// hours it shows. The default band runs past midnight, so a post at 1 AM renders at the foot of
// the previous day's column, which is where a late-night poster expects it.
import type { PlannerPost } from '../host';
import { addDays, dayStart, localDayKey, snapToFiveMinutes } from './calendar';

export const HOUR_HEIGHT_PX = 48;
/** Half an hour tall; posts closer than that share the row in side-by-side lanes. */
export const CHIP_HEIGHT_PX = HOUR_HEIGHT_PX / 2;

/** `endHour` may exceed 24: those hours belong to the next local day. */
export type HourBand = { startHour: number; endHour: number };

export const DEFAULT_BAND: HourBand = { startHour: 6, endHour: 26 };
export const ALL_HOURS_BAND: HourBand = { startHour: 0, endHour: 24 };

/**
 * The default band widened just enough that every post on the grid's days has a column: a
 * small-hours post the previous day's column cannot show pulls the start down, and the late rows
 * retreat by the same amount so no hour appears twice.
 */
export function fittedBand(posts: PlannerPost[], dayKeys: string[]): HourBand {
  const days = new Set(dayKeys);
  let startHour = DEFAULT_BAND.startHour;
  for (const post of posts) {
    const date = new Date(post.publishedAt);
    if (!days.has(localDayKey(date))) continue;
    const place = placeInBand(date, DEFAULT_BAND);
    if (place && days.has(place.dayKey)) continue;
    startHour = Math.min(startHour, date.getHours());
  }
  return { startHour, endHour: Math.min(DEFAULT_BAND.endHour, 24 + startHour) };
}

export function hourBand(allHours: boolean, posts: PlannerPost[], dayKeys: string[]): HourBand {
  return allHours ? ALL_HOURS_BAND : fittedBand(posts, dayKeys);
}

export type HourRow = { hour: number; label: string; top: number };

export function hourLabel(hour: number, locale?: string): string {
  return new Date(2000, 0, 1, hour % 24).toLocaleTimeString(locale, { hour: 'numeric' });
}

export function hourRows(band: HourBand, locale?: string): HourRow[] {
  const rows: HourRow[] = [];
  for (let hour = band.startHour; hour < band.endHour; hour++) {
    rows.push({
      hour,
      label: hourLabel(hour, locale),
      top: (hour - band.startHour) * HOUR_HEIGHT_PX,
    });
  }
  return rows;
}

export function bandHeight(band: HourBand): number {
  return (band.endHour - band.startHour) * HOUR_HEIGHT_PX;
}

/** The column `date` renders in and its minutes from that column's midnight, or `null` when the
 *  band hides it. */
export function placeInBand(
  date: Date,
  band: HourBand
): { dayKey: string; minutes: number } | null {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = band.startHour * 60;
  const end = band.endHour * 60;
  if (minutes >= start && minutes < Math.min(end, 1440)) {
    return { dayKey: localDayKey(date), minutes };
  }
  if (end > 1440 && minutes < end - 1440) {
    return { dayKey: addDays(localDayKey(date), -1), minutes: minutes + 1440 };
  }
  return null;
}

export function topOf(minutes: number, band: HourBand): number {
  return ((minutes - band.startHour * 60) / 60) * HOUR_HEIGHT_PX;
}

/** The instant under a pointer `offsetPx` from the top of `dayKey`'s column, snapped to five
 *  minutes and kept inside the band. */
export function timeAtOffset(dayKey: string, offsetPx: number, band: HourBand): Date {
  const start = band.startHour * 60;
  const last = band.endHour * 60 - 5;
  const raw = start + (offsetPx / HOUR_HEIGHT_PX) * 60;
  const minutes = Math.min(last, Math.max(start, Math.round(raw)));
  const at = dayStart(dayKey);
  at.setMinutes(minutes);
  return snapToFiveMinutes(at);
}

export type PlacedChip = { post: PlannerPost; top: number; lane: number; lanes: number };

/**
 * The chips of one column with their vertical position. Posts closer than a chip height share a
 * cluster and split its width into lanes, so a gap collision shows as chips side by side instead
 * of one hiding the other.
 */
export function layoutColumn(posts: PlannerPost[], dayKey: string, band: HourBand): PlacedChip[] {
  const placed = posts
    .flatMap((post) => {
      const place = placeInBand(new Date(post.publishedAt), band);
      return place && place.dayKey === dayKey ? [{ post, top: topOf(place.minutes, band) }] : [];
    })
    .sort((a, b) => a.top - b.top || a.post.id - b.post.id);

  const result: PlacedChip[] = [];
  let cluster: PlacedChip[] = [];
  let laneEnds: number[] = [];
  const flush = () => {
    for (const chip of cluster) chip.lanes = laneEnds.length;
    result.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const { post, top } of placed) {
    if (laneEnds.length && laneEnds.every((end) => end <= top)) flush();
    let lane = laneEnds.findIndex((end) => end <= top);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = top + CHIP_HEIGHT_PX;
    cluster.push({ post, top, lane, lanes: 0 });
  }
  flush();
  return result;
}

/** Posts on the grid's days that the band leaves out, which the "Show all hours" toggle reveals. */
export function countOutsideBand(posts: PlannerPost[], dayKeys: string[], band: HourBand): number {
  const days = new Set(dayKeys);
  return posts.filter((post) => {
    const date = new Date(post.publishedAt);
    if (!days.has(localDayKey(date))) return false;
    const place = placeInBand(date, band);
    return !place || !days.has(place.dayKey);
  }).length;
}
