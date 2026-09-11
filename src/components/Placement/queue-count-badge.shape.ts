/**
 * What a queue count should look like as a badge — the label, and whether it fits a disc.
 *
 * Pure and separate from the component because the failure mode is invisible to a render test
 * that only ever passes it a single digit: `circle` is `width: var(--badge-height)` with 2px of
 * inline padding, so at size `sm` there are 14px for the text and a two-digit count is clipped to
 * "7…". Every queue this badge draws was single-digit until one wasn't.
 */
export type QueueCountBadgeShape = { label: string; circle: boolean } | null;

export function queueCountBadgeShape(
  count: number,
  { truncated = false, max }: { truncated?: boolean; max?: number } = {}
): QueueCountBadgeShape {
  // A zero reads as a broken badge rather than an empty queue, and these surfaces exist to send
  // someone to go and look at something.
  if (!count) return null;

  const capped = max !== undefined && count > max;
  const label = capped ? `${max}+` : truncated ? `${count}+` : `${count}`;

  return { label, circle: label.length === 1 };
}
