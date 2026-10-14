export type TriageKeyAction = 'next' | 'previous' | 'uphold' | 'overturn';

export type TriageKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Focus is in a field the key would type into. */
  typing: boolean;
  /** Uphold is only meaningful while a flag is in force. */
  canUphold: boolean;
};

export const triageKeyAction = (e: TriageKeyEvent): TriageKeyAction | null => {
  if (e.typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'K':
    case 'ArrowUp':
      return 'previous';
    case 'u':
    case 'U':
      return e.canUphold ? 'uphold' : null;
    case 'o':
    case 'O':
      return 'overturn';
    default:
      return null;
  }
};

export const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
    null;

/** One step through the queue, clamped at both ends. */
export function step(ids: readonly number[], current: number | null, direction: 1 | -1) {
  if (!ids.length) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, at + direction))];
}

/** The next appeal still waiting on a decision: forward from `current` first, then back. */
export function nextUndecided(
  ids: readonly number[],
  current: number | null,
  isDecided: (id: number) => boolean
): number | null {
  const at = current === null ? -1 : ids.indexOf(current);
  for (let i = at + 1; i < ids.length; i++) if (!isDecided(ids[i])) return ids[i];
  for (let i = Math.min(at, ids.length) - 1; i >= 0; i--) if (!isDecided(ids[i])) return ids[i];
  return null;
}

/** A form action URL that keeps the page's query, so a no-JS submit lands back on the same filters. */
export function formActionHref(action: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  const rest = query.toString();
  return rest ? `?/${action}&${rest}` : `?/${action}`;
}
