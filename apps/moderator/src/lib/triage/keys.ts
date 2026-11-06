export type TriageKeyAction = 'next' | 'previous' | { decision: number };

export type PlainKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  typing: boolean;
  dialogOpen?: boolean;
};

/** An unmodified key nothing else is handling: not typing, composing, or behind an open dialog. */
export const isPlainKey = (e: PlainKeyEvent) =>
  !(
    e.typing ||
    e.dialogOpen ||
    e.defaultPrevented ||
    e.isComposing ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey
  );

export type TriageKeyEvent = PlainKeyEvent & {
  /** One entry per decision, in key order: digit `n + 1` picks index `n`. False makes that key a no-op. */
  decisionEnabled: readonly boolean[];
  /** The reason list is open and owns every key until it closes. */
  picking?: boolean;
};

export const triageKeyAction = (e: TriageKeyEvent): TriageKeyAction | null => {
  if (!isPlainKey(e) || e.picking) return null;
  if (e.key === 'j' || e.key === 'J') return 'previous';
  if (e.key === 'k' || e.key === 'K') return 'next';
  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    return e.decisionEnabled[index] ? { decision: index } : null;
  }
  return null;
};

export type BulkReviewKeyAction = 'next' | 'previous' | 'toggle';

/**
 * A bulk review's keys: J/K as on every triage list, the arrows as well (it reads like a document), and
 * Enter or Space to tick or untick the row under the cursor. `onControl` is focus on a button or link
 * that is not a row's own tick box: Enter there presses it, and must not also toggle a row.
 */
export const bulkReviewKeyAction = (
  e: PlainKeyEvent & { onControl: boolean }
): BulkReviewKeyAction | null => {
  if (!isPlainKey(e)) return null;
  if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowDown') return 'next';
  if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowUp') return 'previous';
  if ((e.key === 'Enter' || e.key === ' ') && !e.onControl) return 'toggle';
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
  /** Focus is on a button or link that Enter should activate itself (see `keepsNativeEnter`), so the
   *  list leaves the key alone and stays open. */
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

/** A dialog is open. */
export const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

export const isDialogOpen = () => document.querySelector(DIALOG_SELECTOR) !== null;

export const isRevealKey = (e: PlainKeyEvent & { repeat: boolean }) =>
  (e.key === 'v' || e.key === 'V') && !e.repeat && isPlainKey(e);
