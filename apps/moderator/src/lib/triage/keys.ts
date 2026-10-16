export type TriageKeyAction = 'next' | 'previous' | { decision: number };

export type TriageKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  typing: boolean;
  /** One entry per decision, in key order: digit `n + 1` picks index `n`. False makes that key a no-op. */
  decisionEnabled: readonly boolean[];
};

export const triageKeyAction = (e: TriageKeyEvent): TriageKeyAction | null => {
  if (e.typing || e.defaultPrevented || e.isComposing) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'j' || e.key === 'J') return 'next';
  if (e.key === 'k' || e.key === 'K') return 'previous';
  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    return e.decisionEnabled[index] ? { decision: index } : null;
  }
  return null;
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
