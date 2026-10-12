// The user-facing strings that are built from data: toast copy, labels and error fallbacks.

export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function shiftLabel(deltaMinutes: number): string {
  const days = deltaMinutes / 1440;
  return Number.isInteger(days)
    ? `${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}`
    : `${deltaMinutes > 0 ? '+' : ''}${deltaMinutes} min`;
}

export function unscheduledMessage(result: {
  unscheduledIds: number[];
  skippedReleaseIds: number[];
}): string {
  const skipped = result.skippedReleaseIds.length;
  return (
    `${plural(result.unscheduledIds.length, 'post')} moved to drafts.` +
    (skipped ? ` ${plural(skipped, 'release post')} not moved — they move with their model.` : '')
  );
}

export function shiftedMessage(
  result: { moved: { id: number }[]; skippedReleaseIds: number[] },
  deltaMinutes: number
): string {
  const skipped = result.skippedReleaseIds.length;
  return (
    `${plural(result.moved.length, 'post')} shifted by ${shiftLabel(deltaMinutes)}.` +
    (skipped ? ` ${plural(skipped, 'release post')} not moved.` : '')
  );
}

export function releaseScopeLabel(scope: 'model' | 'version'): string {
  return scope === 'model' ? 'the whole model release' : "this version's release";
}

/** `Oct 7–9`, `Oct 7 – Nov 2`, or `Oct 7` when both ends share a day. */
export function spanLabel([from, to]: [Date, Date], locale?: string): string {
  const day = (date: Date) => date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  if (from.toDateString() === to.toDateString()) return day(from);
  return from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear()
    ? `${day(from)}–${to.getDate()}`
    : `${day(from)} – ${day(to)}`;
}

export function previewLine(
  preview: { from: [Date, Date] | null; to: [Date, Date] | null; issues: string[] },
  locale?: string
): string {
  if (!preview.from || !preview.to) return 'Nothing to move.';
  return `${spanLabel(preview.from, locale)} → ${spanLabel(preview.to, locale)} · ${plural(
    preview.issues.length,
    'conflict'
  )}`;
}

export function movedToDayMessage(
  moved: number,
  failed: string[],
  dayKey: string,
  locale?: string
): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const label = new Date(year, month - 1, day).toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const head = `${plural(moved, 'post')} moved to ${label}.`;
  return failed.length ? `${head} ${plural(failed.length, 'post')} not moved: ${failed[0]}` : head;
}
