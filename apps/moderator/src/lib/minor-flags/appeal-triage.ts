export type TriageKeyAction = 'next' | 'previous' | 'uphold' | 'overturn';

export type TriageKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  typing: boolean;
  canUphold: boolean;
  /** Defaults to true: an appeal can always be overturned, a re-detection with an open appeal cannot. */
  canOverturn?: boolean;
};

export const triageKeyAction = (e: TriageKeyEvent): TriageKeyAction | null => {
  if (e.typing || e.defaultPrevented || e.isComposing) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'j':
    case 'J':
      return 'next';
    case 'k':
    case 'K':
      return 'previous';
    case '1':
      return e.canUphold ? 'uphold' : null;
    case '2':
      return e.canOverturn === false ? null : 'overturn';
    default:
      return null;
  }
};

export const TYPING_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="combobox"]',
].join(', ');

/** Focus is somewhere a key means something else: a field, or an open dialog, menu or list. */
export const isTypingTarget = (target: { closest?: (selector: string) => unknown } | null) =>
  !!target?.closest?.(TYPING_SELECTOR);

type ActionResultLike = { type: string; data?: Record<string, unknown> };

/** The message to show against an appeal whose action did not succeed, or null. */
export function failureMessage(result: ActionResultLike): string | null {
  if (result.type === 'success') return null;
  const error = result.type === 'failure' ? result.data?.error : null;
  return typeof error === 'string' ? error : 'Action failed.';
}

/** One step through the queue, clamped at both ends. */
export function step<K extends string | number>(
  ids: readonly K[],
  current: K | null,
  direction: 1 | -1
) {
  if (!ids.length) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, at + direction))];
}

/** The next appeal still waiting on a decision: forward from `current` first, then back. */
export function nextUndecided<K extends string | number>(
  ids: readonly K[],
  current: K | null,
  isDecided: (id: K) => boolean
): K | null {
  const at = current === null ? -1 : ids.indexOf(current);
  for (let i = at + 1; i < ids.length; i++) if (!isDecided(ids[i])) return ids[i];
  for (let i = Math.min(at, ids.length) - 1; i >= 0; i--) if (!isDecided(ids[i])) return ids[i];
  return null;
}

/** Keeps the page's query on a form action URL so a no-JS submit lands on the same filters. */
export function formActionHref(
  action: string,
  params: Record<string, string | number | undefined>
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  const rest = query.toString();
  return rest ? `?/${action}&${rest}` : `?/${action}`;
}
