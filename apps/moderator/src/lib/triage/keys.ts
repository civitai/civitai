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
  /** The reason list is open and owns every key until it closes. */
  picking?: boolean;
};

export const triageKeyAction = (e: TriageKeyEvent): TriageKeyAction | null => {
  if (e.typing || e.defaultPrevented || e.isComposing || e.picking) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'j' || e.key === 'J') return 'previous';
  if (e.key === 'k' || e.key === 'K') return 'next';
  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    return e.decisionEnabled[index] ? { decision: index } : null;
  }
  return null;
};

export type ReasonPickerKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  /** Focus is in a field or overlay, where digits and Enter mean something else. */
  typing: boolean;
  /** Focus is on a button or link, which Enter already presses. */
  onControl: boolean;
  reasonCount: number;
  /** A reason is selected or suggested, so Enter has something to submit. */
  hasSelection: boolean;
};

/** The keys of the numbered reason list: a digit picks that reason, Enter submits the selected one,
 *  Escape closes. Escape also works from the note field, so a stray open list never traps focus. */
export const reasonPickerKeyAction = (
  e: ReasonPickerKeyEvent
): { pick: number } | 'submit' | 'close' | null => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return 'close';
  if (e.typing) return null;
  if (e.key === 'Enter') return e.hasSelection && !e.onControl ? 'submit' : null;
  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    return index < e.reasonCount ? { pick: index } : null;
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
