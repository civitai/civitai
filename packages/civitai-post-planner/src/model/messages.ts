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
