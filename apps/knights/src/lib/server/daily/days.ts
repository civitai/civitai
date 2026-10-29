const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A UTC calendar day as `YYYY-MM-DD`. Strings keep days away from the host timezone and the driver's date parsing. */
export type Day = string;

export const utcDay = (instant: Date): Day => instant.toISOString().slice(0, 10);

export const dayStart = (day: Day): Date => new Date(`${day}T00:00:00.000Z`);

export const addDays = (day: Day, days: number): Day =>
  utcDay(new Date(dayStart(day).getTime() + days * DAY_MS));

export const nextDayStart = (day: Day): Date => dayStart(addDays(day, 1));

export const daysBetween = (from: Day, to: Day): number =>
  Math.round((dayStart(to).getTime() - dayStart(from).getTime()) / DAY_MS);

/** The Monday of the day's ISO week. */
export const isoWeekStart = (day: Day): Day => addDays(day, -((dayStart(day).getUTCDay() + 6) % 7));

export function dayLabel(day: Day, today: Day): string {
  if (day === addDays(today, -1)) return 'yesterday';
  const start = dayStart(day);
  return `on ${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}`;
}
