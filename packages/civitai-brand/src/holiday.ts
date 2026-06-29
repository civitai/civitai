/**
 * Pure date → holiday-theme logic, extracted from the original `Logo` component
 * so every framework computes the same active theme without importing React.
 */

import type { GradientKey } from './gradients';

/** Holiday themes that change the badge's gradient palette. */
export type Holiday = Extract<GradientKey, 'halloween' | 'christmas' | 'pride'>;

/** Thanksgiving (US) — the 4th Thursday of November — for the given year. */
export function getThanksgivingDate(year: number): Date {
  const november = new Date(year, 10, 1);
  const firstThursdayOffset = (4 - november.getDay() + 7) % 7; // 0 = Sunday … 4 = Thursday
  return new Date(year, 10, 1 + firstThursdayOffset + 7 * 3);
}

/**
 * Resolve the active holiday theme for a given date (defaults to now).
 *
 * Returns `null` when no decorated theme applies (including the New Year window,
 * which intentionally has no special styling).
 */
export function getHoliday(date: Date = new Date()): Holiday | null {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  const day = date.getDate();
  const thanksgivingDay = getThanksgivingDate(year).getDate();

  // Halloween — October
  if (month === 9) return 'halloween';

  // Christmas — Thanksgiving through Dec 25
  if ((month === 10 && day >= thanksgivingDay) || (month === 11 && day <= 25)) return 'christmas';

  // New Year — Dec 26+ (no decorated theme)
  if (month === 11 && day >= 26) return null;

  // Pride — June
  if (month === 5) return 'pride';

  return null;
}
